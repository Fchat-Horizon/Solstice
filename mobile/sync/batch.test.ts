/**
 * Batched transfers, both directions (Horizon repo issue #958). The download
 * follows a cursor until a batch reports `done`; the upload simply posts more than
 * once. The interesting cases are the seams: a conversation split across batches,
 * the boundary between two slices, an older peer that sends no batch envelope, and
 * a cursor chain that never terminates.
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import {buildSyncBatch, mergeLogs, SYNC_SEND_START, SyncMerge} from './archive.ts';
import type {MergeStats} from './archive.ts';
import {runSync} from './client.ts';
import type {SyncDeviceInfo} from './client.ts';
import {serializeMessages, sliceLog} from './logMessage.ts';
import type {LogMessage} from './logMessage.ts';
import {MemorySyncStorage} from './memoryStorage.ts';
import {MockSyncServer, withBatchEnvelope} from './mockServer.ts';
import {NodeSyncTransport} from './nodeTransport.ts';
import type {SyncResponse, SyncTransport} from './transport.ts';
import {SYNC_BATCH_MAX_RECORDS, SYNC_BATCH_TARGET_BYTES, SyncError} from './payload.ts';
import type {SyncSessionPayload} from './payload.ts';
import {allBatches, archive, dumpStore, msg, wholeArchive} from './testArchive.ts';
import {fromBase64, toBase64, utf8} from './bytes.ts';
import {createZipWriter} from './zipWriter.ts';

const DEVICE: SyncDeviceInfo = {deviceName: 'Test Phone', platform: 'ios', appVersion: 'test'};

function payloadFor(server: MockSyncServer, account: string): SyncSessionPayload {
    return {addrs: ['127.0.0.1'], port: server.port, token: server.token, key: server.key, account};
}

function run(
    server: MockSyncServer, store: MemorySyncStorage, sendBudget?: number
): ReturnType<typeof runSync> {
    return runSync({
        payload: payloadFor(server, 'Acc'),
        transport: new NodeSyncTransport(),
        store,
        device: DEVICE,
        localAccount: 'Acc',
        sleep: async () => undefined,
        sendOptions: sendBudget !== undefined ? {budget: sendBudget} : undefined
    });
}

/** A conversation of `count` messages one second apart, big enough to span batches. */
function conversation(count: number, sender = 'Bob', from = 1_700_000_000): LogMessage[] {
    return Array.from({length: count}, (_, i) => msg(from + i, 0, sender, `line ${i}`));
}

function getRequests(server: MockSyncServer): Array<string | null> {
    return server.requests.filter((r) => r.method === 'GET' && r.path === '/v1/logs').map((r) => r.cursor);
}

async function mergeAll(zips: Uint8Array[], store: MemorySyncStorage): Promise<MergeStats> {
    const merge = new SyncMerge(store);
    for(const zip of zips) await merge.mergeBatch(zip);
    return merge.finish();
}

// MARK: Following the cursor

test('batch: an archive with no sync-batch.json is the whole log set and stops the loop', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(4));
    // No serveBatches: the mock answers like a Horizon built before batching, which
    // ignores the query parameter and sends everything with no envelope.
    const server = await MockSyncServer.start({account: 'Acc', logsToServe: await wholeArchive(desktop)});
    try {
        const phone = new MemorySyncStorage();
        const result = await run(server, phone);
        assert.equal(result.received.messagesAdded, 4);
        assert.deepEqual(getRequests(server), ['start'], 'one request, and it still carried the cursor');
        assert.ok(server.finished);
    } finally {
        server.stop();
    }
});

test('batch: the cursor rides in the query string', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(30));
    const server = await MockSyncServer.start({account: 'Acc'});
    server.serveBatches(await allBatches(desktop, {budget: 100}));
    try {
        await run(server, new MemorySyncStorage());
        const cursors = getRequests(server);
        assert.ok(cursors.length > 2, `expected several batches, got ${cursors.length}`);
        assert.equal(cursors[0], 'start');
        // Every later request carried a distinct minted token, not a dropped query.
        for(const cursor of cursors.slice(1)) assert.ok(cursor !== null && cursor !== 'start', String(cursor));
        assert.equal(new Set(cursors).size, cursors.length, 'no cursor was requested twice');
    } finally {
        server.stop();
    }
});

test('batch: a three-batch chain merges to the same store as one archive', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', '#room', 'The Room', conversation(9, 'Chan'));
    await desktop.seed('Alice', 'bob', 'Bob', conversation(9));
    await desktop.seed('Beth', 'cat', 'Cat', conversation(9, 'Cat'));

    const batches = await allBatches(desktop, {budget: 400});
    assert.ok(batches.length >= 3, `expected at least three batches, got ${batches.length}`);

    const batched = new MemorySyncStorage();
    const batchedStats = await mergeAll(batches, batched);
    const whole = new MemorySyncStorage();
    const wholeStats = await mergeLogs(await wholeArchive(desktop), whole);

    assert.deepEqual(await dumpStore(batched), await dumpStore(whole));
    assert.deepEqual(batchedStats, wholeStats);
});

test('batch: a repeated cursor terminates instead of hanging', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(20));
    const server = await MockSyncServer.start({account: 'Acc'});
    // Every batch names the same next cursor, so following it would loop forever.
    server.serveBatches(await allBatches(desktop, {budget: 100}),
        (index) => ({index, done: false, cursor: 'stuck'}));
    try {
        await assert.rejects(run(server, new MemorySyncStorage()), (e: unknown) =>
            e instanceof SyncError && e.kind.type === 'badResponse');
        assert.ok(getRequests(server).length <= 3, 'it must not keep asking');
    } finally {
        server.stop();
    }
});

test('batch: a batch that is not done but names no cursor ends the download', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(20));
    const server = await MockSyncServer.start({account: 'Acc'});
    server.serveBatches(await allBatches(desktop, {budget: 100}), (index) => ({index, done: false}));
    try {
        const phone = new MemorySyncStorage();
        const result = await run(server, phone);
        // Only the first batch landed, but the sync completed rather than stalling.
        assert.ok(result.received.messagesAdded > 0);
        assert.equal(getRequests(server).length, 1);
        assert.ok(server.finished);
    } finally {
        server.stop();
    }
});

test('batch: unknown root entries are ignored', async () => {
    const store = new MemorySyncStorage();
    const zip = new AdmZip(Buffer.from(archive({Alice: {bob: [msg(1_700_000_000, 0, 'Bob', 'hi')]}})));
    zip.addFile('something-else.json', Buffer.from('{"nonsense":true}', 'utf8'));
    zip.addFile('README.txt', Buffer.from('not part of the protocol', 'utf8'));
    const merge = new SyncMerge(store);
    const batch = await merge.mergeBatch(new Uint8Array(zip.toBuffer()));
    const stats = await merge.finish();

    assert.equal(batch, undefined, 'no sync-batch.json means no envelope');
    assert.equal(stats.messagesAdded, 1);
    assert.deepEqual(Object.keys(await store.loadIndex('Alice')), ['bob']);
});

test('batch: a malformed envelope stops the loop rather than following a bad cursor', async () => {
    const store = new MemorySyncStorage();
    const zip = new AdmZip(Buffer.from(archive({Alice: {bob: [msg(1_700_000_000, 0, 'Bob', 'hi')]}})));
    zip.addFile('sync-batch.json', Buffer.from('{not json', 'utf8'));
    const merge = new SyncMerge(store);
    assert.equal(await merge.mergeBatch(new Uint8Array(zip.toBuffer())), undefined);
    assert.equal((await merge.finish()).messagesAdded, 1);
});

// MARK: Conversations that span batches

test('batch: a split conversation is written once and counts as one creation', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(12));
    const batches = await allBatches(desktop, {budget: 100});
    assert.ok(batches.length >= 3, `expected the conversation to split, got ${batches.length} batches`);

    const phone = new MemorySyncStorage();
    const stats = await mergeAll(batches, phone);

    assert.equal(phone.writeCount, 1, 'the deferred flush must write the conversation exactly once');
    assert.equal(stats.conversationsCreated, 1);
    assert.equal(stats.conversationsUpdated, 0, 'a creation extended by later batches is not also an update');
    assert.equal(stats.charactersTouched, 1);
    assert.equal(stats.messagesAdded, 12);
    assert.deepEqual((await phone.readLog('Alice', 'bob')).messages, conversation(12));
});

test('batch: an existing conversation extended across batches counts as one update', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(12));
    const batches = await allBatches(desktop, {budget: 100});

    const phone = new MemorySyncStorage();
    await phone.seed('Alice', 'bob', 'Bob', [msg(1_600_000_000, 0, 'Me', 'older')]);
    const stats = await mergeAll(batches, phone);

    assert.equal(phone.writeCount, 1);
    assert.equal(stats.conversationsCreated, 0);
    assert.equal(stats.conversationsUpdated, 1);
});

test('batch: a duplicate at a batch boundary is not re-added and order holds', async () => {
    const desktop = new MemorySyncStorage();
    const messages = conversation(12);
    await desktop.seed('Alice', 'bob', 'Bob', messages);
    const batches = await allBatches(desktop, {budget: 100});
    assert.ok(batches.length >= 3);

    // Seed the phone with the message the second batch starts on, so the dedupe has
    // to work across the seam rather than within one archive.
    const boundary = JSON.parse(
        new AdmZip(Buffer.from(batches[1])).getEntry('characters/Alice/logs/bob.json')!
            .getData().toString('utf8')) as LogMessage[];
    const phone = new MemorySyncStorage();
    await phone.seed('Alice', 'bob', 'Bob', [boundary[0]]);

    const stats = await mergeAll(batches, phone);
    const stored = (await phone.readLog('Alice', 'bob')).messages;

    assert.equal(stats.messagesAdded, 11, 'the seeded message must not be added again');
    assert.deepEqual(stored, messages);
    for(let i = 1; i < stored.length; i++) assert.ok(stored[i].time >= stored[i - 1].time, 'time ascending');
});

test('batch: a conversation takes its name from the batch that creates it', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', '#abc123', 'Some Channel Name', conversation(12, 'Chan'));
    const batches = await allBatches(desktop, {budget: 100});
    assert.ok(batches.length >= 3);

    // Every batch that carries a slice also names it, so whichever one the receiver
    // creates the conversation from has the name in hand. A trailing batch that
    // resumed exactly at end of file carries nothing at all, names included.
    for(const zip of batches) {
        const entries = new AdmZip(Buffer.from(zip));
        const carriesLog = entries.getEntry('characters/Alice/logs/#abc123.json') !== null;
        const carriesNames = entries.getEntry('characters/Alice/logs-names.json') !== null;
        assert.equal(carriesNames, carriesLog, 'names accompany exactly the batches that carry conversations');
    }

    const phone = new MemorySyncStorage();
    await mergeAll(batches, phone);
    assert.equal((await phone.loadIndex('Alice'))['#abc123'].name, 'Some Channel Name');
});

// MARK: Damaged local logs

test('batch: a damaged conversation is skipped once, not once per batch', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(12));
    const batches = await allBatches(desktop, {budget: 100});
    assert.ok(batches.length >= 3);

    const phone = new MemorySyncStorage();
    await phone.seed('Alice', 'bob', 'Bob', [msg(1_600_000_000, 0, 'Me', 'kept')]);
    // A trailing partial record: the parse stops short of the end of the file.
    const damaged = Buffer.concat([
        serializeMessages([msg(1_600_000_000, 0, 'Me', 'kept')]), Buffer.from([1, 2, 3])
    ]);
    await phone.corrupt('Alice', 'bob', damaged);

    const stats = await mergeAll(batches, phone);

    assert.equal(stats.conversationsSkipped, 1, 'reported once for the session, not once per batch');
    assert.equal(stats.messagesAdded, 0);
    assert.equal(phone.writeCount, 0, 'a damaged log must never be rewritten from its parsed prefix');
    assert.deepEqual(phone.rawLog('Alice', 'bob'), damaged);
});

test('batch: an undamaged conversation still merges alongside a damaged one', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(3));
    await desktop.seed('Alice', 'cat', 'Cat', conversation(3, 'Cat'));

    const phone = new MemorySyncStorage();
    await phone.seed('Alice', 'bob', 'Bob', [msg(1, 0, 'Me', 'x')]);
    await phone.corrupt('Alice', 'bob',
        Buffer.concat([serializeMessages([msg(1, 0, 'Me', 'x')]), Buffer.from([9])]));

    const stats = await mergeLogs(await wholeArchive(desktop), phone);
    assert.equal(stats.conversationsSkipped, 1);
    assert.equal(stats.conversationsCreated, 1);
    assert.equal((await phone.readLog('Alice', 'cat')).messages.length, 3);
});

// MARK: Uploading in batches

test('batch: an upload split under a small budget reassembles to the whole store', async () => {
    const phone = new MemorySyncStorage();
    await phone.seed('Alice', '#room', 'The Room', conversation(9, 'Chan'));
    await phone.seed('Alice', 'bob', 'Bob', conversation(9));
    await phone.seed('Beth', 'cat', 'Cat', conversation(9, 'Cat'));
    const before = await dumpStore(phone);

    const server = await MockSyncServer.start({account: 'Acc'});
    try {
        await run(server, phone, 200);
        assert.ok(server.uploads.length > 1, `expected several uploads, got ${server.uploads.length}`);

        const desktop = new MemorySyncStorage();
        await mergeAll(server.uploads, desktop);
        assert.deepEqual(await dumpStore(desktop), before);
    } finally {
        server.stop();
    }
});

test('batch: the running total of a batching peer is reported, not the sum', async () => {
    const phone = new MemorySyncStorage();
    await phone.seed('Alice', 'bob', 'Bob', conversation(9));
    const server = await MockSyncServer.start({account: 'Acc'});
    // The desktop answers with batch envelopes, so its last reply is the session total.
    server.serveBatches([await wholeArchive(new MemorySyncStorage())]);
    server.uploadStats = [
        {conversationsCreated: 1, conversationsUpdated: 0, messagesAdded: 3, charactersTouched: 1,
            conversationsSkipped: 0},
        {conversationsCreated: 1, conversationsUpdated: 0, messagesAdded: 9, charactersTouched: 1,
            conversationsSkipped: 0}
    ];
    try {
        const result = await run(server, phone, 200);
        assert.ok(server.uploads.length > 1);
        assert.equal(result.sent.messagesAdded, 9, 'the last answer is the running session total');
        assert.equal(result.sent.conversationsCreated, 1);
    } finally {
        server.stop();
    }
});

test('batch: per-call totals from a peer without batching are summed', async () => {
    const phone = new MemorySyncStorage();
    await phone.seed('Alice', 'bob', 'Bob', conversation(9));
    const server = await MockSyncServer.start({account: 'Acc'});
    // No serveBatches, so the download carries no envelope: an older desktop, which
    // reports each upload on its own. One message per call, so the total is the
    // number of calls only if they were actually added up.
    server.mergeStatsToReturn = {
        conversationsCreated: 0, conversationsUpdated: 1, messagesAdded: 1,
        charactersTouched: 1, conversationsSkipped: 0
    };
    try {
        const result = await run(server, phone, 200);
        assert.ok(server.uploads.length > 1);
        assert.equal(result.sent.messagesAdded, server.uploads.length);
    } finally {
        server.stop();
    }
});

// MARK: Not echoing the download back

test('batch: a conversation the download created is not uploaded back', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(12));
    const server = await MockSyncServer.start({account: 'Acc'});
    server.serveBatches(await allBatches(desktop, {budget: 100}));
    try {
        const phone = new MemorySyncStorage();
        await phone.seed('Alice', 'cat', 'Cat', conversation(2, 'Cat', 1_600_000_000));

        await run(server, phone);
        assert.equal((await phone.readLog('Alice', 'bob')).messages.length, 12, 'the download did land');

        const check = new MemorySyncStorage();
        await mergeAll(server.uploads, check);
        assert.deepEqual((await check.readLog('Alice', 'bob')).messages, [],
            'the phone must not echo the desktop\'s own logs back to it');
        assert.equal((await check.readLog('Alice', 'cat')).messages.length, 2);
    } finally {
        server.stop();
    }
});

test('batch: a conversation both devices have uploads only this device\'s prior content', async () => {
    const mine = conversation(2, 'Me', 1_600_000_000);
    const theirs = conversation(12);
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', theirs);
    const server = await MockSyncServer.start({account: 'Acc'});
    server.serveBatches(await allBatches(desktop, {budget: 100}));
    try {
        const phone = new MemorySyncStorage();
        await phone.seed('Alice', 'bob', 'Bob', mine);

        await run(server, phone);
        assert.equal((await phone.readLog('Alice', 'bob')).messages.length, 14, 'the phone holds the union');

        const check = new MemorySyncStorage();
        await mergeAll(server.uploads, check);
        assert.deepEqual((await check.readLog('Alice', 'bob')).messages, mine,
            'only the content the phone held before the merge goes back up');
    } finally {
        server.stop();
    }
});

test('batch: snapshots do not survive the session', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(4));
    const server = await MockSyncServer.start({account: 'Acc'});
    server.serveBatches([await wholeArchive(desktop)]);
    try {
        const phone = new MemorySyncStorage();
        await phone.seed('Alice', 'bob', 'Bob', [msg(1_600_000_000, 0, 'Me', 'mine')]);
        await run(server, phone);
        // With the snapshot cleared, the send source is the log again, so a later
        // upload would carry the merged conversation rather than stale content.
        const batch = await buildSyncBatch(phone, SYNC_SEND_START);
        const entry = new AdmZip(batch.zip).getEntry('characters/Alice/logs/bob.json');
        assert.ok(entry !== null);
        assert.equal((JSON.parse(entry!.getData().toString('utf8')) as LogMessage[]).length, 5);
    } finally {
        server.stop();
    }
});

// MARK: Retries and idempotency

test('batch: a 409 busy answer is retried rather than failing the sync', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(4));
    const server = await MockSyncServer.start({account: 'Acc', logsToServe: await wholeArchive(desktop)});
    server.busyResponses = 2;
    try {
        const result = await run(server, new MemorySyncStorage());
        assert.equal(result.received.messagesAdded, 4);
        assert.ok(server.finished);
        assert.equal(getRequests(server).length, 3, 'two busy answers, then the real one');
    } finally {
        server.stop();
    }
});

test('batch: replaying the whole stream adds nothing', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', '#room', 'The Room', conversation(9, 'Chan'));
    await desktop.seed('Alice', 'bob', 'Bob', conversation(9));
    const batches = await allBatches(desktop, {budget: 200});

    const phone = new MemorySyncStorage();
    const first = await mergeAll(batches, phone);
    assert.equal(first.messagesAdded, 18);
    const after = await dumpStore(phone);
    phone.writeCount = 0;

    const second = await mergeAll(batches, phone);
    assert.equal(second.messagesAdded, 0);
    assert.equal(second.conversationsCreated, 0);
    assert.equal(second.conversationsUpdated, 0);
    assert.equal(second.charactersTouched, 0);
    assert.equal(phone.writeCount, 0, 'nothing new means nothing written');
    assert.deepEqual(await dumpStore(phone), after);
});

// MARK: Slice boundaries

test('slice: resumes exactly where the previous slice stopped', async () => {
    const messages = conversation(20);
    const store = new MemorySyncStorage();
    await store.seed('Alice', 'bob', 'Bob', messages);

    const collected: LogMessage[] = [];
    let offset = 0;
    for(let i = 0; i < 50; i++) {
        const slice = await store.messagesFrom('Alice', 'bob', offset, 120, 1000);
        collected.push(...slice.messages);
        offset = slice.nextOffset;
        if(slice.atEof) break;
    }
    assert.deepEqual(collected, messages);
    assert.equal(offset, serializeMessages(messages).length, 'the final offset is the end of the file');
});

test('slice: the record that crosses the budget is included, never split', () => {
    const messages = conversation(5);
    const data = serializeMessages(messages);
    // One byte of budget still yields exactly one whole record.
    const slice = sliceLog(data, 0, 1, 1000);
    assert.equal(slice.messages.length, 1);
    assert.deepEqual(slice.messages[0], messages[0]);
    assert.equal(slice.atEof, false);
    assert.ok(slice.jsonBytes > 1);
});

test('slice: the record cap bounds a slice of tiny messages', () => {
    const messages = conversation(20);
    const slice = sliceLog(serializeMessages(messages), 0, 1024 * 1024, 4);
    assert.equal(slice.messages.length, 4);
    assert.equal(slice.atEof, false);
});

test('slice: a damaged record ends the slice at end of file so the sender moves on', () => {
    const good = conversation(2);
    const data = Buffer.concat([serializeMessages(good), Buffer.from([7, 7, 7])]);
    const slice = sliceLog(data, 0, 1024 * 1024, 1000);
    assert.deepEqual(slice.messages, good);
    assert.equal(slice.atEof, true, 'the sender ships the valid prefix rather than stalling');
});

test('batch: a damaged log is uploaded as its valid prefix without stalling the loop', async () => {
    const good = conversation(6);
    const phone = new MemorySyncStorage();
    await phone.seed('Alice', 'bob', 'Bob', good);
    await phone.seed('Alice', 'cat', 'Cat', conversation(3, 'Cat'));
    // Trailing garbage: the send side must ship what parses and move to the next
    // conversation, not ask to resume forever at a record that never will.
    await phone.corrupt('Alice', 'bob', Buffer.concat([serializeMessages(good), Buffer.from([4, 4, 4])]));

    const batches = await allBatches(phone, {budget: 100});
    const desktop = new MemorySyncStorage();
    await mergeAll(batches, desktop);

    assert.deepEqual((await desktop.readLog('Alice', 'bob')).messages, good);
    assert.equal((await desktop.readLog('Alice', 'cat')).messages.length, 3,
        'the conversation after the damaged one still went out');
});

test('slice: an offset at or past the end yields nothing', async () => {
    const store = new MemorySyncStorage();
    await store.seed('Alice', 'bob', 'Bob', conversation(3));
    const size = serializeMessages(conversation(3)).length;
    const slice = await store.messagesFrom('Alice', 'bob', size, 1024, 1000);
    assert.deepEqual(slice.messages, []);
    assert.equal(slice.atEof, true);
});

// MARK: The envelope helper itself

test('batch: withBatchEnvelope keeps the archive readable and adds the entry last', () => {
    const base = archive({Alice: {bob: [msg(1_700_000_000, 0, 'Bob', 'hi')]}});
    const stamped = withBatchEnvelope(base, {index: 2, done: false, cursor: 'abc'});
    const entries = new AdmZip(Buffer.from(stamped)).getEntries().map((e) => e.entryName);
    assert.equal(entries[entries.length - 1], 'sync-batch.json');
    assert.ok(entries.includes('characters/Alice/logs/bob.json'));
});

// MARK: Budget accounting without serializing

test('slice: the computed JSON size matches what the array actually serializes to', () => {
    const messages = conversation(50);
    const slice = sliceLog(serializeMessages(messages), 0, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    // The budget is counted from the record's own field lengths rather than by
    // stringifying it, which measured as one of the larger costs in the send path.
    // Each record is charged its exact bytes plus one separator, so for unescaped
    // content the total lands one byte under the array, which also carries a closing
    // bracket. A fixed byte is not worth correcting against a 16 MiB budget.
    assert.equal(slice.jsonBytes + 1, Buffer.byteLength(JSON.stringify(messages), 'utf8'));
});

test('slice: escaped and multibyte content is never over-counted', () => {
    const messages = [
        msg(1_700_000_000, 0, 'Bob', 'he said "hi"\nand \\ left'),
        msg(1_700_000_001, 0, 'René', 'café \u{1F31F}')
    ];
    const slice = sliceLog(serializeMessages(messages), 0, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const actual = Buffer.byteLength(JSON.stringify(messages), 'utf8');
    // Escaping only grows the real figure, so the estimate is a lower bound. Being
    // under is safe: the budget is a target, and the body cap sits far above it.
    assert.ok(slice.jsonBytes <= actual, `${slice.jsonBytes} > ${actual}`);
    assert.deepEqual(slice.messages, messages);
});

// MARK: The zip writer seam

test('zip: the fallback writer produces an archive the merge can read', async () => {
    const writer = await createZipWriter();
    await writer.add('manifest.json', '{"version":2}');
    await writer.add('characters/Alice/logs/bob.json',
        JSON.stringify([msg(1_700_000_000, 0, 'Bob', 'hi \u{1F31F}')]));
    const zip = await writer.finish();

    const store = new MemorySyncStorage();
    const stats = await mergeLogs(new Uint8Array(zip), store);
    assert.equal(stats.messagesAdded, 1);
    assert.equal((await store.readLog('Alice', 'bob')).messages[0].text, 'hi \u{1F31F}');
});

test('zip: utf8 encodes without going through the buffer polyfill', () => {
    const text = 'café \u{1F31F} "quoted"';
    assert.deepEqual(utf8(text), Buffer.from(text, 'utf8'));
});

// MARK: Overlapping the wire with the work

/**
 * Holds every transfer response open for a moment after it arrives, and records
 * whether the store was touched during that window. With the loops pipelined the
 * answer is yes: the request for the next batch is already on the wire while this
 * device reads, merges or builds. Without it the two strictly alternate and the
 * store is idle for as long as a request takes.
 */
class HoldingTransport implements SyncTransport {
    readonly inner = new NodeSyncTransport();
    readonly hold: 'GET' | 'POST';
    outstanding = 0;
    sawStoreWork = false;

    constructor(hold: 'GET' | 'POST') { this.hold = hold; }

    async request(
        method: string, url: string, headers: {[name: string]: string},
        body: Uint8Array | undefined, timeoutMs: number
    ): Promise<SyncResponse> {
        const held = method === this.hold && url.includes('/v1/logs');
        if(held) this.outstanding++;
        try {
            const response = await this.inner.request(method, url, headers, body, timeoutMs);
            if(held) await new Promise((resolve) => setTimeout(resolve, 25));
            return response;
        } finally {
            if(held) this.outstanding--;
        }
    }
}

/**
 * A store that reports its reads to a watching transport. Each one yields to the
 * macrotask queue first: the in-memory store settles in microtasks, so without
 * that it would finish a whole batch before a socket write even leaves, and the
 * overlap under test would be invisible. Every real store is file-backed and does
 * yield like this.
 */
class WatchedStore extends MemorySyncStorage {
    private readonly watch: HoldingTransport;

    constructor(watch: HoldingTransport) {
        super();
        this.watch = watch;
    }

    private async note(): Promise<void> {
        await new Promise((resolve) => setImmediate(resolve));
        if(this.watch.outstanding > 0) this.watch.sawStoreWork = true;
    }

    async readLog(character: string, key: string): ReturnType<MemorySyncStorage['readLog']> {
        await this.note();
        return super.readLog(character, key);
    }

    async messagesFrom(
        character: string, key: string, byteOffset: number, maxJsonBytes: number, maxRecords: number
    ): ReturnType<MemorySyncStorage['messagesFrom']> {
        await this.note();
        return super.messagesFrom(character, key, byteOffset, maxJsonBytes, maxRecords);
    }
}

test('batch: the next download is requested before the current one is merged', async () => {
    const desktop = new MemorySyncStorage();
    await desktop.seed('Alice', 'bob', 'Bob', conversation(30));
    await desktop.seed('Alice', 'carol', 'Carol', conversation(30, 'Carol'));
    const batches = await allBatches(desktop, {budget: 900});
    assert.ok(batches.length >= 3, `expected several batches, got ${batches.length}`);

    const transport = new HoldingTransport('GET');
    const store = new WatchedStore(transport);
    const server = await MockSyncServer.start({account: 'Acc'});
    server.serveBatches(batches);
    try {
        await runSync({
            payload: payloadFor(server, 'Acc'), transport, store, device: DEVICE,
            localAccount: 'Acc', sleep: async () => undefined
        });
    } finally {
        await server.stop();
    }

    assert.ok(transport.sawStoreWork, 'the merge should run while the next batch is still in flight');
    // Overlapping must not change what lands: the same batches merged serially.
    const serial = new MemorySyncStorage();
    await mergeAll(batches, serial);
    assert.deepEqual(await dumpStore(store), await dumpStore(serial));
});

test('batch: the next upload is built while the previous one is in flight', async () => {
    const transport = new HoldingTransport('POST');
    const store = new WatchedStore(transport);
    await store.seed('Alice', 'bob', 'Bob', conversation(30));
    await store.seed('Alice', 'carol', 'Carol', conversation(30, 'Carol'));

    const server = await MockSyncServer.start({account: 'Acc', logsToServe: await wholeArchive(new MemorySyncStorage())});
    try {
        await runSync({
            payload: payloadFor(server, 'Acc'), transport, store, device: DEVICE,
            localAccount: 'Acc', sleep: async () => undefined, sendOptions: {budget: 900}
        });
    } finally {
        await server.stop();
    }

    assert.ok(server.uploads.length >= 3, `expected several uploads, got ${server.uploads.length}`);
    assert.ok(transport.sawStoreWork, 'the next batch should be built while the previous post is in flight');
    // And the whole store still arrives: every upload merged into a fresh store
    // reproduces the source exactly.
    const received = new MemorySyncStorage();
    await mergeAll(server.uploads, received);
    assert.deepEqual(await dumpStore(received), await dumpStore(store));
});

test('zip: base64 encodes without going through the buffer polyfill', () => {
    const bytes = new Uint8Array(Array.from({length: 512}, (_, i) => (i * 37) & 0xff));
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
    // Every length modulo 3 exercises a different amount of padding.
    for(const length of [0, 1, 2, 3, 4, 5]) {
        const slice = bytes.subarray(0, length);
        assert.equal(toBase64(slice), Buffer.from(slice).toString('base64'));
        assert.deepEqual(new Uint8Array(fromBase64(toBase64(slice))), slice);
    }
    // A view into a larger buffer must encode only its own window.
    assert.equal(toBase64(bytes.subarray(8, 20)), Buffer.from(bytes.subarray(8, 20)).toString('base64'));
});

test('batch: the record allowance never binds before the byte budget', () => {
    // A record's JSON is at least a 40 byte frame plus a 10 digit timestamp, one digit
    // of type and a one character sender. If the allowance sits below the budget
    // divided by that, short messages fill a fraction of each batch and the batch
    // count inflates until a large store cannot be uploaded at all.
    const MIN_JSON_RECORD_BYTES = 40 + 10 + 1 + 1;
    assert.ok(
        SYNC_BATCH_MAX_RECORDS * MIN_JSON_RECORD_BYTES >= SYNC_BATCH_TARGET_BYTES,
        `${SYNC_BATCH_MAX_RECORDS} records of ${MIN_JSON_RECORD_BYTES} bytes does not reach `
            + `the ${SYNC_BATCH_TARGET_BYTES} byte budget`);
});
