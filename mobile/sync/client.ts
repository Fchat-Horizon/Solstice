/**
 * The mobile side of the Horizon log sync protocol (Horizon repo
 * docs/log-sync-protocol.md): Horizon runs a single-use LAN HTTP server, and
 * this client drives the whole exchange:
 *
 *   handshake -> GET /v1/logs?cursor=... (merge each batch) -> POST /v1/logs ... -> POST /v1/finish
 *
 * Both transfers run one bounded batch at a time so neither side ever holds the
 * whole log set in memory (Horizon repo issue #958). Downloads follow a cursor
 * until a batch reports `done`; uploads simply post more than once, which needs no
 * signal at all. All downloads finish before the first upload: a cursor is a byte
 * position in Horizon's log files, so merging an upload invalidates it.
 *
 * All security comes from the QR payload's two secrets: the bearer token
 * authenticates every request, and every non-empty body is AES-256-GCM encrypted
 * with the session key. Transport and storage are injected, so the whole flow is
 * exercised by `node --test` against a mock server and an in-memory store.
 * TypeScript port of Luna's `LogSyncClient`.
 */

import {
    ArchiveTooLargeError, buildSyncBatch, openSyncBatch, samePosition, SyncMerge, SYNC_SEND_START
} from './archive.ts';
import type {
    MergeStats, OpenedSyncBatch, SyncSendBatch, SyncSendOptions, SyncSendPosition
} from './archive.ts';
import {decryptBody, encryptBody} from './crypto.ts';
import {SYNC_CURSOR_START, SYNC_MAX_BATCHES, SyncError} from './payload.ts';
import type {SyncBatchInfo, SyncErrorKind, SyncSessionPayload} from './payload.ts';
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
    /**
     * Progress. `batch` is the zero-based index within the current transfer, so a
     * long download reads as more than one motionless stage. Only fired when the
     * stage or the batch actually changes.
     */
    onStage?: (stage: SyncStage, batch?: number) => void;
    /** Injected so tests do not sit through the `busy` backoff. */
    sleep?: (ms: number) => Promise<void>;
    /**
     * Overrides the outgoing batch budget. The counterpart of Horizon's
     * `HORIZON_SYNC_BATCH_BYTES`: a small budget turns a few megabytes of logs into
     * dozens of batches, so the loop is exercised without a huge log set.
     */
    sendOptions?: SyncSendOptions;
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

// Horizon answers `409 busy` while another transfer is still running, and clears that
// flag only once the previous response has fully flushed. A batch loop fires requests
// back to back, so the window is narrow but real: wait it out rather than failing the
// whole sync. Four tries at 0.5s, 1s, 2s, 4s.
const BUSY_RETRIES = 4;
const BUSY_BACKOFF_MS = 500;

function fail(kind: SyncErrorKind): SyncError {
    return new SyncError(kind);
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Normalize a peer's merge summary, which may omit fields an older build never sent. */
function statsFrom(wire: unknown): MergeStats {
    const w = (wire ?? {}) as {[field: string]: unknown};
    return {
        conversationsCreated: count(w.conversationsCreated),
        conversationsUpdated: count(w.conversationsUpdated),
        messagesAdded: count(w.messagesAdded),
        charactersTouched: count(w.charactersTouched),
        conversationsSkipped: count(w.conversationsSkipped)
    };
}

function zeroStats(): MergeStats {
    return {
        conversationsCreated: 0, conversationsUpdated: 0, messagesAdded: 0,
        charactersTouched: 0, conversationsSkipped: 0
    };
}

function addStats(total: MergeStats, stats: MergeStats): void {
    total.conversationsCreated += stats.conversationsCreated;
    total.conversationsUpdated += stats.conversationsUpdated;
    total.messagesAdded += stats.messagesAdded;
    total.charactersTouched += stats.charactersTouched;
    total.conversationsSkipped += stats.conversationsSkipped;
}

class SyncSession {
    private readonly options: SyncRunOptions;
    private lastStage: string = '';

    constructor(options: SyncRunOptions) { this.options = options; }

    private get payload(): SyncSessionPayload { return this.options.payload; }

    private emit(stage: SyncStage, batch?: number): void {
        const token = `${stage}:${batch ?? ''}`;
        if(token === this.lastStage) return;
        this.lastStage = token;
        this.options.onStage?.(stage, batch);
    }

    private sleep(ms: number): Promise<void> {
        const injected = this.options.sleep;
        return injected !== undefined ? injected(ms) : new Promise((resolve) => setTimeout(resolve, ms));
    }

    async run(): Promise<SyncResult> {
        const {payload, localAccount, store} = this.options;
        if(payload.account.trim().toLowerCase() !== localAccount.trim().toLowerCase())
            throw fail({type: 'accountMismatch', payloadAccount: payload.account, localAccount});

        this.emit('connecting');
        const {base, handshake} = await this.connect();

        // An interrupted run can leave send snapshots behind, which would make this
        // upload ship stale content. Start from a clean slate, and leave one.
        await store.clearSendSnapshots();
        try {
            const {received, peerBatches} = await this.download(base);
            const sent = await this.upload(base, peerBatches);

            this.emit('finishing');
            await this.finish(base);

            return {remoteDeviceName: handshake.deviceName, received, sent};
        } finally {
            try {
                await store.clearSendSnapshots();
            } catch {
                // Cleanup must never mask the real outcome; a leftover snapshot is
                // stale, not dangerous, and the next run clears it.
            }
        }
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

    /**
     * Follow the download cursor, merging each batch as it lands, until a batch
     * reports `done`. `peerBatches` says whether the desktop answered with batch
     * envelopes at all: one that predates batching ignores the query parameter and
     * sends the whole log set in a single archive, which is the signal to stop.
     */
    private async download(base: string): Promise<{received: MergeStats, peerBatches: boolean}> {
        const merge = new SyncMerge(this.options.store);
        let cursor: string | undefined = SYNC_CURSOR_START;
        const seen = new Set<string>([SYNC_CURSOR_START]);
        let peerBatches = false;
        // The next batch is asked for before the current one is merged, so Horizon
        // reads its logs and the archive crosses the wire while this device is busy
        // merging. Still one request outstanding at a time, so Horizon's single
        // transfer lock and the busy retry are unaffected; the cost is holding two
        // batches rather than one.
        let inFlight: Promise<Uint8Array> | undefined = undefined;

        try {
            for(let index = 0; index < SYNC_MAX_BATCHES; index++) {
                const requested = cursor;
                this.emit('downloading', index);
                const pending = inFlight ?? this.withBusyRetry(() => this.getLogs(base, requested));
                inFlight = undefined;
                const data = await pending;

                let opened: OpenedSyncBatch;
                try {
                    opened = openSyncBatch(data);
                } catch(error) {
                    throw this.mergeFailure(error);
                }
                const batch = opened.info;

                // Where the transfer goes next comes from the envelope alone, so the
                // request for it can be issued before the merge rather than after it.
                let following: string | undefined = undefined;
                if(batch === undefined) cursor = undefined;
                else {
                    peerBatches = true;
                    if(batch.done || batch.cursor === undefined) cursor = undefined;
                    // A cursor we have already requested means the desktop is handing us
                    // the same batch forever; stop instead of looping until the session
                    // expires.
                    else if(seen.has(batch.cursor))
                        throw fail({type: 'badResponse', detail: 'the log download repeated a batch'});
                    else {
                        seen.add(batch.cursor);
                        cursor = batch.cursor;
                        following = batch.cursor;
                    }
                }
                if(following !== undefined) {
                    const next = following;
                    inFlight = this.withBusyRetry(() => this.getLogs(base, next));
                }

                this.emit('merging', index);
                try {
                    await merge.merge(opened);
                } catch(error) {
                    throw this.mergeFailure(error);
                }

                if(cursor === undefined) break;
            }
            if(cursor !== undefined) throw fail({type: 'badResponse', detail: 'the log download did not finish'});
        } catch(error) {
            // Whatever is still on the wire is moot now. Adopt its rejection so it
            // cannot resurface as an unhandled one after this failure is reported.
            if(inFlight !== undefined) inFlight.catch(() => undefined);
            throw error;
        }

        let received: MergeStats;
        try {
            received = await merge.finish();
        } catch(error) {
            throw this.mergeFailure(error);
        }
        return {received, peerBatches};
    }

    /**
     * Upload the local log set one bounded batch at a time. Horizon needs no signal
     * for this: it merges each POST and accumulates the totals across them.
     */
    private async upload(base: string, peerBatches: boolean): Promise<MergeStats> {
        const {store} = this.options;
        let position: SyncSendPosition = SYNC_SEND_START;
        const total = zeroStats();
        // Shared across every batch: recovering display names means reading each
        // conversation's `.idx`, and the character a batch resumes inside would
        // otherwise be re-read from scratch for each one.
        const sendOptions: SyncSendOptions = {...this.options.sendOptions, indexCache: new Map()};

        // The batch after the one being posted is built while that post is in flight,
        // so reading and zipping this device's logs overlaps the wire and Horizon's
        // merge. Only one build and one request are ever outstanding, so the shared
        // `indexCache` is never touched concurrently; the cost is holding two archives.
        let upcoming: Promise<SyncSendBatch> | undefined = this.buildBatch(store, position, sendOptions);

        try {
            for(let index = 0; index < SYNC_MAX_BATCHES; index++) {
                this.emit('uploading', index);
                const batch = await upcoming!;
                upcoming = undefined;

                const next = batch.next;
                const stuck = next !== undefined && samePosition(next, position);
                if(next !== undefined && !stuck) upcoming = this.buildBatch(store, next, sendOptions);

                const stats = await this.withBusyRetry(() => this.postLogs(base, batch.zip));
                addStats(total, stats);

                // A batching Horizon reports the running session total, so its last answer
                // is the whole story. One that predates batching reports each call on its
                // own, so those have to be summed; that can double count a conversation
                // spanning batches, which needs an old desktop and a conversation over the
                // batch budget at once.
                if(next === undefined) return peerBatches ? stats : total;
                if(stuck) throw fail({type: 'badResponse', detail: 'the upload stopped making progress'});
                position = next;
            }
            throw fail({type: 'badResponse', detail: 'the upload did not finish'});
        } catch(error) {
            if(upcoming !== undefined) upcoming.catch(() => undefined);
            throw error;
        }
    }

    /** One outgoing batch, with the archive size cap mapped onto the client's errors. */
    private async buildBatch(
        store: SyncStorage, position: SyncSendPosition, options: SyncSendOptions
    ): Promise<SyncSendBatch> {
        try {
            return await buildSyncBatch(store, position, options);
        } catch(error) {
            if(error instanceof ArchiveTooLargeError)
                throw fail({type: 'archiveTooLarge', direction: error.direction});
            throw error;
        }
    }

    /** Retry a transfer while Horizon reports it is busy with another one. */
    private async withBusyRetry<T>(attempt: () => Promise<T>): Promise<T> {
        let delay = BUSY_BACKOFF_MS;
        for(let tries = 0; ; tries++) {
            try {
                return await attempt();
            } catch(error) {
                const busy = error instanceof SyncError && error.kind.type === 'remote' && error.kind.code === 'busy';
                if(!busy || tries >= BUSY_RETRIES) throw error;
                await this.sleep(delay);
                delay *= 2;
            }
        }
    }

    private mergeFailure(error: unknown): SyncError {
        if(error instanceof ArchiveTooLargeError)
            return fail({type: 'archiveTooLarge', direction: error.direction});
        return fail({type: 'badResponse', detail: 'the received log archive is not a valid zip'});
    }

    private async getLogs(base: string, cursor: string): Promise<Uint8Array> {
        // Passing the parameter at all is the capability signal for batching.
        const path = `${LOGS_PATH}?cursor=${encodeURIComponent(cursor)}`;
        const {status, data} = await this.send(base, 'GET', path, TRANSFER_TIMEOUT_MS);
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
        return statsFrom(await this.decode<unknown>(data));
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
                    return 'Horizon is still busy with another transfer. Solstice waited and tried again '
                        + 'without success. Let it finish, then start a new Device Sync.';
                case 'already-paired':
                    return 'That session is already paired with another device. Start a new Device Sync in Horizon.';
                case 'not-paired':
                    return 'The session dropped before it finished. Start a new Device Sync in Horizon '
                        + 'and scan the new code.';
                case 'archive-too-large':
                    return 'The logs are too large to sync in one transfer. Retrying won\'t help. '
                        + 'Clear out some old logs on one of the devices, then start a new Device Sync.';
                case 'cursor-stale':
                case 'unknown-cursor':
                    return 'Solstice lost its place in Horizon\'s logs part way through. '
                        + 'Start a new Device Sync in Horizon and scan the new code.';
                case 'too-many-batches':
                    return 'There are too many logs to move in one session. Clear out some old logs on '
                        + 'one of the devices, then start a new Device Sync.';
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
