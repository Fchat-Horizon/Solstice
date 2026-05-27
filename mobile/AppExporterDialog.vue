<template><span></span></template>
<script lang="ts">
    import Vue from 'vue';
    import AdmZip from 'adm-zip';
    import ExporterVue from '../electron/Exporter.vue';

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

    function jsonLogToBinary(messages: Array<{time: number; type: number; sender: string; text: string}>): Buffer {
        const enc = new TextEncoder();
        const parts: Uint8Array[] = [];
        for (const msg of messages) {
            const senderB = enc.encode(msg.sender);
            const textB = enc.encode(msg.text);
            const msgLen = 8 + senderB.length + textB.length;
            const buf = new Uint8Array(msgLen + 2);
            const v = new DataView(buf.buffer);
            v.setUint32(0, msg.time, true);
            v.setUint8(4, msg.type);
            v.setUint8(5, senderB.length);
            buf.set(senderB, 6);
            v.setUint16(6 + senderB.length, textB.length, true);
            buf.set(textB, 8 + senderB.length);
            v.setUint16(msgLen, msgLen, true);
            parts.push(buf);
        }
        const total = parts.reduce((s, p) => s + p.length, 0);
        const out = Buffer.allocUnsafe(total);
        let off = 0;
        for (const p of parts) { out.set(p, off); off += p.length; }
        return out;
    }

    function buildLogIndex(name: string, messages: Array<{time: number; sender: string; text: string}>): Buffer {
        const enc = new TextEncoder();
        const nameB = enc.encode(name);
        const dayEntries: Array<{day: number; offset: number}> = [];
        let pos = 0;
        let lastDay = -1;
        for (const msg of messages) {
            const day = Math.floor(msg.time / 86400);
            if (day !== lastDay) { dayEntries.push({ day, offset: pos }); lastDay = day; }
            pos += 10 + enc.encode(msg.sender).length + enc.encode(msg.text).length;
        }
        const idxBuf = Buffer.allocUnsafe(1 + nameB.length + dayEntries.length * 7);
        idxBuf[0] = nameB.length;
        idxBuf.set(nameB, 1);
        let ip = 1 + nameB.length;
        for (const e of dayEntries) {
            idxBuf.writeInt16LE(e.day, ip);
            idxBuf.writeUInt32LE(e.offset >>> 0, ip + 2);
            idxBuf[ip + 6] = Math.floor(e.offset / 0x100000000) & 0xFF;
            ip += 7;
        }
        return idxBuf;
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
                    // is declared as Promise<string[]> in TypeScript but the actual Android
                    // bridge implementation is synchronous (JSON.parse(listDirectoriesN(p))).
                    const dirs = NativeFile.listDirectories('/') as unknown as string[];
                    vm.exportCharacters = dirs
                        .filter((d: string) => !d.startsWith('.'))
                        .sort((a: string, b: string) => a.localeCompare(b))
                        .map((name: string) => ({ name, selected: true }));

                    // Override runExport: Exporter.vue uses archiver+fs which are no-ops on
                    // mobile. Delegate to the native Kotlin zip export instead.
                    vm.runExport = () => {
                        vm.startExportAnimation();
                        vm.exportSummary = undefined;
                        vm.exportError = undefined;
                        setTimeout(() => {
                            const result: string = (window as any).NativeFile.exportData();
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
                    // onShowFileChooser in Kotlin). Kotlin reads the file via contentResolver
                    // and delivers base64 content back through window.__mobileFilePicker,
                    // bypassing the unreliable WebView content URI → FileReader path entirely.
                    vm.chooseImportZip = () => {
                        if (vm.importInProgress) return;
                        (window as any).__mobileFilePicker = (b64: string | null, fileName: string | null) => {
                            (window as any).__mobileFilePicker = undefined;
                            if (!b64 || !fileName) {
                                vm.importZipError = "Couldn't read the selected file.";
                                return;
                            }
                            try {
                                // Decode base64 → Uint8Array → Buffer without FileReader
                                const binary = atob(b64);
                                const bytes = new Uint8Array(binary.length);
                                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                                const zip = new AdmZip(Buffer.from(bytes));
                                vm.importZipArchive = zip;
                                vm.importZipName = fileName;
                                vm.importZipPath = fileName;
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
                                vm.importZipError = "We couldn't read that export. Please choose a Horizon export created by this app.";
                            }
                        };
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = '.zip';
                        input.style.display = 'none';
                        document.body.appendChild(input);
                        setTimeout(() => { if (input.parentNode) document.body.removeChild(input); }, 60000);
                        input.click();
                    };

                    // Override runZipImport: supports both PC exports (characters/CharName/... layout)
                    // and mobile exports (CharName/... layout). Log files use the same custom binary
                    // format on both platforms and are written via NativeFile.writeBytes (base64) to
                    // avoid corruption from UTF-8 string round-tripping.
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
                                    if (parts.length < 4) continue; // need characters/CharName/category/file
                                    const charName = parts[1];
                                    if (!selectedChars.has(charName)) continue;
                                    const category = parts[2];
                                    const rest = parts.slice(3).join('/');

                                    if (category === 'logs') {
                                        if (!vm.importIncludeLogs) continue;
                                        ensureDir(charName);
                                        ensureDir(`${charName}/logs`);
                                        if (pcJsonLogs && rest.endsWith('.json')) {
                                            const key = rest.slice(0, -5);
                                            try {
                                                const messages = JSON.parse(entry.getData().toString('utf8'));
                                                if (Array.isArray(messages) && messages.length > 0) {
                                                    const bin = jsonLogToBinary(messages);
                                                    const idx = buildLogIndex(key, messages);
                                                    await NativeFile.writeBytes(`${charName}/logs/${key}`, bin.toString('base64'));
                                                    await NativeFile.writeBytes(`${charName}/logs/${key}.idx`, idx.toString('base64'));
                                                }
                                            } catch { /* skip corrupt entries */ }
                                        } else {
                                            try { await NativeFile.writeBytes(`${charName}/logs/${rest}`, entry.getData().toString('base64')); } catch { /* skip */ }
                                        }
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

                                    ensureDir(charName);
                                    if (isLog) ensureDir(`${charName}/logs`);

                                    try {
                                        if (isLog) {
                                            await NativeFile.writeBytes(name, entry.getData().toString('base64'));
                                        } else {
                                            await NativeFile.write(name, entry.getData().toString('utf8'));
                                        }
                                    } catch { /* skip unwritable entries */ }
                                }
                            }

                            vm.importSummary = 'Import complete. Restart the app to apply changes.';
                        } catch {
                            vm.importError = 'Import failed.';
                        } finally {
                            vm.importInProgress = false;
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
