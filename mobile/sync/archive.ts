/**
 * Reads and writes the sync zip (the Horizon export format restricted to logs)
 * and merges it into the local store with the protocol's message-level union
 * semantics. This is the one code path shared by the device sync transfer and
 * the backup-zip importer, so re-importing or re-syncing the same logs adds
 * nothing. TypeScript port of Luna's `LogArchive`. Layout:
 *
 *   manifest.json                              { version:2, app, includes{...}, characters[] }
 *   characters/<Character>/logs/<key>.json     a JSON array of {time,type,sender,text}
 *   characters/<Character>/logs-names.json     { "<key>": "<display name>" } (optional, cosmetic)
 */

import AdmZip from 'adm-zip';
import {mergeMessages} from './logMessage.ts';
import type {LogMessage} from './logMessage.ts';
import type {SyncStorage} from './storage.ts';

/**
 * Result of merging an archive into the local store. Field names match the sync
 * protocol's merge summary (the `POST /v1/logs` response), so the desktop's
 * reply decodes into this shape too.
 */
export interface MergeStats {
    conversationsCreated: number;
    conversationsUpdated: number;
    messagesAdded: number;
    charactersTouched: number;
}

interface ExportManifest {
    version: number;
    createdAt: string;
    app: string;
    expectedFiles: number;
    characters: string[];
    includes: {
        generalSettings: boolean;
        logs: boolean;
        drafts: boolean;
        characterSettings: boolean;
        pinned: boolean;
        eicons: boolean;
        recents: boolean;
        hidden: boolean;
        jsonLogs: boolean;
    };
}

function pathSegments(name: string): string[] {
    return name.replace(/\\/g, '/').split('/');
}

/**
 * A character or key segment from an untrusted archive must be a plain file
 * name, so it cannot escape the store's directory (mirrors the reference guard).
 */
function isSafeSegment(segment: string): boolean {
    return segment.length > 0 && Buffer.byteLength(segment, 'utf8') <= 255
        && !segment.startsWith('.') && !segment.includes('\0');
}

/** Display names per character from the optional `logs-names.json` entries (keys lowercased). */
function displayNames(entries: AdmZip.IZipEntry[]): {[character: string]: {[key: string]: string}} {
    const result: {[character: string]: {[key: string]: string}} = {};
    for(const entry of entries) {
        if(entry.isDirectory) continue;
        const segments = pathSegments(entry.entryName);
        if(segments.length !== 3 || segments[0] !== 'characters' || segments[2] !== 'logs-names.json') continue;
        if(!isSafeSegment(segments[1])) continue;
        try {
            const parsed: unknown = JSON.parse(entry.getData().toString('utf8'));
            if(parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            const names: {[key: string]: string} = {};
            for(const [key, value] of Object.entries(parsed))
                if(typeof value === 'string' && value.length > 0) names[key.toLowerCase()] = value;
            result[segments[1]] = names;
        } catch {
            // Names are cosmetic; a malformed names file never fails the merge.
        }
    }
    return result;
}

/**
 * Merge a sync zip (the device sync's downloaded archive, or a backup export)
 * into `store`. Idempotent: a conversation whose messages are all already
 * present is left untouched.
 */
export async function mergeLogs(zipData: Uint8Array, store: SyncStorage): Promise<MergeStats> {
    const zip = new AdmZip(Buffer.from(zipData));
    const entries = zip.getEntries();
    const names = displayNames(entries);
    const stats: MergeStats = {
        conversationsCreated: 0, conversationsUpdated: 0, messagesAdded: 0, charactersTouched: 0
    };
    const touched = new Set<string>();
    const indexCache = new Map<string, {[key: string]: {name: string}}>();

    for(const entry of entries) {
        if(entry.isDirectory) continue;
        const segments = pathSegments(entry.entryName);
        if(segments.length !== 4 || segments[0] !== 'characters' || segments[2] !== 'logs'
            || !segments[3].endsWith('.json')) continue;
        const character = segments[1];
        const rawKey = segments[3].slice(0, -'.json'.length);
        // Keys are lowercased so mixed-case keys merge into their canonical conversation.
        const key = rawKey.toLowerCase();
        if(!isSafeSegment(character) || !isSafeSegment(key) || key.endsWith('.idx')) continue;
        if(character === 'settings' || character === 'eicons') continue;

        let parsed: unknown;
        try {
            parsed = JSON.parse(entry.getData().toString('utf8'));
        } catch {
            continue;
        }
        if(!Array.isArray(parsed)) continue;

        const existing = await store.allMessages(character, key);
        const {merged, added} = mergeMessages(existing, parsed as LogMessage[]);
        // Nothing new: the conversation's storage must not be rewritten (idempotent, cheap).
        if(added.length === 0) continue;

        let index = indexCache.get(character);
        if(index === undefined) {
            index = await store.loadIndex(character);
            indexCache.set(character, index);
        }
        const existed = index[key] !== undefined || existing.length > 0;
        const localName = index[key] !== undefined && index[key].name.length > 0 ? index[key].name : undefined;
        const displayName = localName ?? names[character]?.[key]
            ?? (rawKey.startsWith('#') ? rawKey.slice(1) : rawKey);
        await store.replaceMessages(character, key, displayName, merged);

        stats.messagesAdded += added.length;
        if(existed) stats.conversationsUpdated++; else stats.conversationsCreated++;
        touched.add(character);
    }

    stats.charactersTouched = touched.size;
    return stats;
}

function manifest(characters: string[], expectedFiles: number): ExportManifest {
    return {
        version: 2,
        createdAt: new Date().toISOString(),
        app: 'horizon',
        expectedFiles,
        characters,
        includes: {
            generalSettings: false, logs: true, drafts: false, characterSettings: false,
            pinned: false, eicons: false, recents: false, hidden: false, jsonLogs: true
        }
    };
}

/**
 * Build the sync zip for every character in `store`, as in-memory bytes (the
 * device sync uploads it as an HTTP body). An empty store is not an error: a
 * fresh device legitimately sends a manifest-only archive.
 */
export async function buildSyncArchive(store: SyncStorage): Promise<Buffer> {
    const characters = await store.getCharacters();
    const entries: Array<{name: string, data: Buffer}> = [];
    const included: string[] = [];

    for(const character of characters) {
        const index = await store.loadIndex(character);
        const names: {[key: string]: string} = {};
        let any = false;
        for(const key of Object.keys(index).sort()) {
            const messages = await store.allMessages(character, key);
            if(messages.length === 0) continue;
            entries.push({
                name: `characters/${character}/logs/${key}.json`,
                data: Buffer.from(JSON.stringify(messages), 'utf8')
            });
            const name = index[key].name;
            if(name.length > 0) names[key] = name;
            any = true;
        }
        if(any) {
            const sortedNames: {[key: string]: string} = {};
            for(const key of Object.keys(names).sort()) sortedNames[key] = names[key];
            entries.push({
                name: `characters/${character}/logs-names.json`,
                data: Buffer.from(JSON.stringify(sortedNames), 'utf8')
            });
            included.push(character);
        }
    }

    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest(included, entries.length), null, 2), 'utf8'));
    for(const entry of entries) zip.addFile(entry.name, entry.data);
    return zip.toBuffer();
}
