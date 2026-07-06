/**
 * `SyncStorage` backed by the `NativeFile` bridge (declared in
 * `mobile/filesystem.ts`), i.e. the real on-device log files under
 * `<character>/logs/`. Reads whole data files in 4 MB chunks (the same guard the
 * zip importer uses to avoid a giant base64 string through the bridge) and
 * writes the binary data + `.idx` back as base64. Production only: the tests use
 * `MemorySyncStorage` instead, so this file is never loaded under `node --test`.
 */

import {buildLogIndex, parseBinaryLog, readIndexName, serializeMessages} from './logMessage.ts';
import type {LogMessage} from './logMessage.ts';
import type {SyncStorage} from './storage.ts';

const CHUNK = 4 * 1024 * 1024;

/** Read a whole file over the bridge, or undefined if it is absent/empty/unreadable. */
async function readFileBytes(path: string): Promise<Uint8Array | undefined> {
    let size: number;
    try {
        size = await NativeFile.getSize(path);
    } catch {
        return undefined;
    }
    if(size <= 0) return undefined;
    const buf = Buffer.allocUnsafe(size);
    let offset = 0;
    while(offset < size) {
        const chunkLen = Math.min(CHUNK, size - offset);
        const b64 = await NativeFile.readBytes(path, offset, chunkLen);
        const decoded = Buffer.from(b64, 'base64');
        decoded.copy(buf, offset);
        offset += decoded.length;
        if(decoded.length === 0) break;
    }
    return buf;
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
            if(file.endsWith('.idx') || file.endsWith('.syncmerge')) continue;
            const idx = await readFileBytes(`${character}/logs/${file}.idx`);
            index[file] = {name: (idx !== undefined && readIndexName(idx)) || file};
        }
        return index;
    }

    async allMessages(character: string, key: string): Promise<LogMessage[]> {
        const bytes = await readFileBytes(`${character}/logs/${key}`);
        return bytes === undefined ? [] : parseBinaryLog(bytes);
    }

    async replaceMessages(character: string, key: string, name: string, messages: LogMessage[]): Promise<void> {
        const ordered = messages.slice().sort((a, b) => a.time - b.time);
        await NativeFile.ensureDirectory(`${character}/logs`);
        const data = serializeMessages(ordered);
        const idx = buildLogIndex(name, ordered);
        await NativeFile.writeBytes(`${character}/logs/${key}`, data.toString('base64'));
        await NativeFile.writeBytes(`${character}/logs/${key}.idx`, idx.toString('base64'));
    }
}
