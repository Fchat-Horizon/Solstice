import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSyncArchive, mergeLogs} from './archive.ts';
import {runSync, SYNC_STAGES} from './client.ts';
import type {SyncDeviceInfo, SyncStage} from './client.ts';
import {MemorySyncStorage} from './memoryStorage.ts';
import {MockSyncServer} from './mockServer.ts';
import {NodeSyncTransport} from './nodeTransport.ts';
import {SyncError} from './payload.ts';
import type {SyncSessionPayload} from './payload.ts';

const DEVICE: SyncDeviceInfo = {deviceName: 'Test Phone', platform: 'ios', appVersion: 'test'};

function payloadFor(server: MockSyncServer, account: string, addrs = ['127.0.0.1']): SyncSessionPayload {
    return {addrs, port: server.port, token: server.token, key: server.key, account};
}

async function run(payload: SyncSessionPayload, store: MemorySyncStorage, localAccount: string) {
    const stages: SyncStage[] = [];
    const result = await runSync({
        payload, transport: new NodeSyncTransport(), store, device: DEVICE, localAccount,
        onStage: (stage) => stages.push(stage)
    });
    return {result, stages};
}

async function storeWith(logs: {[character: string]: {[key: string]: [number, number, string, string]}}) {
    const store = new MemorySyncStorage();
    for(const [character, conversations] of Object.entries(logs))
        for(const [key, m] of Object.entries(conversations))
            await store.seed(character, key, key, [{time: m[0], type: m[1], sender: m[2], text: m[3]}]);
    return store;
}

// MARK: Happy path

test('client: a full sync merges in both directions', async () => {
    const desktop = await storeWith({Alice: {bob: [1_700_000_000, 0, 'Bob', 'from desktop']}});
    const server = await MockSyncServer.start({
        account: 'AccountName',
        logsToServe: await buildSyncArchive(desktop),
        mergeStats: {conversationsCreated: 1, conversationsUpdated: 0, messagesAdded: 1, charactersTouched: 1}
    });
    try {
        const phone = new MemorySyncStorage();
        await phone.seed('Alice', 'cat', 'Cat', [{time: 1_700_000_100, type: 0, sender: 'Cat', text: 'from phone'}]);

        // Case-insensitive account match.
        const {result, stages} = await run(payloadFor(server, 'AccountName'), phone, 'accountname');

        assert.deepEqual(stages, SYNC_STAGES);
        assert.equal(result.received.messagesAdded, 1);
        assert.equal(result.received.conversationsCreated, 1);
        assert.equal((await phone.allMessages('Alice', 'bob'))[0].text, 'from desktop');
        assert.equal((await phone.allMessages('Alice', 'cat'))[0].text, 'from phone');
        assert.equal(result.sent.messagesAdded, 1);
        assert.equal(result.remoteDeviceName, 'mock-desktop');
        assert.ok(server.finished);

        // The upload the desktop received held the phone's conversation, not the desktop's own.
        assert.ok(server.receivedUpload !== undefined);
        const check = new MemorySyncStorage();
        await mergeLogs(server.receivedUpload!, check);
        assert.equal((await check.allMessages('Alice', 'cat'))[0].text, 'from phone');
        assert.deepEqual(await check.allMessages('Alice', 'bob'), [],
            'the phone must not echo the desktop\'s own logs back to it');
    } finally {
        server.stop();
    }
});

test('client: syncing with an empty desktop still uploads and finishes', async () => {
    const server = await MockSyncServer.start({
        account: 'Acc', logsToServe: await buildSyncArchive(new MemorySyncStorage())
    });
    try {
        const phone = await storeWith({Me: {bob: [1, 0, 'Bob', 'hi']}});
        const {result} = await run(payloadFor(server, 'Acc'), phone, 'Acc');
        assert.equal(result.received.messagesAdded, 0);
        assert.ok(server.finished);
        assert.ok(server.receivedUpload !== undefined);
    } finally {
        server.stop();
    }
});

// MARK: Address failover

test('client: fails over to a reachable address', async () => {
    const server = await MockSyncServer.start({account: 'Acc'});
    try {
        // First address is a black hole (TEST-NET-1); second is the live server.
        const payload = payloadFor(server, 'Acc', ['192.0.2.1', '127.0.0.1']);
        const {result} = await run(payload, new MemorySyncStorage(), 'Acc');
        assert.equal(result.remoteDeviceName, 'mock-desktop');
    } finally {
        server.stop();
    }
});

// MARK: Error mapping

test('client: account mismatch is caught locally before any request', async () => {
    const payload: SyncSessionPayload = {
        addrs: ['127.0.0.1'], port: 1, token: 't', key: new Uint8Array(32), account: 'TheirAccount'
    };
    await assert.rejects(run(payload, new MemorySyncStorage(), 'MyAccount'), (e: unknown) =>
        e instanceof SyncError && e.kind.type === 'accountMismatch'
        && e.kind.payloadAccount === 'TheirAccount' && e.kind.localAccount === 'MyAccount');
});

test('client: an unreachable host reports unreachable', async () => {
    const payload: SyncSessionPayload = {
        addrs: ['192.0.2.1'], port: 59999, token: 't', key: new Uint8Array(32), account: 'Acc'
    };
    await assert.rejects(run(payload, new MemorySyncStorage(), 'Acc'), (e: unknown) =>
        e instanceof SyncError && e.kind.type === 'unreachable');
});

test('client: an expired session reports sessionEnded', async () => {
    const server = await MockSyncServer.start({account: 'Acc'});
    server.forceSessionEnded = true;
    try {
        await assert.rejects(run(payloadFor(server, 'Acc'), new MemorySyncStorage(), 'Acc'), (e: unknown) =>
            e instanceof SyncError && e.kind.type === 'sessionEnded');
    } finally {
        server.stop();
    }
});

test('client: a wrong token reports unauthorized', async () => {
    const server = await MockSyncServer.start({account: 'Acc'});
    try {
        const good = payloadFor(server, 'Acc');
        const payload: SyncSessionPayload = {...good, token: 'wrong-token'};
        await assert.rejects(run(payload, new MemorySyncStorage(), 'Acc'), (e: unknown) =>
            e instanceof SyncError && e.kind.type === 'unauthorized');
    } finally {
        server.stop();
    }
});
