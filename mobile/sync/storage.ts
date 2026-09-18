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
    /**
     * Freeze `messages` as what the upload should send for this conversation,
     * before the merge rewrites its log. An empty snapshot is meaningful and must
     * be recorded: it says the conversation is new on this device, so the upload
     * must not send it back at all.
     */
    snapshotForSend(character: string, key: string, messages: ReadonlyArray<LogMessage>): Promise<void>;
    /** Drop every send snapshot, including any left behind by an interrupted session. */
    clearSendSnapshots(): Promise<void>;
}
