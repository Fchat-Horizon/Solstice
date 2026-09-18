/**
 * `SyncStorage` backed by the `NativeFile` bridge (declared in
 * `mobile/filesystem.ts`), i.e. the real on-device log files under
 * `<character>/logs/`. Reads whole data files in 4 MB chunks (the same guard the
 * zip importer uses to avoid a giant base64 string through the bridge) and
 * writes the binary data + `.idx` back as base64. Production only: the tests use
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
import {fromBase64} from './bytes.ts';
import type {SyncStorage} from './storage.ts';

const CHUNK = 4 * 1024 * 1024;

const SNAPSHOT_SUFFIX = '.syncsend';
/**
 * A snapshot is `[u8 version][serialized messages]`. The leading byte is what
 * makes an *empty* snapshot ("this conversation is new here, send nothing")
 * distinguishable from no snapshot at all, since `getSize` cannot tell a
 * zero-byte file from a missing one.
 */
const SNAPSHOT_VERSION = 1;

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
        await NativeFile.writeBytes(`${character}/logs/${key}`, data.toString('base64'));
        await NativeFile.writeBytes(`${character}/logs/${key}.idx`, idx.toString('base64'));
    }

    async logSize(character: string, key: string): Promise<number> {
        const snapshot = await fileSize(`${character}/logs/${key}${SNAPSHOT_SUFFIX}`);
        // A snapshot of exactly the version byte is an empty one: nothing to send.
        if(snapshot > 0) return snapshot - 1;
        return fileSize(`${character}/logs/${key}`);
    }

    async messagesFrom(
        character: string, key: string, byteOffset: number, maxJsonBytes: number, maxRecords: number
    ): Promise<LogSlice> {
        const snapshot = await fileSize(`${character}/logs/${key}${SNAPSHOT_SUFFIX}`);
        const path = snapshot > 0 ? `${character}/logs/${key}${SNAPSHOT_SUFFIX}` : `${character}/logs/${key}`;
        // Snapshot offsets are expressed over the messages, so skip the version byte.
        const base = snapshot > 0 ? 1 : 0;
        const size = snapshot > 0 ? snapshot - 1 : await fileSize(path);
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

    async snapshotForSend(character: string, key: string, messages: ReadonlyArray<LogMessage>): Promise<void> {
        const data = serializeMessages(messages);
        const stamped = Buffer.allocUnsafe(data.length + 1);
        stamped[0] = SNAPSHOT_VERSION;
        data.copy(stamped, 1);
        await NativeFile.ensureDirectory(`${character}/logs`);
        await NativeFile.writeBytes(`${character}/logs/${key}${SNAPSHOT_SUFFIX}`, stamped.toString('base64'));
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
                if(!file.endsWith(SNAPSHOT_SUFFIX)) continue;
                try {
                    await NativeFile.delete(`${character}/logs/${file}`);
                } catch {
                    // A snapshot we cannot delete is stale, not dangerous: it only
                    // ever makes the next upload send slightly older content.
                }
            }
        }
    }
}
