/**
 * Test-only `SyncTransport` over Node's `http`, so the integration tests drive
 * `runSync` against `MockSyncServer` over a real socket (the production transport
 * is the native `NativeSync` bridge). A connection-level failure rejects, and an
 * unroutable address is bounded by a short timeout so the "unreachable" test does
 * not hang. Not imported by any production code.
 */

import * as http from 'node:http';
import type {SyncResponse, SyncTransport} from './transport.ts';

export class NodeSyncTransport implements SyncTransport {
    private readonly maxTimeoutMs: number;

    // The tests cap the per-call timeout so the "unreachable" case does not wait the
    // production handshake timeout; a real caller passes its own per-phase value.
    constructor(maxTimeoutMs = 2500) { this.maxTimeoutMs = maxTimeoutMs; }

    request(
        method: string, url: string, headers: {[name: string]: string},
        body: Uint8Array | undefined, timeoutMs: number
    ): Promise<SyncResponse> {
        const parsed = new URL(url);
        return new Promise<SyncResponse>((resolve, reject) => {
            const req = http.request({
                host: parsed.hostname,
                port: Number(parsed.port),
                path: parsed.pathname,
                method,
                headers: {...headers, 'Content-Length': body !== undefined ? body.length : 0}
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => resolve({status: res.statusCode ?? 0, body: new Uint8Array(Buffer.concat(chunks))}));
            });
            req.setTimeout(Math.min(timeoutMs, this.maxTimeoutMs), () => req.destroy(new Error('timeout')));
            req.on('error', reject);
            if(body !== undefined) req.write(Buffer.from(body));
            req.end();
        });
    }
}
