import {test} from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import {archiveUncompressedBytes, ArchiveTooLargeError, buildSyncArchive, mergeLogs} from './archive.ts';
import {isFilesystemArtifact} from './logMessage.ts';
import type {LogMessage} from './logMessage.ts';
import {MemorySyncStorage} from './memoryStorage.ts';
import {inflateDeclaredSizes} from './oversizedArchive.ts';
import {SYNC_MAX_UNCOMPRESSED_BYTES} from './payload.ts';

function msg(time: number, type: number, sender: string, text: string): LogMessage {
    return {time, type, sender, text};
}

/** Build a sync archive with the given per-character/key message lists and optional names. */
function archive(
    logs: {[character: string]: {[key: string]: LogMessage[]}},
    names: {[character: string]: {[key: string]: string}} = {}
): Uint8Array {
    const zip = new AdmZip();
    for(const [character, conversations] of Object.entries(logs)) {
        for(const [key, messages] of Object.entries(conversations))
            zip.addFile(`characters/${character}/logs/${key}.json`, Buffer.from(JSON.stringify(messages)));
        if(names[character] !== undefined)
            zip.addFile(`characters/${character}/logs-names.json`, Buffer.from(JSON.stringify(names[character])));
    }
    return new Uint8Array(zip.toBuffer());
}

// MARK: Union merge

test('merge: is a message-level union', async () => {
    const store = new MemorySyncStorage();
    const local = msg(100, 0, 'Me', 'local only');
    const shared = msg(200, 0, 'Bob', 'on both');
    await store.seed('Alice', 'bob', 'Bob', [local, shared]);

    const incoming = msg(300, 0, 'Bob', 'remote only');
    const stats = await mergeLogs(archive({Alice: {bob: [shared, incoming]}}), store);

    assert.equal(stats.messagesAdded, 1);
    assert.equal(stats.conversationsUpdated, 1);
    assert.equal(stats.conversationsCreated, 0);
    assert.equal(stats.charactersTouched, 1);
    assert.deepEqual(await store.allMessages('Alice', 'bob'), [local, shared, incoming]);
});

test('merge: equal timestamps keep local first, then incoming', async () => {
    const store = new MemorySyncStorage();
    const localA = msg(500, 0, 'Me', 'local A');
    const localB = msg(500, 0, 'Me', 'local B');
    await store.seed('C', 'k', 'K', [localA, localB]);

    const inA = msg(500, 0, 'Them', 'incoming A');
    const inB = msg(500, 0, 'Them', 'incoming B');
    await mergeLogs(archive({C: {k: [inA, inB]}}), store);

    assert.deepEqual(await store.allMessages('C', 'k'), [localA, localB, inA, inB]);
});

test('merge: creates a missing conversation with the name from logs-names', async () => {
    const store = new MemorySyncStorage();
    const stats = await mergeLogs(
        archive({Alice: {'#abc123': [msg(1_700_000_000, 0, 'X', 'hi')]}},
            {Alice: {'#abc123': 'Some Channel Name'}}), store);

    assert.equal(stats.conversationsCreated, 1);
    assert.equal(stats.conversationsUpdated, 0);
    assert.equal((await store.loadIndex('Alice'))['#abc123'].name, 'Some Channel Name');
});

test('merge: a missing name falls back to the key (dropping a channel #)', async () => {
    const store = new MemorySyncStorage();
    await mergeLogs(archive({Alice: {'#room': [msg(1_700_000_000, 0, 'X', 'hi')]}}), store);
    assert.equal((await store.loadIndex('Alice'))['#room'].name, 'room');
});

test('merge: a local name wins over the incoming name', async () => {
    const store = new MemorySyncStorage();
    await store.seed('Alice', '#room', 'My Local Title', [msg(1, 0, 'A', 'x')]);
    await mergeLogs(archive({Alice: {'#room': [msg(2, 0, 'B', 'y')]}}, {Alice: {'#room': 'Their Title'}}), store);
    assert.equal((await store.loadIndex('Alice'))['#room'].name, 'My Local Title');
});

// MARK: Idempotency and no-rewrite

test('merge: is idempotent', async () => {
    const store = new MemorySyncStorage();
    const messages = [
        msg(1_700_000_000, 0, 'Bob', 'one'),
        msg(1_700_000_050, 1, 'Bob', 'two \u{1F600}')
    ];
    const zip = archive({Alice: {bob: messages}});

    const first = await mergeLogs(zip, store);
    assert.equal(first.messagesAdded, 2);
    assert.equal(first.conversationsCreated, 1);

    const second = await mergeLogs(zip, store);
    assert.equal(second.messagesAdded, 0);
    assert.equal(second.conversationsCreated, 0);
    assert.equal(second.conversationsUpdated, 0);
    assert.equal(second.charactersTouched, 0);
    assert.deepEqual(await store.allMessages('Alice', 'bob'), messages);
});

test('merge: no new messages does not rewrite storage', async () => {
    const store = new MemorySyncStorage();
    const messages = [msg(1_700_000_000, 0, 'Bob', 'only')];
    await store.seed('Alice', 'bob', 'Bob', messages);

    const stats = await mergeLogs(archive({Alice: {bob: messages}}), store);
    assert.equal(stats.messagesAdded, 0);
    assert.equal(store.writeCount, 0, 'an unchanged conversation must not be rewritten');
});

// MARK: Bounds

test('merge: out-of-bounds messages are skipped', async () => {
    const store = new MemorySyncStorage();
    const good = msg(1_700_000_000, 0, 'Bob', 'ok');
    const badTime = msg(0x7fffffff + 1, 0, 'Bob', 'future');
    const badType = msg(1_700_000_001, 300, 'Bob', 'type');
    const badSender = msg(1_700_000_002, 0, 'x'.repeat(300), 'sender');
    const badText = msg(1_700_000_003, 0, 'Bob', 'y'.repeat(70000));
    const stats = await mergeLogs(
        archive({Alice: {bob: [good, badTime, badType, badSender, badText]}}), store);

    assert.equal(stats.messagesAdded, 1);
    assert.deepEqual(await store.allMessages('Alice', 'bob'), [good]);
});

// MARK: Round trip through the export path

test('merge: an exported archive merges back with names and dedup', async () => {
    const source = new MemorySyncStorage();
    await source.seed('Alice', '#frontpage', 'Frontpage Chat', [msg(1_700_000_000, 0, 'Bob', 'channel')]);
    await source.seed('Alice', 'bob', 'Bob', [msg(1_700_000_005, 0, 'Bob', 'pm \u{1F31F}')]);
    const zip = await buildSyncArchive(source);

    const dest = new MemorySyncStorage();
    const first = await mergeLogs(zip, dest);
    assert.equal(first.messagesAdded, 2);
    assert.equal(first.conversationsCreated, 2);
    assert.equal(first.charactersTouched, 1);
    assert.equal((await dest.loadIndex('Alice'))['#frontpage'].name, 'Frontpage Chat');
    assert.equal((await dest.allMessages('Alice', 'bob'))[0].text, 'pm \u{1F31F}');

    const second = await mergeLogs(zip, dest);
    assert.equal(second.messagesAdded, 0);
});

test('merge: an empty store produces a manifest-only archive', async () => {
    const zip = await buildSyncArchive(new MemorySyncStorage());
    const entries = new AdmZip(Buffer.from(zip)).getEntries().map((e) => e.entryName);
    assert.deepEqual(entries, ['manifest.json']);
});

test('merge: path-traversal entries are ignored', async () => {
    const store = new MemorySyncStorage();
    const m = msg(1_700_000_000, 0, 'X', 'hi');
    const zip = new AdmZip();
    zip.addFile('characters/../../etc/logs/evil.json', Buffer.from(JSON.stringify([m])));
    zip.addFile('characters/Alice/logs/bob.json', Buffer.from(JSON.stringify([m])));
    const stats = await mergeLogs(new Uint8Array(zip.toBuffer()), store);

    assert.equal(stats.messagesAdded, 1);
    assert.equal(stats.charactersTouched, 1);
    assert.deepEqual(await store.allMessages('Alice', 'bob'), [m]);
});

// MARK: Type + artifact screening

test('merge: message types outside the defined 0-6 range are skipped', async () => {
    const store = new MemorySyncStorage();
    const bcast = msg(1_700_000_000, 6, 'Bob', 'bcast');    // 6 = Bcast, the highest defined type
    const justOver = msg(1_700_000_001, 7, 'Bob', 'undefined type');
    const byteMax = msg(1_700_000_002, 255, 'Bob', 'fits a u8 but undefined');
    const stats = await mergeLogs(archive({Alice: {bob: [bcast, justOver, byteMax]}}), store);

    assert.equal(stats.messagesAdded, 1);
    assert.deepEqual(await store.allMessages('Alice', 'bob'), [bcast]);
});

test('isFilesystemArtifact: matches shell litter, not real conversation keys', () => {
    for(const name of ['.DS_Store', 'Thumbs.db', 'thumbs.db', 'desktop.ini', 'Thumbs.db.json', 'DESKTOP.INI.json'])
        assert.ok(isFilesystemArtifact(name), `expected artifact: ${name}`);
    for(const name of ['bob', '#frontpage', 'thumbsdb', 'my.desktop.ini.log', 'notes.json'])
        assert.equal(isFilesystemArtifact(name), false, `expected real key: ${name}`);
});

test('merge: filesystem artifacts are not materialized as conversations', async () => {
    const store = new MemorySyncStorage();
    const m = msg(1_700_000_000, 0, 'X', 'hi');
    const zip = new AdmZip();
    // A peer that did not screen its log dir ships shell litter as `.json` entries.
    zip.addFile('characters/Alice/logs/Thumbs.db.json', Buffer.from(JSON.stringify([m])));
    zip.addFile('characters/Alice/logs/desktop.ini.json', Buffer.from(JSON.stringify([m])));
    zip.addFile('characters/Alice/logs/bob.json', Buffer.from(JSON.stringify([m])));
    const stats = await mergeLogs(new Uint8Array(zip.toBuffer()), store);

    assert.equal(stats.messagesAdded, 1);
    assert.equal(stats.charactersTouched, 1);
    assert.deepEqual(Object.keys(await store.loadIndex('Alice')), ['bob']);
    assert.deepEqual(await store.allMessages('Alice', 'bob'), [m]);
});

// MARK: Size caps

test('archiveUncompressedBytes: sums the entries\' declared uncompressed sizes', () => {
    const a = Buffer.from(JSON.stringify([msg(1, 0, 'A', 'x')]));
    const b = Buffer.from(JSON.stringify([msg(2, 0, 'B', 'yy')]));
    const zip = new AdmZip();
    zip.addFile('characters/Alice/logs/bob.json', a);
    zip.addFile('characters/Alice/logs/cat.json', b);
    assert.equal(archiveUncompressedBytes(new AdmZip(zip.toBuffer())), a.length + b.length);
});

test('merge: rejects an archive that declares more than the uncompressed cap', async () => {
    const store = new MemorySyncStorage();
    const normal = archive({Alice: {bob: [msg(1_700_000_000, 0, 'Bob', 'hi')]}});
    // Each entry now declares ~2.4 GiB uncompressed while the real data stays tiny.
    const oversized = inflateDeclaredSizes(normal, 0x90000000);
    assert.ok(archiveUncompressedBytes(new AdmZip(Buffer.from(oversized))) > SYNC_MAX_UNCOMPRESSED_BYTES);

    await assert.rejects(mergeLogs(oversized, store), (e: unknown) =>
        e instanceof ArchiveTooLargeError && e.direction === 'incoming');
    // Rejected before decompressing or merging anything.
    assert.equal(store.writeCount, 0);
    assert.deepEqual(await store.allMessages('Alice', 'bob'), []);
});

test('merge: a normal archive under the cap still merges', async () => {
    const store = new MemorySyncStorage();
    const zip = archive({Alice: {bob: [msg(1_700_000_000, 0, 'Bob', 'hi')]}});
    assert.ok(archiveUncompressedBytes(new AdmZip(Buffer.from(zip))) <= SYNC_MAX_UNCOMPRESSED_BYTES);
    assert.equal((await mergeLogs(zip, store)).messagesAdded, 1);
});

test('buildSyncArchive: rejects when the built archive exceeds the body cap', async () => {
    const store = new MemorySyncStorage();
    await store.seed('Alice', 'bob', 'Bob', [msg(1_700_000_000, 0, 'Bob', 'hi')]);
    // A tiny cap stands in for the 512 MiB limit; building a real 512 MiB buffer is impractical.
    await assert.rejects(buildSyncArchive(store, 10), (e: unknown) =>
        e instanceof ArchiveTooLargeError && e.direction === 'outgoing');
    // The default cap leaves a normal archive well within bounds.
    assert.ok((await buildSyncArchive(store)).length > 0);
});
