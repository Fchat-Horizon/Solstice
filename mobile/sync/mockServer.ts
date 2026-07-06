/**
 * Test-only in-process HTTP server implementing the spec's endpoints
 * (docs/log-sync-protocol.md), so `runSync` can be driven end to end over a real
 * socket. Mirrors the relevant behaviour of Horizon's
 * `electron/services/sync/server.ts` and Luna's `MockSyncServer`: bearer-token
 * auth, AES-256-GCM body framing, the handshake account check, the transfer
 * endpoints, and the state/expiry guards. Not production code.
 */

import AdmZip from 'adm-zip';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import {decryptBody, encryptBody} from './crypto.ts';
import type {MergeStats} from './archive.ts';

export interface MockServerOptions {
    account: string;
    token?: string;
    key?: Uint8Array;
    logsToServe?: Uint8Array;
    mergeStats?: MergeStats;
}

const ZERO_STATS: MergeStats = {
    conversationsCreated: 0, conversationsUpdated: 0, messagesAdded: 0, charactersTouched: 0
};

export class MockSyncServer {
    readonly token: string;
    readonly key: Uint8Array;
    readonly account: string;
    logsToServe: Uint8Array;
    mergeStatsToReturn: MergeStats;
    receivedUpload: Uint8Array | undefined = undefined;
    finished = false;
    forceSessionEnded = false;

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

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const body = await readBody(req);
        if(this.forceSessionEnded) return this.respond(res, 410, await this.encJson({error: 'session-ended'}));

        const auth = req.headers['authorization'];
        const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
        if(presented !== this.token) { res.writeHead(401); res.end(); return; }

        const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
        if(route === 'POST /v1/handshake') return this.handshake(res, body);
        if(route === 'GET /v1/logs') {
            if(!this.paired) return this.respond(res, 409, await this.encJson({error: 'not-paired'}));
            return this.respond(res, 200, await encryptBody(this.key, this.logsToServe));
        }
        if(route === 'POST /v1/logs') {
            if(!this.paired) return this.respond(res, 409, await this.encJson({error: 'not-paired'}));
            try { this.receivedUpload = await decryptBody(this.key, body); } catch { /* leave undefined */ }
            return this.respond(res, 200, await this.encJson({ok: true, ...this.mergeStatsToReturn}));
        }
        if(route === 'POST /v1/finish') {
            if(!this.paired) return this.respond(res, 409, await this.encJson({error: 'not-paired'}));
            this.finished = true;
            return this.respond(res, 200, await this.encJson({ok: true}));
        }
        return this.respond(res, 404, await this.encJson({error: 'not-found'}));
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
