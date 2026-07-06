// Ensures window.NativeSync (the LAN log sync HTTP bridge used by mobile/sync/transport.ts) exists.
//
// On iOS it is already provided by the injected bridge.js (a WKScriptMessageHandlerWithReply whose
// postMessage returns a Promise). On Android the raw Kotlin interface is window.SyncBridge, whose
// request(...) is fire-and-forget - it must not block the JS thread for the length of a network
// call - so this installs the Promise-returning wrapper that settles when Kotlin calls back into
// window.__nativeSyncResult(id, resultJson, error). Mirrors how NativeSocketConnection.ts bridges the
// async native socket. Idempotent; safe to call more than once.

interface NativeSyncResult {
    status: number;
    bodyBase64: string | null;
}

interface AndroidSyncBridge {
    request(
        id: string, method: string, url: string, headersJson: string,
        bodyBase64: string | null, timeoutMs: number
    ): void;
}

export function ensureNativeSync(): void {
    const w = window as any; //tslint:disable-line:no-any
    if(w.NativeSync !== undefined) return; // iOS: bridge.js already provided it
    const bridge = w.SyncBridge as AndroidSyncBridge | undefined;
    if(bridge === undefined) return; // no native bridge available (not on a device)

    const pending = new Map<string, {resolve: (r: NativeSyncResult) => void, reject: (e: Error) => void}>();
    let counter = 0;

    w.__nativeSyncResult = (id: string, resultJson: string | null, error: string | null): void => {
        const entry = pending.get(id);
        if(entry === undefined) return;
        pending.delete(id);
        if(error !== null && error !== undefined) entry.reject(new Error(error));
        else entry.resolve(JSON.parse(resultJson!) as NativeSyncResult);
    };

    w.NativeSync = {
        request(
            method: string, url: string, headers: {[name: string]: string},
            bodyBase64: string | null, timeoutMs: number
        ): Promise<NativeSyncResult> {
            return new Promise<NativeSyncResult>((resolve, reject) => {
                const id = String(++counter);
                pending.set(id, {resolve, reject});
                bridge.request(id, method, url, JSON.stringify(headers), bodyBase64, timeoutMs);
            });
        }
    };
}
