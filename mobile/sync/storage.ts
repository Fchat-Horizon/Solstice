/**
 * The slice of the local log store the sync merge and upload builder need. This
 * is the seam that keeps `archive.ts` and `client.ts` pure and testable: the app
 * injects `NativeSyncStorage` (backed by the `NativeFile` bridge), the tests
 * inject an in-memory store. Mirrors the operations Luna's `ChatLogStore`
 * exposes to `LogArchive`.
 */

import type {LogMessage} from './logMessage.ts';

export interface SyncStorage {
    /** Characters that have a log directory. */
    getCharacters(): Promise<string[]>;
    /** Conversation keys present for a character, each with its display name. */
    loadIndex(character: string): Promise<{[key: string]: {name: string}}>;
    /** Every message in a conversation's data file, in stored (time-ascending) order. */
    allMessages(character: string, key: string): Promise<LogMessage[]>;
    /**
     * Replace a conversation's log with `messages`, rewriting the data file and
     * `.idx`. Only called when there is something new to write.
     */
    replaceMessages(character: string, key: string, name: string, messages: LogMessage[]): Promise<void>;
}
