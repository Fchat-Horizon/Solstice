/**
 * Merging one conversation without ever holding it.
 *
 * The obvious merge reads a conversation whole, unions the incoming messages into
 * it and writes it back. That costs about twice the file's size in JavaScript
 * objects, which is fine for the 700 KB conversation and fatal for the 300 MB one:
 * the batch budget bounds how much arrives per batch but says nothing about how
 * much is already stored, so a single large conversation was the one remaining way
 * a sync could run a phone out of memory.
 *
 * The `.idx` already partitions a conversation by UTC day, and a day of chat is
 * small even for a relentless channel. So everything here works a day at a time:
 *
 *   - `scanLog` walks the data file in windows, decoding no text at all, and
 *     produces the day table plus whether the file is damaged. Peak cost is one
 *     window, not one conversation.
 *   - An append, which is what an ordinary sync does because the desktop's messages
 *     are newer than ours, writes only the new records and rewrites the (tiny)
 *     index. Nothing existing is read or re-encoded.
 *   - Anything else is a rewrite, streamed day by day into a scratch file that
 *     replaces the log when it is complete. Peak cost is the largest single day.
 *
 * The day table is rebuilt by scanning rather than trusted from the stored `.idx`,
 * because a stale index is a real failure mode (Horizon ships an env switch to
 * assert against exactly that) and merging against wrong offsets would corrupt a
 * log rather than merely mis-display it.
 */

import {
    buildIndexFromDays, dayOf, mergeMessages, readBinaryLog, recordBytes, scanRecords, serializeMessages
} from './logMessage.ts';
import type {LogDay, LogMessage} from './logMessage.ts';
import type {SyncStorage} from './storage.ts';

/** How much of a data file to read at once while scanning. Bounds peak memory. */
const SCAN_WINDOW = 4 * 1024 * 1024;

/** What one streaming pass over a conversation's data file establishes. */
export interface LogScan {
    /** Byte offset in the data file where each UTC day's records begin. */
    days: LogDay[];
    /** Total size of the data file. */
    size: number;
    /**
     * True when the file ends mid-record or holds a corrupt one. Protocol merge
     * rule 4: such a conversation is skipped whole and never rewritten.
     */
    damaged: boolean;
    /** Timestamp of the last stored record, or -1 when the file is empty. */
    lastTime: number;
}

/**
 * Walk a conversation's data file once, building its day table and checking every
 * record's framing. Reads in windows, decodes nothing, and holds no messages.
 */
export async function scanLog(store: SyncStorage, character: string, key: string): Promise<LogScan> {
    const size = await store.rawLogSize(character, key);
    const days: LogDay[] = [];
    let lastDay = -1;
    let lastTime = -1;
    let pos = 0;
    while(pos < size) {
        const window = await store.readRawLog(character, key, pos, Math.min(SCAN_WINDOW, size - pos));
        const base = pos;
        const result = scanRecords(window, (time, offset) => {
            const day = dayOf(time);
            if(day !== lastDay) {
                days.push({day, offset: base + offset});
                lastDay = day;
            }
            lastTime = time;
        });
        if(result.damaged) return {days, size, damaged: true, lastTime};
        // A window that yields nothing cannot be resumed past, so the file ends in a
        // record too short to be one. That is truncation, which is damage.
        if(result.nextOffset === 0) return {days, size, damaged: true, lastTime};
        pos += result.nextOffset;
    }
    return {days, size, damaged: pos !== size, lastTime};
}

/** The byte range one day occupies, given the table and the file size. */
function dayRange(scan: LogScan, at: number): {offset: number, length: number} {
    const start = scan.days[at].offset;
    const end = at + 1 < scan.days.length ? scan.days[at + 1].offset : scan.size;
    return {offset: start, length: Math.max(0, end - start)};
}

/** Incoming messages bucketed by the UTC day they belong to. */
function byDay(messages: ReadonlyArray<LogMessage>): Map<number, LogMessage[]> {
    const buckets = new Map<number, LogMessage[]>();
    for(const message of messages) {
        const day = dayOf(message.time);
        const bucket = buckets.get(day);
        if(bucket === undefined) buckets.set(day, [message]);
        else bucket.push(message);
    }
    return buckets;
}

/** Extend a day table with records appended at `from`, returning the new end offset. */
function extendDays(days: LogDay[], from: number, messages: ReadonlyArray<LogMessage>): number {
    let lastDay = days.length > 0 ? days[days.length - 1].day : -1;
    let at = from;
    for(const message of messages) {
        const day = dayOf(message.time);
        if(day !== lastDay) {
            days.push({day, offset: at});
            lastDay = day;
        }
        at += recordBytes(message);
    }
    return at;
}

/**
 * Merge `incoming` into one conversation, updating `scan` in place to describe the
 * result so a later batch of the same conversation resumes without rescanning.
 * Returns how many messages were actually new. The caller must have checked
 * `scan.damaged` first; a damaged conversation is never written.
 */
export async function mergeConversation(
    store: SyncStorage, character: string, key: string, name: string,
    incoming: ReadonlyArray<LogMessage>, scan: LogScan
): Promise<number> {
    // Sorted and self-deduplicated, and dropping anything malformed, so both paths
    // below can assume a clean ascending run.
    const {merged: clean} = mergeMessages([], incoming);
    if(clean.length === 0) return 0;

    // The ordinary case: everything arriving is newer than everything stored, so no
    // existing record can be a duplicate and none has to move. Write only the tail.
    if(clean[0].time > scan.lastTime) {
        await store.markSendPrefix(character, key, scan.size);
        const end = extendDays(scan.days, scan.size, clean);
        await store.appendToLog(
            character, key, serializeMessages(clean), buildIndexFromDays(name, scan.days));
        scan.size = end;
        scan.lastTime = clean[clean.length - 1].time;
        return clean.length;
    }

    // Otherwise the incoming run interleaves with stored days, so the file has to be
    // rebuilt. The scratch is built first and the live log is only replaced once
    // something turned out to be new, which keeps a re-merge of already-stored
    // messages a no-op rather than a pointless rewrite.
    await store.beginRewrite(character, key);

    const buckets = byDay(clean);
    const storedDays = scan.days.map((entry) => entry.day);
    const allDays = Array.from(new Set([...storedDays, ...buckets.keys()])).sort((a, b) => a - b);
    const rebuilt: LogDay[] = [];
    let at = 0;
    let added = 0;
    let lastTime = -1;
    try {
        for(const day of allDays) {
            const index = storedDays.indexOf(day);
            let stored: LogMessage[] = [];
            if(index >= 0) {
                const {offset, length} = dayRange(scan, index);
                stored = readBinaryLog(await store.readRawLog(character, key, offset, length)).messages;
            }
            const result = mergeMessages(stored, buckets.get(day) ?? []);
            added += result.added.length;
            if(result.merged.length === 0) continue;
            const bytes = serializeMessages(result.merged);
            rebuilt.push({day, offset: at});
            at += bytes.length;
            lastTime = result.merged[result.merged.length - 1].time;
            await store.appendRewrite(character, key, bytes);
        }
        if(added === 0) {
            await store.discardRewrite(character, key);
            return 0;
        }
        // Freeze what the upload owes before the offsets move under it.
        await store.materializeSendSnapshot(character, key);
        await store.commitRewrite(character, key, buildIndexFromDays(name, rebuilt));
    } catch(error) {
        await store.discardRewrite(character, key);
        throw error;
    }
    scan.days = rebuilt;
    scan.size = at;
    scan.lastTime = lastTime;
    return added;
}
