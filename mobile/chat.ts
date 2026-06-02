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
import {init as initCore} from '../chat/core';
import Socket from '../chat/WebSocket';
import Connection from '../fchat/connection';
import {appVersion, GeneralSettings, Logs, SettingsStore} from './filesystem';
import Index from './Index.vue';
import Notifications from './notifications';

const version = (<{version: string}>require('./package.json')).version; //tslint:disable-line:no-require-imports
(<any>window)['setupPlatform'] = (platform: string) => { //tslint:disable-line:no-any
    Axios.defaults.params = { __fchat: `mobile-${platform}/${version}` };
};
document.documentElement.dataset.mobilePlatform = 'true';
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

const connection = new Connection('Solstice (Mobile)', appVersion, Socket);
initCore(connection, new GeneralSettings() as any, Logs, SettingsStore, Notifications);

new Index({ //tslint:disable-line:no-unused-expression
    el: '#app'
});
