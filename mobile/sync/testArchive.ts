/**
 * Test-only builders shared by the merge, client and batch suites. Not imported
 * by any production code.
 */

import AdmZip from 'adm-zip';
import {buildSyncBatch, SYNC_SEND_START} from './archive.ts';
import type {SyncSendOptions, SyncSendPosition} from './archive.ts';
import type {LogMessage} from './logMessage.ts';
import type {SyncStorage} from './storage.ts';

export function msg(time: number, type: number, sender: string, text: string): LogMessage {
    return {time, type, sender, text};
}

/** Build a sync archive with the given per-character/key message lists and optional names. */
export function archive(
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

/** No budget and no record limit, so one batch holds the whole store. */
export const UNBOUNDED: SyncSendOptions = {
    budget: Number.POSITIVE_INFINITY, maxRecords: Number.POSITIVE_INFINITY
};

/** The whole store as a single archive, the shape an unbatched transfer sends. */
export async function wholeArchive(store: SyncStorage): Promise<Uint8Array> {
    const batch = await buildSyncBatch(store, SYNC_SEND_START, UNBOUNDED);
    if(batch.next !== undefined) throw new Error('an unbounded batch must cover the whole store');
    return new Uint8Array(batch.zip);
}

/** A store's whole contents, for asserting two paths reach the same place. */
export async function dumpStore(
    store: SyncStorage
): Promise<{[character: string]: {[key: string]: {name: string, messages: LogMessage[]}}}> {
    const dump: {[character: string]: {[key: string]: {name: string, messages: LogMessage[]}}} = {};
    for(const character of await store.getCharacters()) {
        const index = await store.loadIndex(character);
        const conversations: {[key: string]: {name: string, messages: LogMessage[]}} = {};
        for(const key of Object.keys(index).sort())
            conversations[key] = {name: index[key].name, messages: (await store.readLog(character, key)).messages};
        dump[character] = conversations;
    }
    return dump;
}

/** Every batch a bounded build produces, in order, as a test peer would serve them. */
export async function allBatches(
    store: SyncStorage, options: SyncSendOptions, limit = 512
): Promise<Uint8Array[]> {
    const batches: Uint8Array[] = [];
    let position: SyncSendPosition = SYNC_SEND_START;
    for(let i = 0; i < limit; i++) {
        const batch = await buildSyncBatch(store, position, options);
        batches.push(new Uint8Array(batch.zip));
        if(batch.next === undefined) return batches;
        position = batch.next;
    }
    throw new Error('the batch builder did not finish');
}
