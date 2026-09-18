/**
 * Reads and writes the sync zip (the Horizon export format restricted to logs)
 * and merges it into the local store with the protocol's message-level union
 * semantics. This is the one code path shared by the device sync transfer and
 * the backup-zip importer, so re-importing or re-syncing the same logs adds
 * nothing. TypeScript port of Luna's `LogArchive`. Layout:
 *
 *   manifest.json                              { version:2, app, includes{...}, characters[] }
 *   sync-batch.json                            { index, done, cursor } (batched transfers only)
 *   characters/<Character>/logs/<key>.json     a JSON array of {time,type,sender,text}
 *   characters/<Character>/logs-names.json     { "<key>": "<display name>" } (optional, cosmetic)
 *
 * Both directions work one bounded batch at a time (Horizon repo issue #958), so
 * neither side ever holds the whole log set in memory. On the receive side that is
 * `SyncMerge`, which carries one open conversation across batch boundaries; on the
 * send side it is `buildSyncBatch`, which resumes from a byte position.
 */

import AdmZip from 'adm-zip';
import {isFilesystemArtifact, mergeMessages} from './logMessage.ts';
import type {LogMessage} from './logMessage.ts';
import {
    SYNC_BATCH_ENTRY, SYNC_BATCH_MAX_RECORDS, SYNC_BATCH_TARGET_BYTES, SYNC_MAX_BODY_BYTES,
    SYNC_MAX_UNCOMPRESSED_BYTES
} from './payload.ts';
import type {SyncBatchInfo} from './payload.ts';
import type {SyncStorage} from './storage.ts';
import {createZipWriter} from './zipWriter.ts';

/**
 * Thrown when an archive exceeds one of the sync size caps (Horizon repo issue
 * #931). `direction` says which bound: `incoming` for a received archive that
 * declares more than `SYNC_MAX_UNCOMPRESSED_BYTES` uncompressed, `outgoing` for
 * an archive we built that exceeds `SYNC_MAX_BODY_BYTES` compressed. Retrying the
 * same logs never helps, so the client surfaces it as a non-retryable error.
 */
export class ArchiveTooLargeError extends Error {
    readonly direction: 'incoming' | 'outgoing';
    constructor(direction: 'incoming' | 'outgoing') {
        super(`sync archive too large (${direction})`);
        this.name = 'ArchiveTooLargeError';
        this.direction = direction;
    }
}

/**
 * Total declared uncompressed size of every entry in a sync zip. AdmZip
 * allocates each entry's decompressed buffer from this header value, so the sum
 * bounds the memory `mergeLogs` will allocate. Read from the central directory,
 * so it is available before any entry is decompressed (mirrors Horizon).
 */
export function archiveUncompressedBytes(zip: AdmZip): number {
    let total = 0;
    for(const entry of zip.getEntries()) total += entry.header.size;
    return total;
}

/**
 * Result of merging an archive into the local store. Field names match the sync
 * protocol's merge summary (the `POST /v1/logs` response), so the desktop's
 * reply decodes into this shape too.
 *
 * Across a batched transfer these are session totals, not per-batch sums: only
 * `messagesAdded` is additive. A conversation created by one batch and extended
 * by the next is one creation, a character touched by every batch is one
 * character, and a damaged conversation refused by thirty batches is reported
 * once. `SyncMerge` unions by conversation identity to get that, mirroring
 * Horizon's `recordMerge`.
 */
export interface MergeStats {
    conversationsCreated: number;
    conversationsUpdated: number;
    messagesAdded: number;
    charactersTouched: number;
    /** Damaged local conversations left untouched; the user must run Fix Logs. */
    conversationsSkipped: number;
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

/**
 * Order by UTF-16 code unit, which is what `<` and `>` compare. The send side
 * enumerates characters and conversation keys in this order and resumes with the
 * same comparison, and the two have to agree: `localeCompare` does not order the
 * same way `>=` does, so mixing them would skip or repeat conversations across a
 * batch boundary. Client-internal, invisible on the wire.
 */
function byCodeUnit(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
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
 * The batch envelope of a received archive, or undefined when it carries none.
 * Absence is meaningful: it is how a Horizon that predates batching answers a
 * `?cursor=` request, and it means the archive holds the whole log set.
 */
function readBatchInfo(entries: AdmZip.IZipEntry[]): SyncBatchInfo | undefined {
    for(const entry of entries) {
        if(entry.isDirectory) continue;
        const segments = pathSegments(entry.entryName);
        if(segments.length !== 1 || segments[0] !== SYNC_BATCH_ENTRY) continue;
        try {
            const parsed: unknown = JSON.parse(entry.getData().toString('utf8'));
            if(parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
            const wire = parsed as {index?: unknown, done?: unknown, cursor?: unknown};
            return {
                index: typeof wire.index === 'number' && Number.isInteger(wire.index) ? wire.index : 0,
                done: wire.done === true,
                cursor: typeof wire.cursor === 'string' && wire.cursor.length > 0 ? wire.cursor : undefined
            };
        } catch {
            // A malformed envelope is treated as none, which stops the cursor loop
            // rather than following a cursor we cannot trust.
            return undefined;
        }
    }
    return undefined;
}

/**
 * A received archive, opened far enough to know where the transfer goes next but
 * not yet merged. The split is what lets the client put the request for the next
 * batch on the wire before merging this one: the envelope is a single tiny entry
 * while the merge is the expensive half, so the desktop builds and sends the next
 * batch during time this device was going to spend anyway.
 */
export interface OpenedSyncBatch {
    readonly entries: AdmZip.IZipEntry[];
    /** This archive's batch envelope, or undefined when it carries none. */
    readonly info: SyncBatchInfo | undefined;
}

/**
 * Read an archive's central directory, enforce the uncompressed cap and take its
 * batch envelope, without decompressing any conversation.
 */
export function openSyncBatch(zipData: Uint8Array): OpenedSyncBatch {
    const zip = new AdmZip(Buffer.from(zipData));
    const entries = zip.getEntries();
    // A compressed zip can inflate far past the encrypted body cap. Reject before
    // decompressing anything (the merge below reads entry data), using the
    // central-directory sizes AdmZip would allocate from.
    if(archiveUncompressedBytes(zip) > SYNC_MAX_UNCOMPRESSED_BYTES) throw new ArchiveTooLargeError('incoming');
    return {entries, info: readBatchInfo(entries)};
}

/** A conversation held open across batches, written once when a later batch moves past it. */
interface PendingConversation {
    character: string;
    key: string;
    identity: string;
    displayName: string;
    /** Pre-merge local content, frozen as the send snapshot at flush time. */
    existing: LogMessage[];
    merged: LogMessage[];
    added: number;
    existed: boolean;
}

/**
 * A merge session spanning one or more archives. Each batch is a complete sync
 * zip, and a conversation too large for one batch arrives as the same entry path
 * in consecutive batches with an ascending run of messages.
 *
 * The native bridge has no append and no offset write, only whole-file writes, so
 * this does not follow Horizon's in-place extension. Instead it defers: a
 * conversation's added messages accumulate in memory across batches and are
 * written once, when a later batch moves past it. Slices arrive in a total order,
 * so only one conversation is ever open, and each conversation costs one read and
 * one write per session. A conversation that reappeared out of order would still
 * merge correctly, just with a second write.
 */
export class SyncMerge {
    private readonly store: SyncStorage;
    private readonly indexCache = new Map<string, {[key: string]: {name: string}}>();
    private readonly created = new Set<string>();
    private readonly updated = new Set<string>();
    private readonly skipped = new Set<string>();
    private readonly characters = new Set<string>();
    private messagesAdded = 0;
    private pending: PendingConversation | undefined = undefined;

    constructor(store: SyncStorage) { this.store = store; }

    /**
     * Merge one archive, returning its batch envelope (undefined when it carries
     * none, i.e. the peer sent the whole log set in one archive). The client opens
     * the archive itself so it can request the next batch first; this is the whole
     * step, for callers with nothing to overlap.
     */
    async mergeBatch(zipData: Uint8Array): Promise<SyncBatchInfo | undefined> {
        const opened = openSyncBatch(zipData);
        await this.merge(opened);
        return opened.info;
    }

    /** Merge an archive already opened by `openSyncBatch`. */
    async merge(opened: OpenedSyncBatch): Promise<void> {
        const entries = opened.entries;
        const names = displayNames(entries);

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
            // A peer that did not screen its log dir can ship Thumbs.db/desktop.ini as a
            // `.json` entry; never materialize filesystem litter as a conversation.
            if(isFilesystemArtifact(key)) continue;

            const identity = `${character}/${key}`;
            // Already judged damaged: skipped once for the session, not once per batch.
            if(this.skipped.has(identity)) continue;

            let parsed: unknown;
            try {
                parsed = JSON.parse(entry.getData().toString('utf8'));
            } catch {
                continue;
            }
            if(!Array.isArray(parsed)) continue;

            if(this.pending === undefined || this.pending.identity !== identity) {
                await this.flush();
                await this.open(character, key, rawKey, identity, names);
            }
            const pending = this.pending;
            if(pending === undefined) continue;

            const {merged, added} = mergeMessages(pending.merged, parsed as LogMessage[]);
            if(added.length === 0) continue;
            pending.merged = merged;
            pending.added += added.length;
            this.messagesAdded += added.length;
        }
    }

    /** Flush the conversation still held open and return the session totals. */
    async finish(): Promise<MergeStats> {
        await this.flush();
        // Created wins over updated: a conversation this session created and then
        // extended in a later batch is one creation, not a creation plus an update.
        let updated = 0;
        for(const identity of this.updated) if(!this.created.has(identity)) updated++;
        return {
            conversationsCreated: this.created.size,
            conversationsUpdated: updated,
            messagesAdded: this.messagesAdded,
            charactersTouched: this.characters.size,
            conversationsSkipped: this.skipped.size
        };
    }

    private async open(
        character: string, key: string, rawKey: string, identity: string,
        names: {[character: string]: {[key: string]: string}}
    ): Promise<void> {
        const {messages, damaged} = await this.store.readLog(character, key);
        if(damaged) {
            // Protocol merge rule 4: skip the conversation whole and tell the user to
            // run Fix Logs. Writing the parsed prefix back would silently destroy
            // everything stored past the corruption.
            this.skipped.add(identity);
            this.pending = undefined;
            return;
        }
        let index = this.indexCache.get(character);
        if(index === undefined) {
            index = await this.store.loadIndex(character);
            this.indexCache.set(character, index);
        }
        const localName = index[key] !== undefined && index[key].name.length > 0 ? index[key].name : undefined;
        this.pending = {
            character, key, identity,
            // The name is taken once, when the conversation is opened, so a per-batch
            // `logs-names.json` naming only that batch's conversations is enough.
            displayName: localName ?? names[character]?.[key]
                ?? (rawKey.startsWith('#') ? rawKey.slice(1) : rawKey),
            existing: messages,
            merged: messages,
            added: 0,
            existed: index[key] !== undefined || messages.length > 0
        };
    }

    private async flush(): Promise<void> {
        const pending = this.pending;
        this.pending = undefined;
        // Nothing new: the conversation's storage must not be rewritten (idempotent,
        // cheap), and with no rewrite the upload can read the log itself.
        if(pending === undefined || pending.added === 0) return;
        // Freeze what the upload owes Horizon before the log stops being it.
        await this.store.snapshotForSend(pending.character, pending.key, pending.existing);
        await this.store.replaceMessages(pending.character, pending.key, pending.displayName, pending.merged);
        if(pending.existed) this.updated.add(pending.identity); else this.created.add(pending.identity);
        this.characters.add(pending.character);
    }
}

/**
 * Merge one complete sync zip (a backup export, or an unbatched sync download)
 * into `store`. Idempotent: a conversation whose messages are all already present
 * is left untouched.
 */
export async function mergeLogs(zipData: Uint8Array, store: SyncStorage): Promise<MergeStats> {
    const merge = new SyncMerge(store);
    await merge.mergeBatch(zipData);
    return merge.finish();
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
 * Where the next upload batch resumes: a conversation key and a byte offset into
 * its send source. Absent `character` means "start at the first character".
 * Client-private, never serialized, so unlike Horizon's wire cursor it needs no
 * opaque token.
 */
export interface SyncSendPosition {
    character?: string;
    key?: string;
    offset: number;
}

export const SYNC_SEND_START: SyncSendPosition = {offset: 0};

export interface SyncSendBatch {
    zip: Buffer;
    /** Where the next batch resumes, or undefined when the log set is finished. */
    next: SyncSendPosition | undefined;
    conversations: number;
    messages: number;
}

export interface SyncSendOptions {
    /** Uncompressed JSON bytes to target, cut after the record that crosses it. */
    budget?: number;
    maxRecords?: number;
    maxBodyBytes?: number;
    /**
     * Conversation indexes already read this session. `loadIndex` reads every `.idx`
     * in a character's directory to recover display names, so the character a batch
     * resumes inside would otherwise be re-read once per batch. Pass one map across
     * the whole upload to pay for each character once.
     */
    indexCache?: Map<string, {[key: string]: {name: string}}>;
}

/** A character's conversation index, from the session cache when it is already there. */
async function loadIndex(
    store: SyncStorage, character: string, cache: Map<string, {[key: string]: {name: string}}>
): Promise<{[key: string]: {name: string}}> {
    let index = cache.get(character);
    if(index === undefined) {
        index = await store.loadIndex(character);
        cache.set(character, index);
    }
    return index;
}

/** True when two positions name the same place, so a loop can refuse to spin. */
export function samePosition(a: SyncSendPosition, b: SyncSendPosition): boolean {
    return a.character === b.character && a.key === b.key && a.offset === b.offset;
}

/**
 * Build one bounded batch of the outgoing sync zip, resuming from `start`. An
 * empty store is not an error: a fresh device legitimately sends a manifest-only
 * archive.
 *
 * Conversations are read through their send source (see `SyncStorage`), so a
 * conversation the download rewrote contributes the content this device held
 * before the merge rather than echoing the desktop's own messages back at it.
 *
 * A conversation larger than one batch simply spans several, carrying the same
 * entry path in each with an ascending run of messages; the receiver's merge is a
 * union, so the pieces reassemble with no extra protocol machinery.
 */
export async function buildSyncBatch(
    store: SyncStorage, start: SyncSendPosition = SYNC_SEND_START, options: SyncSendOptions = {}
): Promise<SyncSendBatch> {
    const budget = options.budget ?? SYNC_BATCH_TARGET_BYTES;
    const maxRecords = options.maxRecords ?? SYNC_BATCH_MAX_RECORDS;
    const maxBodyBytes = options.maxBodyBytes ?? SYNC_MAX_BODY_BYTES;
    const indexCache = options.indexCache ?? new Map<string, {[key: string]: {name: string}}>();

    const characters = (await store.getCharacters()).sort(byCodeUnit);
    const entries: Array<{name: string, text: string}> = [];
    const included: string[] = [];
    let remaining = budget;
    let records = maxRecords;
    let next: SyncSendPosition | undefined = undefined;
    let conversations = 0;
    let messages = 0;

    for(const character of characters) {
        if(start.character !== undefined && byCodeUnit(character, start.character) < 0) continue;
        const index = await loadIndex(store, character, indexCache);
        const names: {[key: string]: string} = {};
        let any = false;
        let stop = false;
        for(const key of Object.keys(index).sort(byCodeUnit)) {
            if(character === start.character && start.key !== undefined && byCodeUnit(key, start.key) < 0) continue;
            const offset = character === start.character && key === start.key ? start.offset : 0;
            const slice = await store.messagesFrom(character, key, offset, remaining, records);
            if(slice.messages.length > 0) {
                entries.push({
                    name: `characters/${character}/logs/${key}.json`,
                    text: JSON.stringify(slice.messages)
                });
                const name = index[key].name;
                if(name.length > 0) names[key] = name;
                any = true;
                conversations++;
                messages += slice.messages.length;
                remaining -= slice.jsonBytes;
                records -= slice.messages.length;
            }
            // Stopping mid-conversation means the budget ran out inside it. Stopping at
            // its end with nothing left means the next batch starts after it; the
            // recorded offset is then the source's end, so resuming re-reads nothing.
            if(!slice.atEof || remaining <= 0 || records <= 0) {
                next = {character, key, offset: slice.nextOffset};
                stop = true;
                break;
            }
        }
        if(any) {
            const sorted: {[key: string]: string} = {};
            for(const key of Object.keys(names).sort(byCodeUnit)) sorted[key] = names[key];
            // Names cover only this batch's conversations: the receiver takes a
            // conversation's display name when it creates it and never revisits it,
            // so a name shipped in a later batch would arrive too late to be used.
            entries.push({
                name: `characters/${character}/logs-names.json`,
                text: JSON.stringify(sorted)
            });
            included.push(character);
        }
        if(stop) break;
    }

    const zip = await createZipWriter();
    // The manifest describes this batch alone.
    await zip.add('manifest.json', JSON.stringify(manifest(included, entries.length), null, 2));
    for(const entry of entries) await zip.add(entry.name, entry.text);
    const buffer = await zip.finish();
    // Bound the outgoing upload to the same compressed body cap Horizon enforces. At
    // the batch budget this can no longer fire, which is the point: the cap used to
    // be checked only after the whole log set had already been built in memory.
    if(buffer.length > maxBodyBytes) throw new ArchiveTooLargeError('outgoing');
    return {zip: buffer, next, conversations, messages};
}
