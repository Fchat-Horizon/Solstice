/**
 * Append-only trace of one Manage Data import, written to '!importlog'.
 *
 * Why this exists: an import failure reaches the user as the word "failed" and nothing else, and
 * the two failure shapes we cannot tell apart from the outside look identical from the inside. A
 * thrown error leaves a stack we can read, but a renderer kill (the WebView's JS heap running out)
 * leaves NOTHING: the process is gone, so any trace held in memory dies with it. So every line is
 * flushed to disk as it is written, and the reader looks at how the file ENDS. A file ending in
 * FAILED carries the error; a file ending mid-phase is the fingerprint of the kill, and the last
 * entry and flush lines say exactly where it died.
 *
 * Privacy: unlike '!crashlog' this DOES record the error message, because that message is the whole
 * point of the build this ships in. It still never records chat content, and entry paths are reduced
 * to their shape (depth, extension, byte size) rather than their names, so a trace can be handed
 * over without handing over a character list.
 */

function mb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

/**
 * Do NOT reach for `performance.memory` here. On the Android System WebView (checked on Chrome 113
 * / Android 14) it reports a frozen value: it still read 25MB after deliberately allocating 320MB,
 * so it would put a confident, wrong number next to every line. What is measured instead is
 * headroom, by actually asking for memory and seeing how much is refused. That costs a real
 * allocation, so it runs only where the answer matters: at the moment of failure.
 */
function headroom(): string {
    const sizes = [512, 256, 128, 64, 32, 16, 8, 4, 1];
    for (const size of sizes) {
        try {
            const probe = new Uint8Array(size * 1024 * 1024);
            probe[0] = 1;
            return `headroom>=${mb(size * 1024 * 1024)}`;
        } catch {
            // Refused at this size; try smaller.
        }
    }
    return 'headroom<1MB (out of memory)';
}

/** An entry described by shape alone: never its name. */
export function describeEntry(entryName: string, size: number): string {
    const segments = entryName.split('/');
    const last = segments[segments.length - 1];
    const dot = last.lastIndexOf('.');
    const ext = dot > 0 ? last.slice(dot) : '(none)';
    return `depth=${segments.length} ext=${ext} size=${size}`;
}

export class ImportTrace {
    private buffer: string[] = [];
    private readonly started = Date.now();
    private closed = false;

    private async append(text: string): Promise<void> {
        const native = (window as unknown as {NativeFile?: {appendBytes?(n: string, b: string): Promise<void>; write?(n: string, d: string): Promise<void>}}).NativeFile;
        if (native === undefined) return;
        try {
            if (native.appendBytes !== undefined) {
                // btoa needs latin1, so go through the same UTF-8 encoding the file bridge expects.
                const bytes = new TextEncoder().encode(text);
                let binary = '';
                for (let i = 0; i < bytes.length; i += 8192)
                    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
                await native.appendBytes('!importlog', btoa(binary));
            } else if (native.write !== undefined) {
                await native.write('!importlog', this.buffer.join(''));
            }
        } catch {
            // The trace must never be the reason an import fails.
        }
    }

    /**
     * Writes one line and flushes it. Flushing every line is the whole design: a line still in
     * memory when the renderer is killed tells us nothing.
     */
    async log(line: string): Promise<void> {
        if (this.closed) return;
        const at = ((Date.now() - this.started) / 1000).toFixed(1);
        const text = `[+${at}s] ${line}\n`;
        this.buffer.push(text);
        await this.append(text);
    }

    /**
     * A progress line for a phase that could be the last one written. There is no reliable heap
     * reading to attach (see `headroom`), so what these carry is position: how far in, and how big
     * the piece being worked on was. A file that stops at one of these names the culprit.
     */
    async logPhase(line: string): Promise<void> {
        await this.log(line);
    }

    async begin(header: string): Promise<void> {
        // Truncate: one file per import, so the end of the file is always the end of THIS import.
        const native = (window as unknown as {NativeFile?: {write?(n: string, d: string): Promise<void>}}).NativeFile;
        try {
            if (native?.write !== undefined) await native.write('!importlog', '');
        } catch {
            // best effort
        }
        await this.log(`import trace ${new Date().toISOString()}`);
        await this.log(header);
        await this.log(`start ${headroom()}`);
    }

    /** Records the error in full: name, message and stack. See the privacy note above. */
    async failed(err: unknown): Promise<void> {
        const e = err as {name?: unknown; message?: unknown; stack?: unknown} | null | undefined;
        const name = typeof e?.name === 'string' ? e.name : `non-Error (${err === null ? 'null' : typeof err})`;
        const message = typeof e?.message === 'string' ? e.message : String(err);
        await this.log('FAILED');
        await this.log(`error: ${name}: ${message}`);
        // Probed after the throw, so an out-of-memory failure is distinguishable from a logic one:
        // a RangeError with plenty of headroom is a bug, with none it is exhaustion.
        await this.log(headroom());
        if (typeof e?.stack === 'string') await this.log(e.stack);
        this.closed = true;
    }

    async completed(summary: string): Promise<void> {
        await this.log(`COMPLETED ${summary}`);
        this.closed = true;
    }

    /**
     * Hands the finished trace to the native saver (Downloads on Android, share sheet on iOS) so
     * the reporter has a file to attach without hunting for it. Returns the saved name, or ''.
     */
    async save(): Promise<string> {
        const native = (window as unknown as {NativeFile?: {saveExport?(s: string, d: string): Promise<string>}}).NativeFile;
        if (native?.saveExport === undefined) return '';
        try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            return (await native.saveExport('!importlog', `solstice-import-log-${stamp}.txt`)) || '';
        } catch {
            return '';
        }
    }
}

/**
 * Called at boot. A '!importlog' that is still present and does not end in a terminal marker was
 * left by an import whose process died before it could finish or report: the one failure shape
 * that leaves no error behind. Mark it as such, keep it, and hand the marked text back so the
 * caller can fold it into the diagnostic log the user can already export. Returns undefined when
 * there is no interrupted import to report.
 */
export async function noteInterruptedImport(): Promise<string | undefined> {
    const native = (window as unknown as {NativeFile?: {read?(n: string): Promise<string | undefined>; write?(n: string, d: string): Promise<void>}}).NativeFile;
    if (native?.read === undefined || native.write === undefined) return undefined;
    try {
        const existing = await native.read('!importlog');
        if (existing === undefined || existing === null || existing.length === 0) return undefined;
        if (/\b(COMPLETED|FAILED|INTERRUPTED)\b/.test(existing)) return undefined;
        const marked =
            `${existing}INTERRUPTED: the app restarted before this import finished, which means the\n` +
            'process was killed rather than the import throwing. The last entry and flush lines\n' +
            'above are where it died.\n';
        await native.write('!importlog', marked);
        return marked;
    } catch {
        return undefined;
    }
}
