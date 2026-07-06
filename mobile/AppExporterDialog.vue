<template><span></span></template>
<script lang="ts">
    import Vue from 'vue';
    import AdmZip from 'adm-zip';
    import ExporterVue from '../electron/Exporter.vue';
    import {mergeLogs} from './sync/archive';
    import {parseBinaryLog} from './sync/logMessage';
    import {NativeSyncStorage} from './sync/nativeStorage';

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
                        data: { settings: (window as any).__generalSettings },
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
                            try {
                                // Read the zip in 4 MB chunks to avoid allocating one giant
                                // base64 string through evaluateJavascript.
                                const CHUNK = 4 * 1024 * 1024;
                                // getSize/readBytes are synchronous on the Android bridge but
                                // genuinely async on iOS — await works for both.
                                const fileSize: number = await NativeFile.getSize(tmpName);
                                const buf = Buffer.allocUnsafe(fileSize);
                                let offset = 0;
                                while (offset < fileSize) {
                                    const chunkLen = Math.min(CHUNK, fileSize - offset);
                                    const b64chunk: string = await NativeFile.readBytes(tmpName, offset, chunkLen);
                                    const decoded = Buffer.from(b64chunk, 'base64');
                                    decoded.copy(buf, offset);
                                    offset += decoded.length;
                                }
                                const zip = new AdmZip(buf);
                                vm.importZipArchive = zip;
                                vm.importZipName = fileName;
                                vm.importZipPath = fileName;
                                vm._importTmpName = tmpName;
                                vm.importZipError = undefined;
                                vm.importSummary = undefined;
                                vm.importError = undefined;

                                const pcFormat = isPCFormat(zip);

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
                            } catch {
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

                            const ensureDir = (path: string) => {
                                if (!ensured.has(path)) { NativeFile.ensureDirectory(path); ensured.add(path); }
                            };

                            // Collect every selected log entry as the sync zip's JSON layout, then merge once.
                            const logZip = new AdmZip();
                            let hasLogs = false;
                            const addJsonLog = (charName: string, key: string, messages: unknown[]) => {
                                logZip.addFile(`characters/${charName}/logs/${key}.json`,
                                    Buffer.from(JSON.stringify(messages), 'utf8'));
                                hasLogs = true;
                            };

                            for (const entry of zip.getEntries()) {
                                if (entry.isDirectory) continue;
                                const name: string = entry.entryName;

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
                                    // logs-names.json rides along so channel display names survive the merge.
                                    if (parts.length === 3 && parts[2] === 'logs-names.json') {
                                        if (vm.importIncludeLogs && selectedChars.has(charName))
                                            logZip.addFile(`characters/${charName}/logs-names.json`, entry.getData());
                                        continue;
                                    }
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
                                                    addJsonLog(charName, rest.slice(0, -5), messages);
                                            } else {
                                                const messages = parseBinaryLog(entry.getData());
                                                if (messages.length > 0) addJsonLog(charName, rest, messages);
                                            }
                                        } catch { /* skip corrupt entries */ }
                                    } else if (category === 'settings') {
                                        if (!vm.importIncludeCharacterSettings) continue;
                                        ensureDir(charName);
                                        try { await NativeFile.write(`${charName}/${rest}`, entry.getData().toString('utf8')); } catch { /* skip */ }
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
                                            if (messages.length > 0) addJsonLog(charName, parts.slice(2).join('/'), messages);
                                        } catch { /* skip corrupt entries */ }
                                    } else {
                                        ensureDir(charName);
                                        try { await NativeFile.write(name, entry.getData().toString('utf8')); } catch { /* skip unwritable entries */ }
                                    }
                                }
                            }

                            let mergedNote = '';
                            if (hasLogs) {
                                const stats = await mergeLogs(logZip.toBuffer(), new NativeSyncStorage());
                                if (stats.messagesAdded > 0)
                                    mergedNote = ` ${stats.messagesAdded} new message${stats.messagesAdded === 1 ? '' : 's'} merged.`;
                            }
                            vm.importSummary = `Import complete. Restart the app to apply changes.${mergedNote}`;
                        } catch {
                            vm.importError = 'Import failed.';
                        } finally {
                            vm.importInProgress = false;
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
