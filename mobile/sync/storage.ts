/**
 * The slice of the local log store the sync merge and upload builder need. This
 * is the seam that keeps `archive.ts` and `client.ts` pure and testable: the app
 * injects `NativeSyncStorage` (backed by the `NativeFile` bridge), the tests
 * inject an in-memory store. Mirrors the operations Luna's `ChatLogStore`
 * exposes to `LogArchive`.
 *
 * The upload reads through a second view of each conversation, its *send source*:
 * the send snapshot taken before the merge rewrote the log, or the log itself when
 * no snapshot was taken. Batching forces the download to merge before the upload
 * is built (a cursor is a position in the desktop's files, so the two directions
 * cannot interleave), and without that view the upload would echo back everything
 * the download just merged in.
 */

import type {LogMessage, LogSlice, StoredLog} from './logMessage.ts';

export interface SyncStorage {
    /** Characters that have a log directory. */
    getCharacters(): Promise<string[]>;
    /** Conversation keys present for a character, each with its display name. */
    loadIndex(character: string): Promise<{[key: string]: {name: string}}>;
    /**
     * Every message in a conversation's data file, in stored (time-ascending)
     * order, plus whether the file is damaged. A damaged conversation must be left
     * alone: rewriting its parsed prefix would drop everything past the corruption.
     */
    readLog(character: string, key: string): Promise<StoredLog>;
    /**
     * Replace a conversation's log with `messages`, rewriting the data file and
     * `.idx`. Only called when there is something new to write.
     */
    replaceMessages(character: string, key: string, name: string, messages: LogMessage[]): Promise<void>;

    /** Byte length of the conversation's send source, or 0 when there is nothing to send. */
    logSize(character: string, key: string): Promise<number>;
    /**
     * A bounded ascending slice of the conversation's send source, resuming at
     * `byteOffset`. See `sliceLog`, which defines the budget and cut semantics.
     */
    messagesFrom(
        character: string, key: string, byteOffset: number, maxJsonBytes: number, maxRecords: number
    ): Promise<LogSlice>;
    /** Drop every send snapshot and rewrite scratch, including any an interrupted session left. */
    clearSendSnapshots(): Promise<void>;

    // The streamed merge (`mergeStream.ts`) drives the rest. All of it works in
    // bounded pieces so a conversation is never held whole, which is the difference
    // between syncing a 300 MB conversation and running the phone out of memory.

    /** Byte length of the conversation's live data file, 0 when there is none. */
    rawLogSize(character: string, key: string): Promise<number>;
    /** Raw record bytes from the live data file. Short reads at the end are fine. */
    readRawLog(character: string, key: string, offset: number, length: number): Promise<Uint8Array>;

    /**
     * Record that the upload owes the first `prefix` bytes of the live log, which is
     * everything it held before this session touched it. Does nothing when a snapshot
     * is already recorded, so the first batch to reach a conversation defines it and
     * later ones cannot widen it to include what they just merged in.
     *
     * A marker rather than a copy: an append leaves the earlier bytes exactly where
     * they were, so there is nothing to duplicate. A prefix of 0 is meaningful and
     * must be recorded, since it says the conversation is new on this device and the
     * upload must not send it back at all.
     */
    markSendPrefix(character: string, key: string, prefix: number): Promise<void>;
    /**
     * Turn a prefix marker into a literal copy of those bytes, because a rewrite is
     * about to move them. Streamed, never held whole. A no-op once the snapshot is
     * already literal.
     */
    materializeSendSnapshot(character: string, key: string): Promise<void>;

    /** Append records to the live data file and replace the `.idx` with `index`. */
    appendToLog(character: string, key: string, records: Uint8Array, index: Uint8Array): Promise<void>;

    /** Start a rewrite: open an empty scratch file for this conversation. */
    beginRewrite(character: string, key: string): Promise<void>;
    /** Append records to the open scratch file. */
    appendRewrite(character: string, key: string, records: Uint8Array): Promise<void>;
    /** Replace the live data file with the scratch and write `index`. */
    commitRewrite(character: string, key: string, index: Uint8Array): Promise<void>;
    /** Abandon the scratch file, leaving the live data file untouched. */
    discardRewrite(character: string, key: string): Promise<void>;
}
