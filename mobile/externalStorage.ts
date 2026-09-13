// External data folder (Settings > Chat): keeps per-character data (logs and character settings) in a
// user-chosen folder so apps like Syncthing can sync it. The native side (Storage.kt on Android,
// DataRoot.swift on iOS) owns the folder and routes every NativeFile/NativeLogs path through it; this
// module normalizes the two bridges and runs the enable/disable flows. The Settings window reaches it
// through window.__externalStorage (set in mobile/chat.ts).
//
// Android's getExternalStatus/copyData/setExternalEnabled return synchronously (JSON is parsed by the
// shim in MainActivity), and pickExternalFolder reports back through window.__externalFolderResult.
// On iOS every call returns a Promise (bridge.js). `await` covers both.

import core from '../chat/core';

export interface ExternalStatus {
    enabled: boolean;
    path: string | null;
    available: boolean;
}

interface PickResult {
    path?: string;
    error?: string;
    cancelled?: boolean;
}

interface CopyResult {
    copied?: number;
    skipped?: number;
    error?: string;
}

interface ExternalBridge {
    getExternalStatus(): ExternalStatus | Promise<ExternalStatus>;
    pickExternalFolder(): void | Promise<PickResult>;
    setExternalEnabled(enabled: boolean): boolean | Promise<boolean>;
    copyData(toExternal: boolean, overwrite: boolean): CopyResult | Promise<CopyResult>;
}

const DISCLAIMER = 'External folder storage is meant for power users only.\n\n' +
    'Keeping your logs and character data in a folder that other apps (such as Syncthing) can change ' +
    'may corrupt or lose data. Neither the Horizon Team nor the Solstice Team take any responsibility ' +
    'for issues this causes. You are responsible for keeping your own backups.';

// Typed confirmation, so the disclaimer gets read rather than tapped past.
const CONFIRM_PHRASE = 'I have read and accept the external folder disclaimer';

// Lenient on case, spacing and a trailing period, so phone keyboards' autocorrect doesn't get in the way.
function normalizePhrase(text: string): string {
    return text.trim().replace(/\.$/, '').replace(/\s+/g, ' ').toLowerCase();
}

function acceptDisclaimer(): boolean {
    const typed = prompt(`${DISCLAIMER}\n\nTo turn this on, type:\n${CONFIRM_PHRASE}`, '');
    if(typed === null) return false;
    if(normalizePhrase(typed) === normalizePhrase(CONFIRM_PHRASE)) return true;
    alert('The text didn\'t match, so the external folder was not turned on.');
    return false;
}

function bridge(): ExternalBridge | undefined {
    const file = (window as {NativeFile?: Partial<ExternalBridge>}).NativeFile;
    return file !== undefined && file.getExternalStatus !== undefined ? <ExternalBridge>file : undefined;
}

export async function getStatus(): Promise<ExternalStatus> {
    const native = bridge();
    if(native === undefined) return {enabled: false, path: null, available: false};
    return native.getExternalStatus();
}

function pickFolder(native: ExternalBridge): Promise<PickResult> {
    return new Promise<PickResult>((resolve) => {
        const w = window as {__externalFolderResult?(json: string): void};
        w.__externalFolderResult = (json: string) => {
            w.__externalFolderResult = undefined;
            resolve(<PickResult>JSON.parse(json));
        };
        const result = native.pickExternalFolder();
        if(result !== undefined)
            result.then((r) => {
                w.__externalFolderResult = undefined;
                resolve(r);
            }, (e: Error) => resolve({error: e.message}));
    });
}

async function reloadLogs(): Promise<void> {
    const logs = <{reloadIndex?(): Promise<void>} | undefined>(<unknown>core.logs);
    if(logs !== undefined && logs.reloadIndex !== undefined) await logs.reloadIndex();
}

// Offers to copy the folder's data back into app storage (overwriting it). Returns false if the copy
// was wanted but failed, in which case the caller should leave the folder in use.
async function offerCopyBack(native: ExternalBridge, question: string): Promise<boolean> {
    if(!(await getStatus()).available || !confirm(question)) return true;
    const copy = await native.copyData(false, true);
    if(copy.error === undefined) return true;
    alert(`Copying the data back failed: ${copy.error}\n\nThe external folder is still in use.`);
    return false;
}

async function chooseFolder(native: ExternalBridge): Promise<boolean> {
    const picked = await pickFolder(native);
    if(picked.cancelled === true) return false;
    if(picked.error !== undefined || picked.path === undefined) {
        alert(picked.error !== undefined ? picked.error : 'Solstice could not use that folder.');
        return false;
    }
    // Never overwrite what is already in the folder (it may be data synced from another device).
    const copy = await native.copyData(true, false);
    if(copy.error !== undefined) {
        alert(`Copying your data into the folder failed: ${copy.error}`);
        return false;
    }
    if(!await native.setExternalEnabled(true)) {
        alert('The folder is not available.');
        return false;
    }
    await reloadLogs();
    const skipped = copy.skipped !== undefined && copy.skipped > 0
        ? ` ${copy.skipped} file(s) already existed in the folder and were left as they are.` : '';
    alert(`Solstice now keeps logs and character data in:\n${picked.path}\n\n` +
        `Copied ${copy.copied !== undefined ? copy.copied : 0} file(s) into the folder.${skipped} ` +
        'The copy in app storage is kept as a fallback.');
    return true;
}

export async function enable(): Promise<boolean> {
    const native = bridge();
    if(native === undefined || !acceptDisclaimer()) return false;
    return chooseFolder(native);
}

export async function disable(): Promise<boolean> {
    const native = bridge();
    if(native === undefined || !confirm('Stop using the external folder?')) return false;
    if(!await offerCopyBack(native, 'Copy the data from the external folder back into app storage?\n\n' +
        'This overwrites the copy in app storage. Choose Cancel to switch back without copying.')) return false;
    await native.setExternalEnabled(false);
    await reloadLogs();
    return true;
}

export async function changeFolder(): Promise<boolean> {
    const native = bridge();
    if(native === undefined) return false;
    if(!await offerCopyBack(native, 'Copy the data from the current folder into app storage first, so it ' +
        'moves to the new folder?\n\nThis overwrites the copy in app storage. Choose Cancel to skip.')) return false;
    await native.setExternalEnabled(false);
    if(await chooseFolder(native)) return true;
    // Cancelled or failed: go back to the folder that was in use.
    await native.setExternalEnabled(true);
    await reloadLogs();
    return false;
}
