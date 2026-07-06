<template>
    <div v-if="visible" class="ds-overlay">
        <div class="ds-card">
            <div class="ds-header">
                <h3 class="ds-title">Device sync</h3>
                <button class="btn btn-sm btn-outline-secondary" :disabled="isRunning" @click="close">
                    {{ isTerminal ? 'Done' : 'Cancel' }}
                </button>
            </div>

            <div class="ds-body">
                <!-- Choose how to pair -->
                <div v-if="phase === 'choosing'" class="ds-phase">
                    <template v-if="scanning">
                        <div class="ds-scanner">
                            <video ref="video" class="ds-video" playsinline webkit-playsinline muted autoplay></video>
                            <canvas ref="canvas" class="ds-canvas"></canvas>
                        </div>
                        <p class="ds-sub">Point the camera at Horizon's QR code.</p>
                        <button class="btn btn-outline-secondary ds-action" @click="stopScan">Cancel</button>
                    </template>
                    <template v-else-if="pasting">
                        <h4 class="ds-h">Enter sync code</h4>
                        <p class="ds-sub">Paste the sync code shown under Horizon's QR code.</p>
                        <textarea ref="paste" v-model="pasteText" class="form-control ds-textarea" rows="4"
                                  placeholder="Paste the code here"></textarea>
                        <button class="btn btn-outline-secondary ds-action" @click="pasteFromClipboard">
                            <span class="fa fa-paste"></span> Paste from clipboard
                        </button>
                        <div class="ds-row">
                            <button class="btn btn-outline-secondary" @click="cancelPaste">Back</button>
                            <button class="btn btn-primary" :disabled="pasteText.trim().length === 0"
                                    @click="parse(pasteText)">Continue</button>
                        </div>
                    </template>
                    <template v-else>
                        <span class="fa fa-qrcode ds-icon"></span>
                        <h4 class="ds-h">Sync chat logs with Horizon</h4>
                        <p class="ds-sub">
                            In Horizon, open Data Manager, then Device Sync, and show its QR code. Both devices
                            must be on the same Wi-Fi network and signed into {{ accountLabel }}.
                        </p>
                        <button class="btn btn-primary ds-action" @click="startScan">
                            <span class="fa fa-qrcode"></span> Scan QR code
                        </button>
                        <button class="btn btn-outline-secondary ds-action" @click="startPaste">
                            <span class="fa fa-keyboard"></span> Enter code manually
                        </button>
                    </template>
                </div>

                <!-- Confirm before touching the network -->
                <div v-else-if="phase === 'confirm'" class="ds-phase">
                    <span class="fa fa-check-circle ds-icon ds-ok"></span>
                    <h4 class="ds-h">Ready to sync</h4>
                    <p class="ds-sub">
                        Solstice will exchange chat logs with Horizon on {{ accountLabel }}. Both devices keep
                        everything they already have and gain whatever the other has.
                    </p>
                    <button class="btn btn-primary ds-action" @click="start">
                        <span class="fa fa-sync"></span> Start sync
                    </button>
                </div>

                <!-- In progress -->
                <div v-else-if="phase === 'running'" class="ds-phase">
                    <span class="fa fa-spinner fa-spin ds-icon"></span>
                    <h4 class="ds-h">{{ stageLabel }}</h4>
                    <p class="ds-sub">Keep both devices on the same network until this finishes.</p>
                </div>

                <!-- Summary -->
                <div v-else-if="phase === 'finished' && result !== undefined" class="ds-phase">
                    <span class="fa fa-check-circle ds-icon ds-ok"></span>
                    <h4 class="ds-h">Sync complete</h4>
                    <div class="ds-summary">
                        <div class="ds-summary-row">
                            <div class="ds-summary-title">Received from {{ result.remoteDeviceName }}</div>
                            <div class="ds-summary-detail">{{ describeStats(result.received) }}</div>
                        </div>
                        <div class="ds-summary-row">
                            <div class="ds-summary-title">Sent to {{ result.remoteDeviceName }}</div>
                            <div class="ds-summary-detail">{{ describeStats(result.sent) }}</div>
                        </div>
                    </div>
                    <p v-if="mergedAnything" class="ds-sub ds-note">
                        New messages appear the next time you open that character's logs.
                    </p>
                    <button class="btn btn-primary ds-action" @click="close">Done</button>
                </div>

                <!-- Error -->
                <div v-else-if="phase === 'error'" class="ds-phase">
                    <span class="fa fa-exclamation-triangle ds-icon ds-warn"></span>
                    <h4 class="ds-h">Sync didn't finish</h4>
                    <p class="ds-sub">{{ errorMessage }}</p>
                    <button class="btn btn-primary ds-action" @click="reset">
                        <span class="fa fa-redo"></span> Try again
                    </button>
                    <button class="btn btn-outline-secondary ds-action" @click="close">Close</button>
                </div>
            </div>
        </div>
    </div>
</template>

<script lang="ts">
    import Vue from 'vue';
    import jsQR from 'jsqr';
    import {appVersion} from './filesystem';
    import {ensureNativeSync} from './nativeSync';
    import {describeSyncError, runSync} from './sync/client';
    import type {SyncResult, SyncStage} from './sync/client';
    import type {MergeStats} from './sync/archive';
    import {NativeSyncStorage} from './sync/nativeStorage';
    import {NativeSyncTransport} from './sync/transport';
    import {parseSessionPayload, SyncError} from './sync/payload';
    import type {SyncSessionPayload} from './sync/payload';

    const STAGE_LABELS: {[stage in SyncStage]: string} = {
        connecting: 'Connecting to Horizon...',
        downloading: 'Downloading Horizon\'s logs...',
        merging: 'Merging into your logs...',
        uploading: 'Sending your logs to Horizon...',
        finishing: 'Finishing up...'
    };

    type Phase = 'choosing' | 'confirm' | 'running' | 'finished' | 'error';

    export default Vue.extend({
        data() {
            return {
                visible: false,
                phase: 'choosing' as Phase,
                scanning: false,
                pasting: false,
                pasteText: '',
                payload: undefined as SyncSessionPayload | undefined,
                stage: 'connecting' as SyncStage,
                result: undefined as SyncResult | undefined,
                errorMessage: '',
                stream: undefined as MediaStream | undefined,
                rafId: 0
            };
        },
        computed: {
            account(): string {
                return String((window as { __generalSettings?: {account?: string} }).__generalSettings?.account ?? '');
            },
            accountLabel(): string { return this.account.length > 0 ? this.account : 'the same account'; },
            isRunning(): boolean { return this.phase === 'running'; },
            isTerminal(): boolean { return this.phase === 'finished' || this.phase === 'error'; },
            stageLabel(): string { return STAGE_LABELS[this.stage]; },
            mergedAnything(): boolean { return this.result !== undefined && this.result.received.messagesAdded > 0; }
        },
        methods: {
            show(): void { this.reset(); this.visible = true; },
            hide(): void { this.stopScan(); this.visible = false; },
            close(): void { if(!this.isRunning) this.hide(); },
            reset(): void {
                this.stopScan();
                this.pasting = false;
                this.pasteText = '';
                this.payload = undefined;
                this.result = undefined;
                this.errorMessage = '';
                this.phase = 'choosing';
            },
            fail(message: string): void { this.stopScan(); this.errorMessage = message; this.phase = 'error'; },

            startPaste(): void {
                this.pasting = true;
                void this.$nextTick(() => (this.$refs.paste as HTMLTextAreaElement | undefined)?.focus());
            },
            cancelPaste(): void { this.pasting = false; this.pasteText = ''; },
            async pasteFromClipboard(): Promise<void> {
                try {
                    const clipboard = (window as {NativeClipboard?: {readText(): Promise<string>}}).NativeClipboard;
                    const text = clipboard !== undefined ? await clipboard.readText() : '';
                    if(text) this.pasteText = String(text);
                } catch {
                    // Clipboard access is best-effort; the user can still type the code.
                }
            },

            async startScan(): Promise<void> {
                this.scanning = true;
                await this.$nextTick();
                const video = this.$refs.video as HTMLVideoElement | undefined;
                if(video === undefined) { this.scanning = false; return; }
                try {
                    this.stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}});
                    video.srcObject = this.stream;
                    await video.play();
                    this.rafId = requestAnimationFrame(() => this.scanTick());
                } catch {
                    this.scanning = false;
                    this.fail('Couldn\'t open the camera. Tap "Enter code manually" to paste the code instead.');
                }
            },
            scanTick(): void {
                const video = this.$refs.video as HTMLVideoElement | undefined;
                const canvas = this.$refs.canvas as HTMLCanvasElement | undefined;
                if(!this.scanning || video === undefined || canvas === undefined) return;
                if(video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    const ctx = canvas.getContext('2d');
                    if(ctx !== null) {
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
                        const code = jsQR(image.data, image.width, image.height, {inversionAttempts: 'dontInvert'});
                        if(code !== null && code.data.length > 0) return this.parse(code.data);
                    }
                }
                this.rafId = requestAnimationFrame(() => this.scanTick());
            },
            stopScan(): void {
                if(this.rafId !== 0) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
                if(this.stream !== undefined) {
                    for(const track of this.stream.getTracks()) track.stop();
                    this.stream = undefined;
                }
                this.scanning = false;
            },

            parse(text: string): void {
                let payload: SyncSessionPayload;
                try {
                    payload = parseSessionPayload(text);
                } catch(error) {
                    return this.fail(error instanceof SyncError
                        ? describeSyncError(error.kind) : 'Couldn\'t read that sync code.');
                }
                if(payload.account.trim().toLowerCase() !== this.account.trim().toLowerCase())
                    return this.fail(describeSyncError(
                        {type: 'accountMismatch', payloadAccount: payload.account, localAccount: this.account}));
                this.stopScan();
                this.pasting = false;
                this.payload = payload;
                this.phase = 'confirm';
            },

            start(): void {
                const payload = this.payload;
                if(payload === undefined) return;
                this.phase = 'running';
                this.stage = 'connecting';
                ensureNativeSync();
                const platform = document.documentElement.dataset.mobileOs === 'ios' ? 'ios' : 'android';
                runSync({
                    payload,
                    transport: new NativeSyncTransport(),
                    store: new NativeSyncStorage(),
                    device: {deviceName: `Solstice on ${platform === 'ios' ? 'iOS' : 'Android'}`, platform, appVersion},
                    localAccount: this.account,
                    onStage: (stage) => { if(this.phase === 'running') this.stage = stage; }
                }).then((result) => {
                    this.result = result;
                    this.phase = 'finished';
                }).catch((error: unknown) => {
                    this.errorMessage = error instanceof SyncError
                        ? describeSyncError(error.kind)
                        : describeSyncError({type: 'badResponse', detail: String(error)});
                    this.phase = 'error';
                });
            },

            describeStats(stats: MergeStats): string {
                if(stats.messagesAdded === 0) return 'Nothing new';
                const conversations = stats.conversationsCreated + stats.conversationsUpdated;
                const messages = `${stats.messagesAdded} message${stats.messagesAdded === 1 ? '' : 's'}`;
                const convs = `${conversations} conversation${conversations === 1 ? '' : 's'}`;
                const created = stats.conversationsCreated > 0 ? ` (${stats.conversationsCreated} new)` : '';
                return `${messages} across ${convs}${created}`;
            }
        },
        beforeDestroy(): void { this.stopScan(); }
    });
</script>

<style scoped>
    .ds-overlay {
        position: fixed;
        inset: 0;
        z-index: 1060;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom);
        background: rgba(0, 0, 0, 0.6);
    }
    .ds-card {
        width: 100%;
        max-width: 460px;
        max-height: 100%;
        overflow-y: auto;
        border-radius: 12px;
        background: var(--bs-body-bg, #17171b);
        color: var(--bs-body-color, #e8e8e8);
        border: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.12));
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
    }
    .ds-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--bs-border-color, rgba(255, 255, 255, 0.12));
    }
    .ds-title { margin: 0; font-size: 1.1rem; }
    .ds-body { padding: 24px 20px; }
    .ds-phase { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 14px; }
    .ds-icon { font-size: 52px; opacity: 0.9; }
    .ds-ok { color: #3fb950; }
    .ds-warn { color: #d29922; }
    .ds-h { margin: 0; font-size: 1.15rem; font-weight: 600; }
    .ds-sub { margin: 0; font-size: 0.9rem; opacity: 0.75; line-height: 1.4; }
    .ds-note { margin-top: 4px; }
    .ds-action { width: 100%; max-width: 320px; }
    .ds-row { display: flex; gap: 10px; width: 100%; max-width: 320px; }
    .ds-row > .btn { flex: 1; }
    .ds-textarea {
        width: 100%;
        max-width: 320px;
        font-family: monospace;
        font-size: 0.8rem;
        resize: vertical;
    }
    .ds-scanner {
        width: 100%;
        max-width: 320px;
        aspect-ratio: 1 / 1;
        border-radius: 12px;
        overflow: hidden;
        background: #000;
    }
    .ds-video { width: 100%; height: 100%; object-fit: cover; }
    .ds-canvas { display: none; }
    .ds-summary {
        width: 100%;
        max-width: 320px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 14px;
        border-radius: 10px;
        background: rgba(127, 127, 127, 0.12);
        text-align: left;
    }
    .ds-summary-title { font-size: 0.9rem; font-weight: 600; }
    .ds-summary-detail { font-size: 0.85rem; opacity: 0.75; }
</style>
