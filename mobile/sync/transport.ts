/**
 * The HTTP transport the sync client drives. Kept behind an interface so the
 * client stays pure: the app injects `NativeSyncTransport` (the native
 * URLSession / HttpURLConnection bridge, which is the reliable way to reach a
 * plain-HTTP LAN address from inside the WebView on both platforms), and the
 * tests inject a plain Node transport that hits a mock server over a real socket.
 *
 * A request either reaches the server (resolves with a status and the raw,
 * still-encrypted body) or fails to connect (rejects). The client treats a
 * rejection as "try the next address" and a resolution as final, so connection
 * failures must reject rather than resolve with a synthetic status.
 *
 * The bridge carries bodies as base64, so every batch is converted whole in both
 * directions. That goes through `bytes.ts` for the engine's own codecs rather than
 * the `buffer` polyfill's JavaScript loops.
 */

import {fromBase64, toBase64} from './bytes.ts';

declare global {
    /**
     * Native HTTP bridge for the LAN sync session (iOS `NativeSync.swift`
     * URLSession, Android `Sync.kt` HttpURLConnection). One plain-HTTP request;
     * `bodyBase64` is the base64 request body (or null), and it resolves to the
     * response status plus the base64 response body, or rejects if the address
     * could not be reached.
     */
    const NativeSync: {
        request(
            method: string, url: string, headers: {[name: string]: string},
            bodyBase64: string | null, timeoutMs: number
        ): Promise<{status: number, bodyBase64: string | null}>;
    };
}

export interface SyncResponse {
    status: number;
    body: Uint8Array;
}

export interface SyncTransport {
    /**
     * One request. `timeoutMs` is the idle timeout: short for the handshake (so
     * failover past an unreachable address is quick) and long for transfers.
     */
    request(
        method: string, url: string, headers: {[name: string]: string},
        body: Uint8Array | undefined, timeoutMs: number
    ): Promise<SyncResponse>;
}

/**
 * `SyncTransport` over the `NativeSync` bridge. The bridge does one plain-HTTP
 * request and returns `{status, bodyBase64}`; a connection-level failure rejects
 * the promise (so the client can fail over to the next address).
 */
export class NativeSyncTransport implements SyncTransport {
    async request(
        method: string, url: string, headers: {[name: string]: string},
        body: Uint8Array | undefined, timeoutMs: number
    ): Promise<SyncResponse> {
        const result = await NativeSync.request(
            method, url, headers, body !== undefined ? toBase64(body) : null, timeoutMs);
        // `fromBase64` already returns a `Buffer`, which is a `Uint8Array`; wrapping it
        // again would copy the whole body a second time.
        return {status: result.status, body: result.bodyBase64 ? fromBase64(result.bodyBase64) : new Uint8Array(0)};
    }
}
