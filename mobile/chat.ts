/**
 * @license
 * Originally licensed under MIT License
 *
 * Copyright (c) 2018-2026 Dragonfruit Ventures, LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---
 *
 * This file is now also licensed under MPL-2.0 (see LICENSE.md).
 * Modifications made after the original MIT release are licensed under MPL-2.0.
 *
 * This license header applies to this file and all of the non-third-party assets it includes.
 * @file The entry point for the mobile version of F-Chat 3.0.
 * @copyright 2018-2026 Dragonfruit Ventures, LLC
 * @copyright 2024-2026 Sylvia Roselie & Respective Horizon Contributors
 * @version 1.0
 * @see {@link https://github.com/Fchat-Horizon/Horizon|GitHub repo}
 * @author Maya Wolf <maya@f-list.net>
 * @version 3.0
 * @see {@link https://github.com/f-list/exported|GitHub repo}
 */
import Axios from 'axios';
import Vue from 'vue';
import {ipcMain} from 'electron';
import core, {init as initCore} from '../chat/core';
import {AdCoordinatorHost} from '../chat/ads/ad-coordinator-host';
import Socket from '../chat/WebSocket';
import NativeSocketConnection from './NativeSocketConnection';
import Connection from '../fchat/connection';
import {appVersion, GeneralSettings, Logs, SettingsStore} from './filesystem';
import Index from './Index.vue';
import Notifications from './notifications';
import {sendNotifyConfig, clearConversationNotification} from './notifyConfig';
import {EventBus, SelectConversationEvent} from '../chat/preview/event-bus';

const version = (<{version: string}>require('./package.json')).version; //tslint:disable-line:no-require-imports
(<any>window)['setupPlatform'] = (platform: string) => { //tslint:disable-line:no-any
    Axios.defaults.params = { __fchat: `mobile-${platform}/${version}` };
    // Record which native host we're running under ('android' | 'ios') so platform-specific
    // paths (e.g. the iOS import picker in AppExporterDialog) can branch on it.
    document.documentElement.dataset.mobileOs = platform;
};
document.documentElement.dataset.mobilePlatform = 'true';

// Resilience + diagnostics for the intermittent Android soft-lock (whole UI stops responding;
// buttons still highlight on tap but nothing functions until the app is restarted).
//
// Root cause: something mutates the DOM out from under Vue (in-WebView translation rewriting text
// nodes, IME composition, autofill, accessibility services). When Vue then patches that subtree,
// Node.removeChild/insertBefore throws a DOMException. Vue 2 does NOT catch errors thrown during
// patch (only render-function errors), so the throw escapes flushSchedulerQueue before its state is
// reset, leaving the scheduler's `waiting`/`flushing` flags stuck. From then on no component ever
// re-renders: event handlers still run and mutate state, but the DOM is frozen. The scheduler flush
// runs inside Vue's nextTick, whose wrapper catches the throw and routes it to Vue.config.errorHandler
// with info "nextTick" (verified on-device: a forced patch throw logged as "vue.errorHandler
// (nextTick)"). It still wedges, because that catch is reached only after the scheduler left its
// waiting/flushing state dirty. The window 'error'/'unhandledrejection' listeners below are
// defense-in-depth for errors raised outside Vue's wrappers.
function installResilience(): void {
    installSchedulerGuard();
    installDomGuards();
    installErrorCapture();
}

// Best-effort crash log persisted via the native file bridge (same store mobile/filesystem.ts uses
// for '!settings'). Keeps newest-first, capped, never throws.
//
// Privacy: this file is meant to be shareable in a bug report, so it must NEVER contain user content
// (chat messages, character names, credentials). We record ONLY the error TYPE (name) and the
// call-frame lines of the stack (code locations: file:line:col, no argument values). We deliberately
// drop error.message and any non-Error thrown/rejected value, because those can embed parsed input
// (e.g. a JSON.parse snippet of a chat frame) or interpolated user data. The first line of a V8 stack
// repeats "Name: message", so it is stripped too.
const CRASHLOG_MAX = 32 * 1024;
let crashLogBusy = false;
function safeStack(stack: string): string {
    // Keep only "    at ..." frame lines; drop the leading "Name: message" line and anything else.
    return stack.split('\n').filter((l) => /^\s*at\s/.test(l)).join('\n');
}
function describeError(err: unknown): {name: string; stack: string} {
    const e = err as {name?: unknown; stack?: unknown} | null | undefined;
    if (e !== null && e !== undefined && (typeof e.stack === 'string' || typeof e.name === 'string')) {
        const name = typeof e.name === 'string' && e.name.length > 0 ? e.name : 'Error';
        return {name, stack: typeof e.stack === 'string' ? safeStack(e.stack) : ''};
    }
    // Primitive/plain value thrown or rejected: record its type only, never the value.
    return {name: `non-Error (${err === null ? 'null' : typeof err})`, stack: ''};
}
function formatError(label: string, err: unknown): string {
    const when = new Date().toISOString();
    const {name, stack} = describeError(err);
    return `[${when}] ${label}: ${name}\n${stack}\n\n`;
}
async function persistCrash(entry: string): Promise<void> {
    if (crashLogBusy) return; // avoid interleaved read/write storms during an error burst
    crashLogBusy = true;
    try {
        if (typeof NativeFile === 'undefined' || NativeFile.write === undefined) return;
        let existing = '';
        try { existing = (await NativeFile.read('!crashlog')) || ''; } catch { existing = ''; }
        let combined = entry + existing;
        if (combined.length > CRASHLOG_MAX) combined = combined.slice(0, CRASHLOG_MAX);
        await NativeFile.write('!crashlog', combined);
    } catch {
        // best-effort only
    } finally {
        crashLogBusy = false;
    }
}
function logCrash(label: string, err: unknown): void {
    try {
        console.error(`[crash] ${label}`, err); //tslint:disable-line:no-console
        void persistCrash(formatError(label, err));
    } catch {
        // the logger must never throw
    }
}

// Lightweight diagnostic breadcrumbs written to the same exportable '!crashlog' as crashes: JS boots,
// app foreground/background transitions, and connection lifecycle. This exists to diagnose the iOS
// "disconnects on return from background" report: a WebContent jetsam kill leaves NO JS trace (the
// process is SIGKILLed), but the reload it forces does - so a `boot` entry appearing shortly after a
// `visibility hidden`, with no clean `conn closed` in between, is the fingerprint of iOS jetsam-killing
// the backgrounded WebView, which is why the connection drops. Reverse-chronological like the rest of
// the file. Records only state labels - never names, messages, or any user content.
function logDiag(label: string, detail?: string): void {
    try {
        const when = new Date().toISOString();
        void persistCrash(`[${when}] ${label}${detail !== undefined ? ' ' + detail : ''}\n`);
    } catch {
        // diagnostics must never throw
    }
}

function installErrorCapture(): void {
    window.addEventListener('error', (event: ErrorEvent) =>
        logCrash('window.onerror', event.error !== undefined ? event.error : event.message));
    // The patch-time throw that wedges the scheduler arrives here (unhandled microtask rejection).
    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) =>
        logCrash('unhandledrejection', event.reason));
    // Catches everything Vue routes through handleError: render functions, watchers, lifecycle, v-on
    // handlers, AND the scheduler-flush throw that causes the soft-lock (logged with info "nextTick").
    Vue.config.errorHandler = (err: Error, _vm: Vue, info: string) =>
        logCrash(`vue.errorHandler (${info})`, err);
}

// THE structural fix for the soft-lock class. The Vue 2 scheduler (vue/.../scheduler.js
// flushSchedulerQueue) runs every watcher.run() in a bare for-loop with NO try/catch, and only clears
// its `waiting`/`flushing` flags in resetSchedulerState() AFTER the loop finishes. So if a single
// watcher.run() throws during patch (a DOM op on a node some other agent moved, a render/destroy edge
// case, literally anything), the throw escapes the loop, resetSchedulerState() never runs, `waiting`
// stays true forever, and queueWatcher()'s `if (!waiting)` guard means no future flush is EVER
// scheduled. From that instant nothing re-renders: handlers still fire and mutate state, but the DOM
// is frozen until the app is restarted.
//
// We have been guarding the individual *sources* of patch throws (the notranslate attribute, the
// removeChild/insertBefore guards below). That is whack-a-mole: the set of things that can mutate the
// DOM out from under Vue (translation, IME, autofill, accessibility, password managers, future
// unknowns) is unbounded, so a new source = a new total freeze. This instead guards the
// *amplification*: wrap Watcher.prototype.run so a throw is logged and contained to that one watcher.
// The flush loop then always completes, resetSchedulerState() always runs, and a single bad patch can
// never wedge the whole app again. The affected component is left until its next successful render
// instead of freezing everything. This is exactly what Vue 3 does natively; we are backporting it.
let schedulerGuardReported = false;
function installSchedulerGuard(): void {
    try {
        // Vue 2.7 dropped vm._watchers, but the render watcher is still stored as vm._watcher. Mount a
        // throwaway off-document instance purely to obtain the Watcher class, then patch its shared
        // prototype (which every watcher in the app uses).
        //tslint:disable-next-line:no-any
        const probe = new Vue({ render: (h: any) => h('div') });
        probe.$mount();
        //tslint:disable-next-line:no-any
        const renderWatcher = (probe as any)._watcher;
        probe.$destroy();
        const proto = renderWatcher && (renderWatcher.constructor as { prototype?: { run?: unknown } }).prototype;
        if (!proto || typeof proto.run !== 'function') {
            logCrash('scheduler-guard', new Error(
                'Could not locate Vue Watcher.prototype.run; soft-lock guard NOT installed.'));
            return;
        }
        const originalRun = proto.run as (this: unknown) => void;
        proto.run = function(this: unknown): void {
            try {
                originalRun.call(this);
            } catch (e) {
                // Critical: do NOT rethrow. Rethrowing would abort flushSchedulerQueue again and
                // re-wedge the scheduler, which is the exact bug we are containing.
                try {
                    console.error('[scheduler-guard] contained watcher.run error', e); //tslint:disable-line:no-console
                    if (!schedulerGuardReported) {
                        schedulerGuardReported = true; // persist only the first hit per session (avoid write storms)
                        logCrash('watcher.run (contained)', e);
                    }
                } catch {
                    // the guard must never throw
                }
            }
        };
    } catch (e) {
        // If anything here fails we simply run without the guard (the DOM guards below still help).
        logCrash('scheduler-guard install', e);
    }
}

// Guard the two DOM mutations Vue performs during patch so a desync (a node that is no longer where
// Vue's vnode tree expects) logs and no-ops instead of throwing. This is the established Vue 2 +
// translation workaround; it makes the soft-lock impossible regardless of which agent moved the node.
let domGuardReported = false;
function reportDomGuard(method: string): void {
    try {
        console.warn(`[dom-guard] blocked Node.${method}: target is not the node's parent`); //tslint:disable-line:no-console
        if (!domGuardReported) {
            domGuardReported = true; // persist only the first hit per session to avoid log spam
            logCrash(`dom-guard ${method}`, new Error(
                `Node.${method} blocked: reference node is not a child of the target ` +
                `(DOM was mutated out from under Vue).`));
        }
    } catch {
        // ignore
    }
}
function installDomGuards(): void {
    //tslint:disable:no-any no-invalid-this
    const proto = Node.prototype as any;
    const originalRemoveChild = proto.removeChild as (child: Node) => Node;
    proto.removeChild = function(this: Node, child: Node): Node {
        if (child.parentNode !== this) {
            reportDomGuard('removeChild');
            return child;
        }
        return originalRemoveChild.call(this, child);
    };
    const originalInsertBefore = proto.insertBefore as (newNode: Node, ref: Node | null) => Node;
    proto.insertBefore = function(this: Node, newNode: Node, ref: Node | null): Node {
        // insertBefore(node, null) is a valid append; only a non-null ref with the wrong parent throws.
        if (ref !== null && ref.parentNode !== this) {
            reportDomGuard('insertBefore');
            return newNode;
        }
        return originalInsertBefore.call(this, newNode, ref);
    };
    //tslint:enable:no-any no-invalid-this
}

// Install the guards + error capture before the app mounts (new Index(...) below).
if (document.documentElement.dataset.mobilePlatform === 'true') installResilience();

// Background-disconnect diagnostics (see logDiag): record each JS boot and every foreground/background
// transition. On iOS the app process is held alive by the audio keep-alive, but iOS can still
// jetsam-kill the WebContent child while backgrounded; that shows up here as a `boot` right after a
// `visibility hidden` (the WebView reloaded and reconnected fresh).
if (document.documentElement.dataset.mobilePlatform === 'true') {
    logDiag('boot', document.documentElement.dataset.mobileOs);
    document.addEventListener('visibilitychange', () =>
        logDiag('visibility', document.visibilityState));
}

// Issue 10: long-pressing a link/eicon/avatar can start a native HTML5 drag of the element, which on
// touch leaves the WebView in a stuck gesture state that swallows subsequent taps (the app appears
// frozen until restart). The CSS in Index.vue sets `-webkit-user-drag: none`, but not every WebView
// build honors it, so also suppress drag-and-drop outright. Nothing in the mobile UI uses native
// drag (Sortable reordering uses touch events on mobile), so a blanket dragstart cancel is safe.
if (document.documentElement.dataset.mobilePlatform === 'true')
    document.addEventListener('dragstart', (e: Event) => e.preventDefault(), true);

// window.open() is a no-op in the Android WebView — route all calls through location.href
// so shouldOverrideUrlLoading can intercept and handle them.
(window as any).open = (url: string) => { window.location.href = url; return null; };

// navigator.clipboard is unreliable in the file:// (non-secure) WebView context —
// it may be absent, or present but permission-denied (NotAllowedError on write).
// Always route clipboard access through the native bridge on mobile.
declare const NativeClipboard: { writeText(text: string): void; readText(): string };
const nativeClipboard = {
    writeText: (text: string) => { NativeClipboard.writeText(text); return Promise.resolve(); },
    readText: () => Promise.resolve(NativeClipboard.readText())
};
try {
    Object.defineProperty(navigator, 'clipboard', { value: nativeClipboard, configurable: true });
} catch {
    (navigator as any).clipboard = nativeClipboard;
}

// notifications.ts loads sound themes via window.require('fs'/'path'), which only
// exists in Electron. Expose the shimmed modules so themed sounds work in the WebView.
//tslint:disable-next-line:no-require-imports no-any
(window as any).require = (mod: string) =>
    mod === 'fs' ? require('fs') : mod === 'path' ? require('path') : undefined;

// Expose the bundled chat theme names so the Settings theme picker has options on mobile (the
// desktop path lists them from disk via fs, which doesn't exist in the WebView).
//tslint:disable-next-line:no-require-imports no-any
const themeContext = (require as any).context('../scss/themes/chat', false, /\.scss$/);
(window as any).__availableThemes = themeContext.keys() //tslint:disable-line:no-any
    .map((k: string) => k.replace(/^\.\//, '').replace(/\.scss$/, ''))
    .sort();

// Same for the sound themes (audiopacks): the Settings sound-theme picker lists these on mobile.
//tslint:disable-next-line:no-require-imports no-any
const soundThemeContext = (require as any).context('../chat/sound-themes', true, /sound\.json$/);
(window as any).__availableSoundThemes = soundThemeContext.keys() //tslint:disable-line:no-any
    .map((k: string) => k.replace(/^\.\//, '').replace(/\/sound\.json$/, ''))
    .sort();

// On iOS the WebSocket runs natively (NativeSocket.swift) so it survives backgrounding; bridge.js
// defines window.NativeSocket there. Android keeps the connection alive via its foreground service,
// so it uses the in-WebView browser socket. window.NativeSocket is set at document-start, before
// this runs, so it is a reliable iOS check.
const SocketProvider = (window as any).NativeSocket !== undefined ? NativeSocketConnection : Socket; //tslint:disable-line:no-any
const connection = new Connection('Solstice (Mobile)', appVersion, SocketProvider);
initCore(connection, new GeneralSettings() as any, Logs, SettingsStore, Notifications);

// Background-disconnect diagnostics (see logDiag): log the connection lifecycle so the exported log
// shows how often, and how, the socket drops. `closed (unexpected)` is an unclean close the JS
// actually saw (network drop, PIN-timeout close); a `boot` with no preceding `closed` means the
// WebView was killed (jetsam) and reconnected fresh - the two are distinguished in the log.
if (document.documentElement.dataset.mobilePlatform === 'true') {
    connection.onEvent('connecting', () => logDiag('conn', 'connecting'));
    connection.onEvent('connected', (isReconnect: boolean) =>
        logDiag('conn', isReconnect ? 'connected (reconnect)' : 'connected'));
    connection.onEvent('closed', (unclean: boolean) =>
        logDiag('conn', unclean ? 'closed (unexpected)' : 'closed (clean)'));
    connection.onError((e: Error) => logDiag('conn-error', describeError(e).name));
}

// On iOS the native socket fires notifications for messages that arrive while the app is
// backgrounded (JS is suspended then). Push the full background-notify config (character, ignore/mute
// lists, per-channel highlight/watched/notify settings and room titles) so native can reproduce the
// foreground decision; mobile/Index.vue re-pushes it whenever that state changes. Re-sent on every
// (re)connect.
if ((window as any).NativeSocket !== undefined) { //tslint:disable-line:no-any
    connection.onEvent('connected', () => {
        sendNotifyConfig();
        // Prime the native sound theme so background notifications use it even before any sound has
        // played in the foreground.
        const soundTheme = (core.state as any).generalSettings?.soundTheme //tslint:disable-line:no-any
            || core.state.settings.soundTheme || 'default';
        (window as any).NativeNotification.setSoundTheme(soundTheme); //tslint:disable-line:no-any
    });
}

// Discord-style: opening a conversation clears its background notification and drops the unread badge,
// on BOTH platforms (iOS via NativeSocket.clearConversation, Android via NativeNotification.cancelConversation).
// select-conversation also fires on a notification tap (mobile/notifications.ts -> conv.show()).
if (document.documentElement.dataset.mobilePlatform === 'true')
    EventBus.$on('select-conversation', (data: SelectConversationEvent) => {
        if (data.conversation !== null) clearConversationNotification(data.conversation.key);
    });

// On desktop the ad coordinator host lives in the Electron main process; on mobile there
// is no main process, so host it here in the WebView. Without this, the guest's
// requestTurnToPostAd() never resolves and the shared posting throat deadlocks, which
// freezes the send button, enter-to-send and auto-ads (issue #2).
const adCoordinator = new AdCoordinatorHost();
ipcMain.on('request-send-ad', (event: any, adId: string) => //tslint:disable-line:no-any
    adCoordinator.processAdRequest(event, adId));

new Index({ //tslint:disable-line:no-unused-expression
    el: '#app'
});
