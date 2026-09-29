<template><span></span></template>
<script lang="ts">
    import Vue from 'vue';
    import AdmZip from 'adm-zip';
    import ExporterVue from '../electron/Exporter.vue';
    import {SyncMerge} from './sync/archive';
    import {parseBinaryLog} from './sync/logMessage';
    import {NativeSyncStorage} from './sync/nativeStorage';
    import {describeEntry, ImportTrace} from './importTrace';

    // Android's WebView paints on the same thread this dialog's work runs on, and its native
    // bridge resolves synchronously, so awaiting a bridge call only drains microtasks and never
    // returns to the event loop. A long import therefore freezes the whole app until it finishes
    // (reported as a complete lockup). A real macrotask is the only thing that lets the WebView
    // paint, so yield on a time budget: often enough to stay responsive, rarely enough that the
    // timer clamp does not dominate an import with thousands of entries.
    const UI_YIELD_INTERVAL = 50;
    /** Yields if it has been longer than the interval, reporting whether it did. */
    function makeBreather(): () => Promise<boolean> {
        let last = Date.now();
        return async () => {
            if (Date.now() - last < UI_YIELD_INTERVAL) return false;
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            last = Date.now();
            return true;
        };
    }

    function isPCFormat(zip: AdmZip): boolean {
        return zip.getEntries().some((e: any) => !e.isDirectory && (e.entryName as string).startsWith('characters/'));
    }

    function isPCJsonLogs(zip: AdmZip): boolean {
        const entry = zip.getEntry('manifest.json');
        if (!entry) return false;
        try {
            const m = JSON.parse(entry.getData().toString('utf8'));
            return m?.includes?.jsonLogs === true;
        } catch { return false; }
    }

    export default Vue.extend({
        data() { return { container: null as HTMLElement | null }; },
        methods: {
            show(): void {
                if (!this.container) {
                    // Vue 2 replaces the mount `el` with the component root, so we need a
                    // persistent wrapper that keeps the overlay positioning, then mount inside it.
                    this.container = document.createElement('div');
                    this.container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:1050;overflow:auto';
                    document.body.appendChild(this.container);
                    const mount = document.createElement('div');
                    this.container.appendChild(mount);
                    const vm: any = new ExporterVue({
                        el: mount,
                        // Auto Backup is hidden on mobile (its scheduler only exists in the Electron
                        // main process), so open on Export instead.
                        data: { settings: (window as any).__generalSettings, selectedSection: 'export' },
                    });

                    // Populate character list from mobile storage. NativeFile.listDirectories
                    // is Promise<string[]>; the Android bridge resolves it synchronously while
                    // the iOS bridge is genuinely async — awaiting works for both.
                    void (async () => {
                        const dirs = (await NativeFile.listDirectories('/')) as unknown as string[];
                        vm.exportCharacters = dirs
                            .filter((d: string) => !d.startsWith('.'))
                            .sort((a: string, b: string) => a.localeCompare(b))
                            .map((name: string) => ({ name, selected: true }));
                    })();

                    // Override runExport: Exporter.vue uses archiver+fs which are no-ops on
                    // mobile. Delegate to the native Kotlin zip export instead.
                    vm.runExport = () => {
                        vm.startExportAnimation();
                        vm.exportSummary = undefined;
                        vm.exportError = undefined;
                        setTimeout(async () => {
                            // exportData() resolves synchronously on Android and asynchronously
                            // on iOS (share sheet); await covers both.
                            const result: string = await (window as any).NativeFile.exportData();
                            vm.stopExportAnimation();
                            if (result) {
                                vm.exportSummary = result;
                            } else {
                                vm.exportError = 'Export failed.';
                            }
                        }, 0);
                    };

                    // Override chooseImportZip: showOpenDialog is not available on mobile.
                    // We trigger the system file picker via a hidden file input (which fires
                    // onShowFileChooser in Kotlin). Kotlin copies the file to filesDir and
                    // passes the temp filename through window.__mobileFilePicker. The zip is
                    // then read in 4 MB chunks via NativeFile.readBytes to avoid the OOM crash
                    // that a single base64 evaluateJavascript call caused on large archives.
                    vm.chooseImportZip = () => {
                        if (vm.importInProgress) return;
                        (window as any).__mobileFilePicker = async (tmpName: string | null, fileName: string | null) => {
                            (window as any).__mobileFilePicker = undefined;
                            if (!tmpName || !fileName) {
                                vm.importZipError = "Couldn't read the selected file.";
                                return;
                            }
                            const trace = vm._importTrace = new ImportTrace();
                            await trace.begin(
                                `ua=${navigator.userAgent} platform=${document.documentElement.dataset.mobileOs}`);
                            try {
                                // Read the zip in 4 MB chunks to avoid allocating one giant
                                // base64 string through evaluateJavascript.
                                const CHUNK = 4 * 1024 * 1024;
                                // getSize/readBytes are synchronous on the Android bridge but
                                // genuinely async on iOS — await works for both.
                                const fileSize: number = await NativeFile.getSize(tmpName);
                                await trace.logPhase(`picked file: ${fileSize} bytes`);
                                const buf = Buffer.allocUnsafe(fileSize);
                                const breathe = makeBreather();
                                let offset = 0;
                                while (offset < fileSize) {
                                    const chunkLen = Math.min(CHUNK, fileSize - offset);
                                    const b64chunk: string = await NativeFile.readBytes(tmpName, offset, chunkLen);
                                    const decoded = Buffer.from(b64chunk, 'base64');
                                    decoded.copy(buf, offset);
                                    offset += decoded.length;
                                    await breathe();
                                }
                                await trace.logPhase('read into memory, opening archive');
                                const zip = new AdmZip(buf);
                                await trace.logPhase(`archive opened: ${zip.getEntries().length} entries`);
                                vm.importZipArchive = zip;
                                vm.importZipName = fileName;
                                vm.importZipPath = fileName;
                                vm._importTmpName = tmpName;
                                vm.importZipError = undefined;
                                vm.importSummary = undefined;
                                vm.importError = undefined;

                                const pcFormat = isPCFormat(zip);
                                await trace.log(`format=${pcFormat ? 'pc' : 'mobile'}`);

                                if (pcFormat) {
                                    // PC export: `settings` at root, `characters/CharName/logs/` and `characters/CharName/settings/`
                                    vm.importGeneralAvailable = zip.getEntries().some(
                                        (e: any) => e.entryName === 'settings'
                                    );
                                    const charMap = new Map<string, { hasLogs: boolean; hasSettings: boolean }>();
                                    for (const entry of zip.getEntries()) {
                                        if (entry.isDirectory) continue;
                                        const parts = (entry.entryName as string).split('/');
                                        if (parts.length < 3 || parts[0] !== 'characters') continue;
                                        const charName = parts[1];
                                        if (!charName || charName.startsWith('.')) continue;
                                        if (!charMap.has(charName)) charMap.set(charName, { hasLogs: false, hasSettings: false });
                                        const info = charMap.get(charName)!;
                                        if (parts[2] === 'logs') info.hasLogs = true;
                                        if (parts[2] === 'settings') info.hasSettings = true;
                                    }
                                    vm.importCharacters = Array.from(charMap.entries())
                                        .sort(([a], [b]) => a.localeCompare(b))
                                        .map(([name, info]) => ({
                                            name, selected: true,
                                            hasLogs: info.hasLogs, hasSettings: info.hasSettings,
                                            hasPinnedConversations: false, hasPinnedEicons: false,
                                            hasRecents: false, hasHidden: false, hasDrafts: false,
                                        }));
                                } else {
                                    // Mobile export: `!settings` at root, `CharName/logs/` and `CharName/<file>`
                                    vm.importGeneralAvailable = zip.getEntries().some(
                                        (e: any) => e.entryName === '!settings'
                                    );
                                    const charMap = new Map<string, { hasLogs: boolean }>();
                                    for (const entry of zip.getEntries()) {
                                        if (entry.isDirectory) continue;
                                        const parts = (entry.entryName as string).split('/');
                                        if (parts.length < 2 || parts[0].startsWith('!') || parts[0].startsWith('.')) continue;
                                        const charName = parts[0];
                                        if (!charMap.has(charName)) charMap.set(charName, { hasLogs: false });
                                        if (parts[1] === 'logs' && parts.length >= 3) charMap.get(charName)!.hasLogs = true;
                                    }
                                    vm.importCharacters = Array.from(charMap.entries())
                                        .sort(([a], [b]) => a.localeCompare(b))
                                        .map(([name, info]) => ({
                                            name, selected: true,
                                            hasLogs: info.hasLogs, hasSettings: true,
                                            hasPinnedConversations: false, hasPinnedEicons: false,
                                            hasRecents: false, hasHidden: false, hasDrafts: false,
                                        }));
                                }

                                vm.importCharacterSettingsAvailable = vm.importCharacters.some((c: any) => c.hasSettings);
                                vm.importLogsAvailable = vm.importCharacters.some((c: any) => c.hasLogs);
                                vm.importIncludeGeneralSettings = vm.importGeneralAvailable;
                                vm.importIncludeCharacterSettings = vm.importCharacterSettingsAvailable;
                                vm.importIncludeLogs = vm.importLogsAvailable;
                                await trace.logPhase(
                                    `parsed: ${vm.importCharacters.length} characters, logs=${vm.importLogsAvailable}`);
                            } catch (e) {
                                await trace.failed(e);
                                await trace.save();
                                vm.importZipError = "We couldn't read that export. Please choose a Solstice export created by this app.";
                            }
                        };
                        // On iOS the WKWebView <input type=file> path doesn't reach a native
                        // file chooser the way Android's onShowFileChooser does. Ask the native
                        // bridge to open a document picker instead; it delivers the file back
                        // through the same window.__mobileFilePicker callback set above.
                        if (document.documentElement.dataset.mobileOs === 'ios') {
                            (window as any).NativeFile.pickImportFile();
                            return;
                        }
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = '.zip';
                        input.style.display = 'none';
                        document.body.appendChild(input);
                        setTimeout(() => { if (input.parentNode) document.body.removeChild(input); }, 60000);
                        input.click();
                    };

                    // Override runZipImport: supports both PC exports (characters/CharName/... layout)
                    // and mobile exports (CharName/... layout). Settings files are written verbatim;
                    // chat logs are normalized to the sync zip's JSON layout and merged (message-level
                    // union, idempotent) through the shared sync merge, so re-importing a backup never
                    // drops or duplicates messages. Logs use the same binary format on both platforms.
                    vm.runZipImport = async () => {
                        if (!vm.importZipArchive || vm.importInProgress) return;
                        vm.importInProgress = true;
                        vm.importSummary = undefined;
                        vm.importError = undefined;
                        vm.importProgress = undefined;
                        const trace: ImportTrace = vm._importTrace || new ImportTrace();
                        await trace.logPhase('restore started');
                        try {
                            const zip: AdmZip = vm.importZipArchive;
                            const selectedChars = new Set<string>(
                                vm.importCharacters
                                    .filter((c: any) => c.selected)
                                    .map((c: any) => c.name as string)
                            );
                            const ensured = new Set<string>();
                            const pcFormat = isPCFormat(zip);
                            const pcJsonLogs = pcFormat && isPCJsonLogs(zip);
                            await trace.log(
                                `selected=${selectedChars.size}/${vm.importCharacters.length} characters, ` +
                                `pcFormat=${pcFormat} jsonLogs=${pcJsonLogs} ` +
                                `includeLogs=${vm.importIncludeLogs} includeSettings=${vm.importIncludeCharacterSettings} ` +
                                `includeGeneral=${vm.importIncludeGeneralSettings}`);

                            const ensureDir = (path: string) => {
                                if (!ensured.has(path)) { NativeFile.ensureDirectory(path); ensured.add(path); }
                            };

                            // Feed the selected log entries to the shared sync merge in bounded batches,
                            // in the sync zip's JSON layout. One archive for the whole import is what a
                            // desktop-sized log set cannot afford: every conversation's decoded JSON would
                            // sit in the heap at once, and adm-zip's toBuffer plus openSyncBatch's own copy
                            // would each need that again contiguously. A merge session spans batches, so
                            // flushing at a byte budget costs nothing but keeps the peak flat. The atom is
                            // one conversation, so a single enormous conversation is still the ceiling.
                            const merge = new SyncMerge(new NativeSyncStorage());
                            // Sized against the stall, not the throughput. Profiled on a 58 MB
                            // desktop backup (3725 files) on an emulated Android 14, the merge is
                            // ~64% of the import and each flush blocks the thread for its whole
                            // duration: an 8 MB batch blocks ~1.5s, 1 MB ~680ms, 256 KB ~200ms.
                            // Total time barely moves, because the merge cost is linear in the
                            // messages merged and the per-batch overhead is nearly nothing.
                            const BATCH_BYTES = 256 * 1024;
                            let batch = new AdmZip();
                            let batchBytes = 0;
                            let batchEntries = 0;
                            let flushes = 0;
                            const batchCharacters = new Set<string>();
                            let hasLogs = false;

                            // logs-names.json can sit after the logs it names, so collect the names files
                            // up front: a batch flushed before its character's names entry was reached
                            // would create those conversations under their raw key.
                            const namesByCharacter = new Map<string, Buffer>();
                            if (pcFormat) {
                                for (const entry of zip.getEntries()) {
                                    if (entry.isDirectory) continue;
                                    const parts = (entry.entryName as string).split('/');
                                    if (parts.length === 3 && parts[0] === 'characters' && parts[2] === 'logs-names.json')
                                        namesByCharacter.set(parts[1], entry.getData());
                                }
                            }

                            const flushBatch = async () => {
                                if (batchBytes === 0) return;
                                // Display names are read per archive, so each batch carries the names of
                                // every character it touches. They are small; re-adding them is cheap.
                                for (const charName of batchCharacters) {
                                    const names = namesByCharacter.get(charName);
                                    if (names !== undefined)
                                        batch.addFile(`characters/${charName}/logs-names.json`, names);
                                }
                                flushes++;
                                const flushBytes = batchBytes;
                                const flushStart = Date.now();
                                // Logged BEFORE the merge: if the merge is what kills the process,
                                // this is the last line in the file and it says what it was given.
                                await trace.logPhase(`flush #${flushes} bytes=${flushBytes} entries=${batchEntries}`);
                                await merge.mergeBatch(batch.toBuffer());
                                await trace.log(`flush #${flushes} done in ${Date.now() - flushStart}ms`);
                                await new Promise<void>(resolve => setTimeout(resolve, 0));
                                batchEntries = 0;
                                batch = new AdmZip();
                                batchBytes = 0;
                                batchCharacters.clear();
                            };

                            const addJsonLog = async (charName: string, key: string, messages: unknown[]) => {
                                const json = Buffer.from(JSON.stringify(messages), 'utf8');
                                batch.addFile(`characters/${charName}/logs/${key}.json`, json);
                                batchCharacters.add(charName);
                                batchBytes += json.length;
                                batchEntries++;
                                hasLogs = true;
                                if (batchBytes >= BATCH_BYTES) await flushBatch();
                            };

                            const breathe = makeBreather();
                            const entries = zip.getEntries();
                            let processed = 0;
                            let lastEntry = '(none)';
                            let corrupt = 0;
                            let unwritable = 0;

                            for (const entry of entries) {
                                processed++;
                                if (entry.isDirectory) continue;
                                const name: string = entry.entryName;
                                // Only on an actual yield: a reactive write per entry is thousands
                                // of scheduler runs for a large export, and nothing can paint
                                // between them anyway.
                                vm.importProgress = `Reading ${processed} of ${entries.length} files…`;
                                // The entry is named by SHAPE only (never its path) and written
                                // before it is touched, so a process killed decoding it leaves the
                                // culprit as the last line of the file.
                                lastEntry = describeEntry(name, entry.header.size);
                                if (processed % 100 === 0 || entry.header.size > 4 * 1024 * 1024)
                                    await trace.logPhase(`entry ${processed}/${entries.length} ${lastEntry}`);
                                await breathe();

                                if (pcFormat) {
                                    // — PC format —
                                    if (name === 'settings') {
                                        if (!vm.importGeneralAvailable || !vm.importIncludeGeneralSettings) continue;
                                        try { await NativeFile.write('!settings', entry.getData().toString('utf8')); } catch { /* skip */ }
                                        continue;
                                    }
                                    if (!name.startsWith('characters/')) continue;
                                    const parts = name.split('/');
                                    if (parts.length < 3) continue;
                                    const charName = parts[1];
                                    // Names were gathered in the pre-pass above; skip them here.
                                    if (parts.length === 3 && parts[2] === 'logs-names.json') continue;
                                    if (parts.length < 4) continue; // need characters/CharName/category/file
                                    if (!selectedChars.has(charName)) continue;
                                    const category = parts[2];
                                    const rest = parts.slice(3).join('/');

                                    if (category === 'logs') {
                                        if (!vm.importIncludeLogs) continue;
                                        try {
                                            if (pcJsonLogs && rest.endsWith('.json')) {
                                                const messages = JSON.parse(entry.getData().toString('utf8'));
                                                if (Array.isArray(messages) && messages.length > 0)
                                                    await addJsonLog(charName, rest.slice(0, -5), messages);
                                            } else {
                                                const messages = parseBinaryLog(entry.getData());
                                                if (messages.length > 0) await addJsonLog(charName, rest, messages);
                                            }
                                        } catch (e) {
                                            corrupt++;
                                            if (corrupt <= 5)
                                                await trace.log(`corrupt entry ${lastEntry}: ${(e as Error).name}: ${(e as Error).message}`);
                                        }
                                    } else if (category === 'settings') {
                                        if (!vm.importIncludeCharacterSettings) continue;
                                        ensureDir(charName);
                                        try {
                                            await NativeFile.write(`${charName}/${rest}`, entry.getData().toString('utf8'));
                                        } catch (e) {
                                            unwritable++;
                                            if (unwritable <= 5)
                                                await trace.log(`unwritable ${lastEntry}: ${(e as Error).name}: ${(e as Error).message}`);
                                        }
                                    }
                                    // drafts.txt and other PC-only entries are skipped on mobile

                                } else {
                                    // — Mobile format —
                                    if (/\.(db|db-wal|db-shm|db-journal)$/.test(name)) continue;

                                    if (name === '!settings') {
                                        if (!vm.importGeneralAvailable || !vm.importIncludeGeneralSettings) continue;
                                        try { await NativeFile.write('!settings', entry.getData().toString('utf8')); } catch { /* skip */ }
                                        continue;
                                    }

                                    const parts = name.split('/');
                                    if (parts.length < 2 || parts[0].startsWith('!') || parts[0].startsWith('.')) continue;
                                    const charName = parts[0];
                                    if (!selectedChars.has(charName)) continue;

                                    const isLog = parts[1] === 'logs' && parts.length >= 3;
                                    if (isLog && !vm.importIncludeLogs) continue;
                                    if (!isLog && !vm.importIncludeCharacterSettings) continue;

                                    if (isLog) {
                                        try {
                                            const messages = parseBinaryLog(entry.getData());
                                            if (messages.length > 0) await addJsonLog(charName, parts.slice(2).join('/'), messages);
                                        } catch (e) {
                                            corrupt++;
                                            if (corrupt <= 5)
                                                await trace.log(`corrupt entry ${lastEntry}: ${(e as Error).name}: ${(e as Error).message}`);
                                        }
                                    } else {
                                        ensureDir(charName);
                                        try {
                                            await NativeFile.write(name, entry.getData().toString('utf8'));
                                        } catch (e) {
                                            unwritable++;
                                            if (unwritable <= 5)
                                                await trace.log(`unwritable ${lastEntry}: ${(e as Error).name}: ${(e as Error).message}`);
                                        }
                                    }
                                }
                            }

                            let mergedNote = '';
                            if (hasLogs) {
                                vm.importProgress = 'Merging logs…';
                                await flushBatch();
                                const stats = await merge.finish();
                                if (stats.messagesAdded > 0)
                                    mergedNote = ` ${stats.messagesAdded} new message${stats.messagesAdded === 1 ? '' : 's'} merged.`;
                                // Damaged conversations are left untouched rather than rewritten
                                // from a truncated prefix, so say so instead of reporting success.
                                if (stats.conversationsSkipped > 0)
                                    mergedNote += ` ${stats.conversationsSkipped} damaged conversation${stats.conversationsSkipped === 1 ? ' was' : 's were'} skipped; open that character's logs so Solstice can repair them, then import again.`;
                            }
                            vm.importSummary = `Import complete. Restart the app to apply changes.${mergedNote}`;
                            await trace.log(
                                `entries=${processed} flushes=${flushes} corrupt=${corrupt} unwritable=${unwritable}`);
                            await trace.completed(vm.importSummary);
                        } catch (e) {
                            // A bare 'Import failed.' left the one failure users actually hit
                            // undiagnosable. The trace carries the error in full; '!crashlog' still
                            // gets the privacy-reduced version so ordinary reports keep working.
                            const logCrash = (window as any).__logCrash; //tslint:disable-line:no-any
                            if (typeof logCrash === 'function') logCrash('import', e);
                            await trace.failed(e);
                            const name = (e as {name?: unknown} | null)?.name;
                            vm.importError = typeof name === 'string' && name.length > 0
                                ? `Import failed (${name}).`
                                : 'Import failed.';
                        } finally {
                            vm.importInProgress = false;
                            vm.importProgress = undefined;
                            // Hand the trace over without making anyone hunt for it: Downloads on
                            // Android, share sheet on iOS.
                            const savedTrace = await trace.save();
                            const where = savedTrace ? ` Import log saved as ${savedTrace}.` : '';
                            if (vm.importError) vm.importError += where;
                            else if (vm.importSummary) vm.importSummary += where;
                            if (vm._importTmpName) {
                                try { await NativeFile.delete(vm._importTmpName); } catch { /* ignore */ }
                                vm._importTmpName = undefined;
                            }
                        }
                    };

                } else { this.container.style.display = ''; }
                window.addEventListener('exporter-window-close', this.hide as EventListener, { once: true });
            },
            hide(): void { if (this.container) this.container.style.display = 'none'; },
        },
        beforeDestroy(): void { if (this.container) document.body.removeChild(this.container); },
    });
</script>
