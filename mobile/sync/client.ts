/**
 * The mobile side of the Horizon log sync protocol (Horizon repo
 * docs/log-sync-protocol.md): Horizon runs a single-use LAN HTTP server, and
 * this client drives the whole exchange:
 *
 *   handshake -> GET /v1/logs (merge into the local store) -> POST /v1/logs -> POST /v1/finish
 *
 * All security comes from the QR payload's two secrets: the bearer token
 * authenticates every request, and every non-empty body is AES-256-GCM encrypted
 * with the session key. Transport and storage are injected, so the whole flow is
 * exercised by `node --test` against a mock server and an in-memory store.
 * TypeScript port of Luna's `LogSyncClient`.
 */

import {ArchiveTooLargeError, buildSyncArchive, mergeLogs} from './archive.ts';
import type {MergeStats} from './archive.ts';
import {decryptBody, encryptBody} from './crypto.ts';
import {SyncError} from './payload.ts';
import type {SyncErrorKind, SyncSessionPayload} from './payload.ts';
import type {SyncStorage} from './storage.ts';
import type {SyncResponse, SyncTransport} from './transport.ts';

/** The phases of a sync run, in order, for driving progress UI. */
export type SyncStage = 'connecting' | 'downloading' | 'merging' | 'uploading' | 'finishing';

export const SYNC_STAGES: ReadonlyArray<SyncStage> =
    ['connecting', 'downloading', 'merging', 'uploading', 'finishing'];

/** What this device reports about itself in the handshake. */
export interface SyncDeviceInfo {
    deviceName: string;
    platform: string;
    appVersion: string;
}

/** Outcome of a completed sync. */
export interface SyncResult {
    /** The desktop's hostname, from the handshake response. */
    remoteDeviceName: string;
    /** What this device merged from the desktop's logs. */
    received: MergeStats;
    /** What the desktop reports it merged from this device's upload. */
    sent: MergeStats;
}

export interface SyncRunOptions {
    payload: SyncSessionPayload;
    transport: SyncTransport;
    store: SyncStorage;
    device: SyncDeviceInfo;
    /** The account signed in on this device; checked against the payload before any request. */
    localAccount: string;
    onStage?: (stage: SyncStage) => void;
}

interface HandshakeResponse {
    ok: boolean;
    deviceName: string;
    account: string;
    protocolVersion: number;
}

const HANDSHAKE_PATH = '/v1/handshake';
const LOGS_PATH = '/v1/logs';
const FINISH_PATH = '/v1/finish';

// Idle timeouts. The handshake is short so unreachable addresses fail over quickly; transfers get
// room for a big archive over slow wifi (the timeout is idle, so a progressing transfer never trips it).
const HANDSHAKE_TIMEOUT_MS = 6000;
const TRANSFER_TIMEOUT_MS = 300000;
const FINISH_TIMEOUT_MS = 15000;

function fail(kind: SyncErrorKind): SyncError {
    return new SyncError(kind);
}

class SyncSession {
    private readonly options: SyncRunOptions;

    constructor(options: SyncRunOptions) { this.options = options; }

    private get payload(): SyncSessionPayload { return this.options.payload; }

    async run(): Promise<SyncResult> {
        const {payload, localAccount, store, onStage} = this.options;
        if(payload.account.trim().toLowerCase() !== localAccount.trim().toLowerCase())
            throw fail({type: 'accountMismatch', payloadAccount: payload.account, localAccount});

        onStage?.('connecting');
        const {base, handshake} = await this.connect();

        onStage?.('downloading');
        const downloaded = await this.getLogs(base);
        // Snapshot the upload before merging, so the desktop's own messages are not echoed back to
        // it (its merge would discard them, but the upload would needlessly double in size).
        let upload: Buffer;
        try {
            upload = await buildSyncArchive(store);
        } catch(error) {
            if(error instanceof ArchiveTooLargeError)
                throw fail({type: 'archiveTooLarge', direction: error.direction});
            throw error;
        }

        onStage?.('merging');
        let received: MergeStats;
        try {
            received = await mergeLogs(downloaded, store);
        } catch(error) {
            if(error instanceof ArchiveTooLargeError)
                throw fail({type: 'archiveTooLarge', direction: error.direction});
            throw fail({type: 'badResponse', detail: 'the received log archive is not a valid zip'});
        }

        onStage?.('uploading');
        const sent = await this.postLogs(base, upload);

        onStage?.('finishing');
        await this.finish(base);

        return {remoteDeviceName: handshake.deviceName, received, sent};
    }

    /**
     * Try each payload address in order until one completes the handshake.
     * Connection-level failures move on to the next address; a real HTTP answer
     * (even an error) means the session server was reached, so its verdict is final.
     */
    private async connect(): Promise<{base: string, handshake: HandshakeResponse}> {
        const {payload, device} = this.options;
        const body = new TextEncoder().encode(JSON.stringify({
            account: payload.account, deviceName: device.deviceName,
            platform: device.platform, appVersion: device.appVersion
        }));
        for(const addr of payload.addrs) {
            const base = `http://${addr}:${payload.port}`;
            try {
                const {status, data} = await this.send(base, 'POST', HANDSHAKE_PATH, HANDSHAKE_TIMEOUT_MS, body);
                if(status !== 200) throw await this.failure(status, data);
                const handshake = await this.decode<HandshakeResponse>(data);
                if(!handshake.ok) throw fail({type: 'badResponse', detail: 'handshake not ok'});
                return {base, handshake};
            } catch(error) {
                // A connection-level failure: try the next address. Any HTTP-level verdict is final.
                if(error instanceof SyncError && error.kind.type === 'transport') continue;
                throw error;
            }
        }
        throw fail({type: 'unreachable'});
    }

    private async getLogs(base: string): Promise<Uint8Array> {
        const {status, data} = await this.send(base, 'GET', LOGS_PATH, TRANSFER_TIMEOUT_MS);
        if(status !== 200) throw await this.failure(status, data);
        try {
            return await decryptBody(this.payload.key, data);
        } catch {
            throw fail({type: 'badResponse', detail: 'could not decrypt the log archive'});
        }
    }

    private async postLogs(base: string, zip: Uint8Array): Promise<MergeStats> {
        const {status, data} = await this.send(base, 'POST', LOGS_PATH, TRANSFER_TIMEOUT_MS, zip);
        if(status !== 200) throw await this.failure(status, data);
        return this.decode<MergeStats>(data);
    }

    private async finish(base: string): Promise<void> {
        const {status, data} =
            await this.send(base, 'POST', FINISH_PATH, FINISH_TIMEOUT_MS, new TextEncoder().encode('{}'));
        if(status !== 200) throw await this.failure(status, data);
    }

    /** One authorized request. `plainBody` is encrypted before sending. */
    private async send(base: string, method: string, path: string, timeoutMs: number, plainBody?: Uint8Array
    ): Promise<{status: number, data: Uint8Array}> {
        const headers = {
            'Authorization': `Bearer ${this.payload.token}`,
            'Content-Type': 'application/octet-stream'
        };
        const body = plainBody !== undefined ? await encryptBody(this.payload.key, plainBody) : undefined;
        let response: SyncResponse;
        try {
            response = await this.options.transport.request(method, base + path, headers, body, timeoutMs);
        } catch(error) {
            // Kept as a transport error so connect() can fail over between addresses.
            throw fail({type: 'transport', detail: error instanceof Error ? error.message : String(error)});
        }
        return {status: response.status, data: response.body};
    }

    /** Decrypt and decode an encrypted JSON response body. */
    private async decode<T>(data: Uint8Array): Promise<T> {
        try {
            return JSON.parse(new TextDecoder().decode(await decryptBody(this.payload.key, data))) as T;
        } catch {
            throw fail({type: 'badResponse', detail: 'undecodable response'});
        }
    }

    /**
     * Map a non-200 answer to a client error. Errors to authorized requests are
     * encrypted `{"error": code}` JSON; a 401 has an empty body (no session proof,
     * no encrypted channel).
     */
    private async failure(status: number, data: Uint8Array): Promise<SyncError> {
        if(status === 401) return fail({type: 'unauthorized'});
        let code: string | undefined;
        try {
            const parsed = JSON.parse(new TextDecoder().decode(await decryptBody(this.payload.key, data)));
            if(parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'string')
                code = parsed.error;
        } catch {
            // Undecryptable/opaque error body; fall through to the generic mapping below.
        }
        if(status === 410 || code === 'session-ended') return fail({type: 'sessionEnded'});
        if(code !== undefined) return fail({type: 'remote', code});
        return fail({type: 'badResponse', detail: `HTTP ${status}`});
    }
}

/** Run the full sync described by `options`, returning the two-way merge summary. */
export function runSync(options: SyncRunOptions): Promise<SyncResult> {
    return new SyncSession(options).run();
}

/** Map a client error to a message a phone user can act on (port of Luna's `SyncModel.message`). */
export function describeSyncError(kind: SyncErrorKind): string {
    switch(kind.type) {
        case 'invalidPayload':
            return `That doesn't look like a Horizon sync code (${kind.reason}).`;
        case 'accountMismatch':
            return `That code is for the account "${kind.payloadAccount}", but you're signed in as `
                + `"${kind.localAccount}". Sign into the same account on both devices, then try again.`;
        case 'unreachable':
            return 'Couldn\'t reach Horizon. Check that both devices are on the same Wi-Fi network '
                + 'and Horizon\'s Device Sync screen is still open, then try again.';
        case 'unauthorized':
            return 'Horizon rejected the connection. The code may be mistyped or already used. '
                + 'Show a fresh QR code in Horizon and scan it again.';
        case 'sessionEnded':
            return 'That sync session has ended. Start a new Device Sync in Horizon and scan the new QR code.';
        case 'remote':
            switch(kind.code) {
                case 'busy':
                    return 'Horizon is already running a sync. Wait for it to finish, then try again.';
                case 'already-paired':
                    return 'That session is already paired with another device. Start a new Device Sync in Horizon.';
                case 'not-paired':
                    return 'The session dropped before it finished. Start a new Device Sync in Horizon '
                        + 'and scan the new code.';
                case 'archive-too-large':
                    return 'The logs are too large to sync in one transfer. Retrying won\'t help. '
                        + 'Clear out some old logs on one of the devices, then start a new Device Sync.';
                default:
                    return `Horizon reported an error (${kind.code}). Start a new Device Sync and try again.`;
            }
        case 'archiveTooLarge':
            return kind.direction === 'outgoing'
                ? 'This device has too many logs to sync in one transfer (over the 512 MB limit). '
                    + 'Retrying won\'t help. Clear out some old logs on this device, then try again.'
                : 'The other device sent more log data than can be merged in one transfer '
                    + '(over the 2 GB limit). Retrying won\'t help. Sync from a device with fewer logs, '
                    + 'or clear out some old logs there first.';
        case 'badResponse':
            return 'Got an unexpected response from Horizon. Start a new Device Sync and try again.';
        case 'transport':
            return `The connection to Horizon failed (${kind.detail}). Try again.`;
    }
}
