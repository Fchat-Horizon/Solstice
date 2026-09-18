/**
 * How the outgoing sync batch gets turned into a zip.
 *
 * Measured on a Pixel 4a over a real 62 MB log store, building one batch took 21 s,
 * of which the native file bridge was 1.6 s. Nearly half the rest was `zlib` and
 * most of the remainder `Buffer`: both are JavaScript polyfills inside the WebView,
 * where the desktop gets the platform's own. So the archive is handed to the native
 * host when it offers one (`java.util.zip` on Android, the `Compression` framework
 * on iOS), and falls back to `adm-zip` otherwise.
 *
 * The fallback is not vestigial: the sync core runs under `node --test` with no
 * bridge at all, and a native host built before `zipStart` existed still has to
 * work. Both writers produce an ordinary PKZIP archive, so nothing on the wire
 * changes and the receiver cannot tell which built it.
 */

import AdmZip from 'adm-zip';
import {fromBase64, utf8} from './bytes.ts';

export interface SyncZipWriter {
    /** Add one entry. `text` is UTF-8 encoded by whoever builds the archive. */
    add(name: string, text: string): Promise<void>;
    /** Finish and return the archive bytes. */
    finish(): Promise<Buffer>;
}

class AdmZipWriter implements SyncZipWriter {
    private readonly zip = new AdmZip();

    async add(name: string, text: string): Promise<void> {
        this.zip.addFile(name, utf8(text));
    }

    async finish(): Promise<Buffer> {
        return this.zip.toBuffer();
    }
}

/**
 * Streams entries into the native host, which does the UTF-8 encode, the deflate and
 * the PKZIP framing. Entries go over one at a time as plain strings: the alternative,
 * one call carrying every entry, would mean re-serializing megabytes of JSON inside
 * another JSON document, and base64 would mean encoding them in the polyfill we are
 * trying to avoid.
 */
class NativeZipWriter implements SyncZipWriter {
    async start(): Promise<void> {
        await NativeFile.zipStart();
    }

    async add(name: string, text: string): Promise<void> {
        await NativeFile.zipAdd(name, text);
    }

    async finish(): Promise<Buffer> {
        return fromBase64(await NativeFile.zipFinish());
    }
}

function hasNativeZip(): boolean {
    return typeof NativeFile !== 'undefined'
        && typeof (NativeFile as {zipStart?: unknown}).zipStart === 'function'
        && typeof (NativeFile as {zipAdd?: unknown}).zipAdd === 'function'
        && typeof (NativeFile as {zipFinish?: unknown}).zipFinish === 'function';
}

/** The best zip writer this host offers. */
export async function createZipWriter(): Promise<SyncZipWriter> {
    if(hasNativeZip()) {
        const writer = new NativeZipWriter();
        try {
            await writer.start();
            return writer;
        } catch {
            // A host that advertises the call but cannot honour it must not fail the
            // sync; the pure-JS writer produces the same archive, only slower.
        }
    }
    return new AdmZipWriter();
}
