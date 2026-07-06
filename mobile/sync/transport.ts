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
 */

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

function toBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function fromBase64(b64: string): Uint8Array {
    return new Uint8Array(Buffer.from(b64, 'base64'));
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
        return {status: result.status, body: result.bodyBase64 ? fromBase64(result.bodyBase64) : new Uint8Array(0)};
    }
}
