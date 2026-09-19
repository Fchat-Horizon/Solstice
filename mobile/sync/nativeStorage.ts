/**
 * `SyncStorage` backed by the `NativeFile` bridge (declared in
 * `mobile/filesystem.ts`), i.e. the real on-device log files under
 * `<character>/logs/`. Reads whole data files in 4 MB chunks (the same guard the
 * zip importer uses to avoid a giant base64 string through the bridge) and
 * writes the binary data + `.idx` back as base64. Both directions go through
 * `bytes.ts`: a merge rewrites every conversation it touches, so the write side
 * converts as many bytes as the read side does. Production only: the tests use
 * `MemorySyncStorage` instead, so this file is never loaded under `node --test`.
 *
 * Send snapshots live beside each conversation as `<key>.syncsend`. The bridge has
 * no append and no offset write, only whole-file writes, so a snapshot is the one
 * way to keep the pre-merge content the upload owes Horizon once the merge has
 * rewritten the log.
 */

import {
    buildLogIndex, isFilesystemArtifact, MAX_RECORD_BYTES, readBinaryLog, readIndexName,
    serializeMessages, sliceLog
} from './logMessage.ts';
import type {LogMessage, LogSlice, StoredLog} from './logMessage.ts';
import {fromBase64, toBase64} from './bytes.ts';
import type {SyncStorage} from './storage.ts';

const CHUNK = 4 * 1024 * 1024;

const SNAPSHOT_SUFFIX = '.syncsend';
const SCRATCH_SUFFIX = '.syncmerge';
/**
 * A snapshot's leading byte says which of two forms it takes, and also makes an
 * *empty* snapshot ("this conversation is new here, send nothing") distinguishable
 * from no snapshot at all, since `getSize` cannot tell a zero-byte file from a
 * missing one.
 *
 * `LITERAL` is `[1][records]`, a copy of what the log held before the merge, written
 * when a rewrite is about to move those bytes. `PREFIX` is `[2][u32 lo][u32 hi]`,
 * naming a byte length of the live log instead, which is all an append needs: the
 * earlier records are still exactly where they were. The prefix form is the common
 * one and costs nine bytes instead of a copy of the conversation.
 */
const SNAPSHOT_LITERAL = 1;
const SNAPSHOT_PREFIX = 2;
const PREFIX_BYTES = 9;

/** Read a whole file over the bridge, or undefined if it is absent/empty/unreadable. */
async function readFileBytes(path: string): Promise<Uint8Array | undefined> {
    let size: number;
    try {
        size = await NativeFile.getSize(path);
    } catch {
        return undefined;
    }
    if(size <= 0) return undefined;
    return readFileRange(path, 0, size);
}

/** Read `length` bytes from `offset`, in bridge-sized chunks. */
async function readFileRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while(read < length) {
        const chunkLen = Math.min(CHUNK, length - read);
        const b64 = await NativeFile.readBytes(path, offset + read, chunkLen);
        const decoded = fromBase64(b64);
        decoded.copy(buf, read);
        read += decoded.length;
        if(decoded.length === 0) break;
    }
    return read === length ? buf : buf.subarray(0, read);
}

/** Append to a file, falling back to a read-modify-write where the bridge has no append. */
async function appendFile(path: string, bytes: Uint8Array): Promise<void> {
    const append = (NativeFile as {appendBytes?: (n: string, b: string) => Promise<void>}).appendBytes;
    if(append !== undefined) return append.call(NativeFile, path, toBase64(bytes));
    // A host built before `appendBytes` existed still has to work. This is the whole
    // reason the streamed merge exists, so it is slow on purpose rather than wrong:
    // correctness first, and the native path is what makes it bounded.
    const existing = await readFileBytes(path);
    const combined = Buffer.allocUnsafe((existing?.length ?? 0) + bytes.length);
    if(existing !== undefined) combined.set(existing, 0);
    combined.set(bytes, existing?.length ?? 0);
    await NativeFile.writeBytes(path, toBase64(combined));
}

/** Move a file over another, falling back to a copy where the bridge has no rename. */
async function renameFile(from: string, to: string): Promise<void> {
    const rename = (NativeFile as {rename?: (f: string, t: string) => Promise<boolean>}).rename;
    if(rename !== undefined && await rename.call(NativeFile, from, to)) return;
    const bytes = await readFileBytes(from);
    await NativeFile.writeBytes(to, bytes === undefined ? '' : toBase64(bytes));
    try { await NativeFile.delete(from); } catch { /* scratch left behind is harmless */ }
}

async function fileSize(path: string): Promise<number> {
    try {
        const size = await NativeFile.getSize(path);
        return size > 0 ? size : 0;
    } catch {
        return 0;
    }
}

export class NativeSyncStorage implements SyncStorage {
    async getCharacters(): Promise<string[]> {
        let dirs: string[];
        try {
            dirs = await NativeFile.listDirectories('/');
        } catch {
            return [];
        }
        return dirs
            .filter((d) => !d.startsWith('.') && !d.startsWith('!') && d !== 'settings' && d !== 'eicons')
            .sort((a, b) => a.localeCompare(b));
    }

    async loadIndex(character: string): Promise<{[key: string]: {name: string}}> {
        let files: string[];
        try {
            files = await NativeFile.listFiles(`${character}/logs`);
        } catch {
            return {};
        }
        const index: {[key: string]: {name: string}} = {};
        for(const file of files) {
            if(file.endsWith('.idx') || file.endsWith('.syncmerge') || file.endsWith(SNAPSHOT_SUFFIX)
                || isFilesystemArtifact(file)) continue;
            const idx = await readFileBytes(`${character}/logs/${file}.idx`);
            index[file] = {name: (idx !== undefined && readIndexName(idx)) || file};
        }
        return index;
    }

    async readLog(character: string, key: string): Promise<StoredLog> {
        const bytes = await readFileBytes(`${character}/logs/${key}`);
        return bytes === undefined ? {messages: [], damaged: false} : readBinaryLog(bytes);
    }

    async replaceMessages(character: string, key: string, name: string, messages: LogMessage[]): Promise<void> {
        const ordered = messages.slice().sort((a, b) => a.time - b.time);
        await NativeFile.ensureDirectory(`${character}/logs`);
        const data = serializeMessages(ordered);
        const idx = buildLogIndex(name, ordered);
        await NativeFile.writeBytes(`${character}/logs/${key}`, toBase64(data));
        await NativeFile.writeBytes(`${character}/logs/${key}.idx`, toBase64(idx));
    }

    /**
     * Where the upload reads this conversation from: the pre-merge prefix of the live
     * log when a marker names one, a literal snapshot when a rewrite forced a copy,
     * and the log itself when this session has not touched it.
     */
    private async sendSource(character: string, key: string): Promise<{path: string, base: number, size: number}> {
        const log = `${character}/logs/${key}`;
        const snap = log + SNAPSHOT_SUFFIX;
        const snapSize = await fileSize(snap);
        if(snapSize === 0) return {path: log, base: 0, size: await fileSize(log)};
        const head = await readFileRange(snap, 0, Math.min(snapSize, PREFIX_BYTES));
        if(head.length >= PREFIX_BYTES && head[0] === SNAPSHOT_PREFIX) {
            const prefix = head.readUInt32LE(1) + head.readUInt32LE(5) * 0x100000000;
            // Clamp: a log shorter than its marker means something truncated it, and
            // sending past the end is not an option worth taking.
            return {path: log, base: 0, size: Math.min(prefix, await fileSize(log))};
        }
        return {path: snap, base: 1, size: snapSize - 1};
    }

    async logSize(character: string, key: string): Promise<number> {
        return (await this.sendSource(character, key)).size;
    }

    async messagesFrom(
        character: string, key: string, byteOffset: number, maxJsonBytes: number, maxRecords: number
    ): Promise<LogSlice> {
        const {path, base, size} = await this.sendSource(character, key);
        if(byteOffset >= size)
            return {messages: [], jsonBytes: 0, nextOffset: size, atEof: true, damaged: false};
        // One ranged read always suffices: a record's binary size (10 + S + T) is
        // smaller than its JSON size (at least 43 + S + T, and escaping only grows
        // that), so `maxJsonBytes` of budget can never consume more than that many
        // binary bytes, plus the one record allowed to cross it. The window therefore
        // always carries more JSON than the budget, and the slice always stops on the
        // budget before it can reach the window's cut tail.
        const want = Number.isFinite(maxJsonBytes) ? Math.min(maxJsonBytes + MAX_RECORD_BYTES, size - byteOffset)
            : size - byteOffset;
        const window = await readFileRange(path, base + byteOffset, want);
        const slice = sliceLog(window, 0, maxJsonBytes, maxRecords);
        const nextOffset = byteOffset + slice.nextOffset;
        return {
            messages: slice.messages,
            jsonBytes: slice.jsonBytes,
            nextOffset,
            // The window can stop short of the file, which is not end of file. Real
            // damage is: ship the valid prefix and move on, rather than asking to
            // resume at a record that will never parse.
            atEof: slice.damaged || nextOffset >= size,
            damaged: slice.damaged
        };
    }

    async rawLogSize(character: string, key: string): Promise<number> {
        return fileSize(`${character}/logs/${key}`);
    }

    async readRawLog(character: string, key: string, offset: number, length: number): Promise<Uint8Array> {
        return readFileRange(`${character}/logs/${key}`, offset, length);
    }

    async markSendPrefix(character: string, key: string, prefix: number): Promise<void> {
        const snap = `${character}/logs/${key}${SNAPSHOT_SUFFIX}`;
        // Already recorded: the first batch to reach this conversation owns the mark,
        // so a later one cannot widen it to cover what it just merged in.
        if(await fileSize(snap) > 0) return;
        const buf = Buffer.allocUnsafe(PREFIX_BYTES);
        buf[0] = SNAPSHOT_PREFIX;
        buf.writeUInt32LE(prefix >>> 0, 1);
        buf.writeUInt32LE(Math.floor(prefix / 0x100000000), 5);
        await NativeFile.ensureDirectory(`${character}/logs`);
        await NativeFile.writeBytes(snap, toBase64(buf));
    }

    async materializeSendSnapshot(character: string, key: string): Promise<void> {
        const log = `${character}/logs/${key}`;
        const snap = log + SNAPSHOT_SUFFIX;
        const snapSize = await fileSize(snap);
        let prefix: number;
        if(snapSize === 0) prefix = await fileSize(log);
        else {
            const head = await readFileRange(snap, 0, Math.min(snapSize, PREFIX_BYTES));
            if(head.length === 0 || head[0] === SNAPSHOT_LITERAL) return; // already a copy
            prefix = Math.min(
                head.readUInt32LE(1) + head.readUInt32LE(5) * 0x100000000, await fileSize(log));
        }
        await NativeFile.ensureDirectory(`${character}/logs`);
        await NativeFile.writeBytes(snap, toBase64(Buffer.from([SNAPSHOT_LITERAL])));
        for(let at = 0; at < prefix; ) {
            const chunk = await readFileRange(log, at, Math.min(CHUNK, prefix - at));
            if(chunk.length === 0) break;
            await appendFile(snap, chunk);
            at += chunk.length;
        }
    }

    async appendToLog(
        character: string, key: string, records: Uint8Array, index: Uint8Array
    ): Promise<void> {
        await NativeFile.ensureDirectory(`${character}/logs`);
        await appendFile(`${character}/logs/${key}`, records);
        await NativeFile.writeBytes(`${character}/logs/${key}.idx`, toBase64(index));
    }

    async beginRewrite(character: string, key: string): Promise<void> {
        await NativeFile.ensureDirectory(`${character}/logs`);
        await NativeFile.writeBytes(`${character}/logs/${key}${SCRATCH_SUFFIX}`, '');
    }

    async appendRewrite(character: string, key: string, records: Uint8Array): Promise<void> {
        await appendFile(`${character}/logs/${key}${SCRATCH_SUFFIX}`, records);
    }

    async commitRewrite(character: string, key: string, index: Uint8Array): Promise<void> {
        await renameFile(`${character}/logs/${key}${SCRATCH_SUFFIX}`, `${character}/logs/${key}`);
        await NativeFile.writeBytes(`${character}/logs/${key}.idx`, toBase64(index));
    }

    async discardRewrite(character: string, key: string): Promise<void> {
        try {
            await NativeFile.delete(`${character}/logs/${key}${SCRATCH_SUFFIX}`);
        } catch {
            // The live log was never touched, so an orphan scratch is only clutter and
            // the next session's sweep removes it.
        }
    }

    async clearSendSnapshots(): Promise<void> {
        for(const character of await this.getCharacters()) {
            let files: string[];
            try {
                files = await NativeFile.listFiles(`${character}/logs`);
            } catch {
                continue;
            }
            for(const file of files) {
                if(!file.endsWith(SNAPSHOT_SUFFIX) && !file.endsWith(SCRATCH_SUFFIX)) continue;
                try {
                    await NativeFile.delete(`${character}/logs/${file}`);
                } catch {
                    // A snapshot we cannot delete is stale, not dangerous: it only
                    // ever makes the next upload send slightly older content, and an
                    // orphan scratch is never read.
                }
            }
        }
    }
}
