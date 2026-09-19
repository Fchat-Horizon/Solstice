/**
 * Test-only in-process HTTP server implementing the spec's endpoints
 * (docs/log-sync-protocol.md), so `runSync` can be driven end to end over a real
 * socket. Mirrors the relevant behaviour of Horizon's
 * `electron/services/sync/server.ts` and Luna's `MockSyncServer`: bearer-token
 * auth, AES-256-GCM body framing, the handshake account check, the transfer
 * endpoints, the cursor-keyed batch list, and the state/expiry guards. Not
 * production code.
 */

import AdmZip from 'adm-zip';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import {decryptBody, encryptBody} from './crypto.ts';
import type {MergeStats} from './archive.ts';
import {SYNC_BATCH_ENTRY, SYNC_CURSOR_START} from './payload.ts';
import type {SyncBatchInfo} from './payload.ts';

export interface MockServerOptions {
    account: string;
    token?: string;
    key?: Uint8Array;
    logsToServe?: Uint8Array;
    mergeStats?: MergeStats;
}

/** One request as the server saw it, so a test can assert on the cursor loop. */
export interface MockRequest {
    method: string;
    path: string;
    cursor: string | null;
}

const ZERO_STATS: MergeStats = {
    conversationsCreated: 0, conversationsUpdated: 0, messagesAdded: 0,
    charactersTouched: 0, conversationsSkipped: 0
};

/** Copy `archive` with a root `sync-batch.json`, which Horizon writes last. */
export function withBatchEnvelope(archive: Uint8Array, batch: SyncBatchInfo): Uint8Array {
    const zip = new AdmZip(Buffer.from(archive));
    zip.addFile(SYNC_BATCH_ENTRY, Buffer.from(JSON.stringify(batch), 'utf8'));
    return new Uint8Array(zip.toBuffer());
}

export class MockSyncServer {
    readonly token: string;
    readonly key: Uint8Array;
    readonly account: string;
    logsToServe: Uint8Array;
    mergeStatsToReturn: MergeStats;
    receivedUpload: Uint8Array | undefined = undefined;
    /** Every decrypted `POST /v1/logs` body, in order. */
    readonly uploads: Uint8Array[] = [];
    /** Every authorized request, in order. */
    readonly requests: MockRequest[] = [];
    finished = false;
    forceSessionEnded = false;
    /** When set, answer the matching /v1/logs route with 413 archive-too-large. */
    forceArchiveTooLarge: 'get' | 'post' | undefined = undefined;
    /** Answer the next N transfer requests with 409 busy before serving them. */
    busyResponses = 0;
    /**
     * Per-batch merge summaries for the upload direction, consumed in order. A
     * batching Horizon reports the running session total, so a test modelling one
     * supplies running totals here; leaving it empty falls back to `mergeStatsToReturn`.
     */
    uploadStats: MergeStats[] = [];

    private batches: Uint8Array[] | undefined = undefined;
    /** Overrides the envelope served for a batch, for testing malformed cursor chains. */
    private envelopeFor: ((index: number, count: number, minted: string) => SyncBatchInfo) | undefined = undefined;
    private readonly cursors = new Map<string, number>();
    private minted = 0;

    private paired = false;
    private readonly server: http.Server;
    port = 0;

    private constructor(options: MockServerOptions) {
        this.account = options.account;
        this.token = options.token ?? 'ab'.repeat(32);
        this.key = options.key ?? new Uint8Array(Array.from({length: 32}, (_, i) => i));
        // Default to a valid (empty) zip, as real Horizon always sends at least a manifest.
        this.logsToServe = options.logsToServe ?? new Uint8Array(new AdmZip().toBuffer());
        this.mergeStatsToReturn = options.mergeStats ?? {...ZERO_STATS};
        this.server = http.createServer((req, res) => void this.handle(req, res));
    }

    static start(options: MockServerOptions): Promise<MockSyncServer> {
        const instance = new MockSyncServer(options);
        return new Promise((resolve) => {
            instance.server.listen(0, '127.0.0.1', () => {
                instance.port = (instance.server.address() as AddressInfo).port;
                resolve(instance);
            });
        });
    }

    stop(): void { this.server.close(); }

    /**
     * Serve `archives` as a cursor chain, minting the tokens as Horizon does. A
     * request with no `cursor` parameter still gets `logsToServe` whole, which is
     * how a desktop that predates batching answers.
     */
    serveBatches(
        archives: Uint8Array[],
        envelopeFor?: (index: number, count: number, minted: string) => SyncBatchInfo
    ): void {
        this.batches = archives;
        this.envelopeFor = envelopeFor;
        this.cursors.clear();
        this.minted = 0;
    }

    /** Cursors this server handed out, in order, for asserting on a replayed stream. */
    issuedCursors(): string[] { return Array.from(this.cursors.keys()); }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const body = await readBody(req);
        if(this.forceSessionEnded) return this.respond(res, 410, await this.encJson({error: 'session-ended'}));

        const auth = req.headers['authorization'];
        const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
        if(presented !== this.token) { res.writeHead(401); res.end(); return; }

        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = `${req.method} ${url.pathname}`;
        this.requests.push({
            method: req.method ?? '', path: url.pathname, cursor: url.searchParams.get('cursor')
        });

        if(route === 'POST /v1/handshake') return this.handshake(res, body);
        if(route === 'GET /v1/logs') {
            if(!this.paired) return this.respond(res, 409, await this.encJson({error: 'not-paired'}));
            if(this.busyResponses > 0) {
                this.busyResponses--;
                return this.respond(res, 409, await this.encJson({error: 'busy'}));
            }
            if(this.forceArchiveTooLarge === 'get')
                return this.respond(res, 413, await this.encJson({error: 'archive-too-large'}));
            return this.serveLogs(res, url.searchParams.get('cursor'));
        }
        if(route === 'POST /v1/logs') {
            if(!this.paired) return this.respond(res, 409, await this.encJson({error: 'not-paired'}));
            if(this.busyResponses > 0) {
                this.busyResponses--;
                return this.respond(res, 409, await this.encJson({error: 'busy'}));
            }
            if(this.forceArchiveTooLarge === 'post')
                return this.respond(res, 413, await this.encJson({error: 'archive-too-large'}));
            try {
                this.receivedUpload = await decryptBody(this.key, body);
                this.uploads.push(this.receivedUpload);
            } catch { /* leave undefined */ }
            const stats = this.uploadStats.length > 0
                ? this.uploadStats[Math.min(this.uploads.length - 1, this.uploadStats.length - 1)]
                : this.mergeStatsToReturn;
            return this.respond(res, 200, await this.encJson({ok: true, ...stats}));
        }
        if(route === 'POST /v1/finish') {
            if(!this.paired) return this.respond(res, 409, await this.encJson({error: 'not-paired'}));
            this.finished = true;
            return this.respond(res, 200, await this.encJson({ok: true}));
        }
        return this.respond(res, 404, await this.encJson({error: 'not-found'}));
    }

    private async serveLogs(res: http.ServerResponse, cursor: string | null): Promise<void> {
        // No batch list configured, or no cursor asked for: the whole archive, with no
        // envelope. That is exactly what a Horizon built before batching answers.
        if(this.batches === undefined || cursor === null)
            return this.respond(res, 200, await encryptBody(this.key, this.logsToServe));

        let index: number;
        if(cursor === SYNC_CURSOR_START) index = 0;
        else {
            const known = this.cursors.get(cursor);
            if(known === undefined) return this.respond(res, 409, await this.encJson({error: 'unknown-cursor'}));
            index = known;
        }
        if(index >= this.batches.length)
            return this.respond(res, 409, await this.encJson({error: 'unknown-cursor'}));

        const count = this.batches.length;
        const done = index === count - 1;
        const mint = `cursor-${++this.minted}`;
        const batch: SyncBatchInfo = this.envelopeFor !== undefined
            ? this.envelopeFor(index, count, mint)
            : done ? {index, done: true} : {index, done: false, cursor: mint};
        if(batch.cursor !== undefined && !this.cursors.has(batch.cursor))
            this.cursors.set(batch.cursor, index + 1);
        const body = withBatchEnvelope(this.batches[index], batch);
        return this.respond(res, 200, await encryptBody(this.key, body));
    }

    private async handshake(res: http.ServerResponse, body: Uint8Array): Promise<void> {
        if(this.paired) return this.respond(res, 409, await this.encJson({error: 'already-paired'}));
        let account: unknown;
        try {
            account = JSON.parse(new TextDecoder().decode(await decryptBody(this.key, body))).account;
        } catch {
            return this.respond(res, 400, await this.encJson({error: 'bad-handshake'}));
        }
        if(typeof account !== 'string' || account.toLowerCase() !== this.account.toLowerCase())
            return this.respond(res, 403, await this.encJson({error: 'account-mismatch'}));
        this.paired = true;
        return this.respond(res, 200, await this.encJson({
            ok: true, deviceName: 'mock-desktop', account: this.account, protocolVersion: 1
        }));
    }

    private encJson(body: object): Promise<Uint8Array> {
        return encryptBody(this.key, new TextEncoder().encode(JSON.stringify(body)));
    }

    private respond(res: http.ServerResponse, status: number, body: Uint8Array): void {
        res.writeHead(status, {'Content-Type': 'application/octet-stream', 'Content-Length': body.length});
        res.end(Buffer.from(body));
    }
}

function readBody(req: http.IncomingMessage): Promise<Uint8Array> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
        req.on('error', () => resolve(new Uint8Array(0)));
    });
}
