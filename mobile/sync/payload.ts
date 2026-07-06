/**
 * The Horizon <-> Solstice LAN log sync protocol, client side (Horizon repo
 * docs/log-sync-protocol.md). This module holds the QR session payload and the
 * shared error taxonomy. It is a TypeScript port of Luna's LunaKit `SyncPayload`
 * and `SyncClientError`, kept structurally close so the two clients stay in step.
 *
 * Pure logic with no Vue or native imports, so the whole sync core runs under
 * `node --test` as well as inside the WebView.
 */

/** Fixed identifiers from the protocol. */
export const SYNC_APP_ID = 'horizon-log-sync';
export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_KEY_LENGTH = 32;

/**
 * The session document Horizon encodes into its Device Sync QR code (and offers
 * as copyable text):
 *
 *   { "v": 1, "app": "horizon-log-sync", "addrs": ["192.168.1.5"], "port": 51234,
 *     "token": "<64 hex chars>", "key": "<base64, 32 bytes>", "account": "AccountName" }
 *
 * `addrs` lists every LAN IPv4 address of the desktop; the client tries them in
 * order. `token` is the bearer token and `key` the AES-256-GCM session key; both
 * are single-use and only ever travel inside this payload, never over the network.
 */
export interface SyncSessionPayload {
    addrs: string[];
    port: number;
    token: string;
    /** Raw AES-256-GCM session key (32 bytes, decoded from the payload's base64). */
    key: Uint8Array;
    account: string;
}

/**
 * Why a sync attempt failed. Every case carries enough detail for the friendly
 * message the UI shows (see `describeSyncError`) and for the tests.
 */
export type SyncErrorKind =
    /** The scanned/pasted text is not a usable sync code (reason is user-showable). */
    | {type: 'invalidPayload', reason: string}
    /** The QR code was issued for a different F-List account than the one signed in here. */
    | {type: 'accountMismatch', payloadAccount: string, localAccount: string}
    /** No address in the payload accepted a connection. */
    | {type: 'unreachable'}
    /** The desktop rejected the bearer token (401). */
    | {type: 'unauthorized'}
    /** The session is gone: finished, stopped, or expired (HTTP 410). */
    | {type: 'sessionEnded'}
    /** The desktop reported a protocol error code (e.g. "busy", "already-paired"). */
    | {type: 'remote', code: string}
    /** The desktop answered something undecryptable or undecodable. */
    | {type: 'badResponse', detail: string}
    /** The connection failed mid-session. */
    | {type: 'transport', detail: string};

export class SyncError extends Error {
    readonly kind: SyncErrorKind;
    constructor(kind: SyncErrorKind) {
        super(kind.type);
        this.kind = kind;
        this.name = 'SyncError';
    }
}

function invalid(reason: string): SyncError {
    return new SyncError({type: 'invalidPayload', reason});
}

const HEX = /^[0-9a-fA-F]+$/;

function decodeBase64(value: string): Uint8Array | undefined {
    try {
        const binary = typeof atob === 'function'
            ? atob(value)
            // Node has no atob in some contexts; Buffer is available in the WebView bundle too.
            : Buffer.from(value, 'base64').toString('binary');
        const bytes = new Uint8Array(binary.length);
        for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    } catch {
        return undefined;
    }
}

/**
 * Parse a scanned or pasted sync code into a validated payload, or throw a
 * `SyncError` whose `invalidPayload` reason is short and user-showable. Stray
 * whitespace from a sloppy paste is tolerated.
 */
export function parseSessionPayload(text: string): SyncSessionPayload {
    const trimmed = (text ?? '').trim();
    if(trimmed.length === 0) throw invalid('the code is empty');

    let wire: {[key: string]: unknown};
    try {
        wire = JSON.parse(trimmed);
    } catch {
        throw invalid('not a Horizon sync code');
    }
    if(wire === null || typeof wire !== 'object') throw invalid('not a Horizon sync code');

    if(wire.app !== SYNC_APP_ID) throw invalid('not a Horizon sync code');
    if(wire.v !== SYNC_PROTOCOL_VERSION) throw invalid(`unsupported sync version (${String(wire.v)})`);

    const addrs = Array.isArray(wire.addrs)
        ? wire.addrs.filter((a): a is string => typeof a === 'string' && a.length > 0)
        : [];
    if(addrs.length === 0) throw invalid('the code lists no addresses');

    const port = wire.port;
    if(typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
        throw invalid('the code lists no valid port');

    const token = wire.token;
    if(typeof token !== 'string' || token.length === 0 || !HEX.test(token))
        throw invalid('the code is missing its token');

    if(typeof wire.key !== 'string') throw invalid('the code\'s key is malformed');
    const key = decodeBase64(wire.key);
    if(key === undefined || key.length !== SYNC_KEY_LENGTH) throw invalid('the code\'s key is malformed');

    const account = wire.account;
    if(typeof account !== 'string' || account.length === 0) throw invalid('the code is missing its account');

    return {addrs, port, token, key, account};
}
