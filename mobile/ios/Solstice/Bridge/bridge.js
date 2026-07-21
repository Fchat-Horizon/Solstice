// Injected at document-start (before chat.js) by WebViewController.
//
// Android exposes its native bridges as synchronous objects via addJavascriptInterface.
// iOS has no synchronous bridge, so we register one WKScriptMessageHandlerWithReply per
// Native* object (each postMessage returns a Promise) and recreate the same global objects
// the web layer expects: NativeFile, NativeLogs, NativeNotification, NativeClipboard,
// NativeBackground, NativeView. Method calls forward to the matching message handler and
// return its Promise, which lines up with the Promise-typed TypeScript contracts in
// mobile/filesystem.ts, notifications.ts, chat.ts and Index.vue.
//
// Because we author this shim we expose the clean method names directly (listFiles, init,
// getBacklog, …) and return already-parsed values from Swift — so none of the Android
// `…N` + JSON.parse wrappers are needed.
(function () {
  function make(handlerName, methods) {
    var handler = window.webkit && window.webkit.messageHandlers
      ? window.webkit.messageHandlers[handlerName]
      : undefined;
    var obj = {};
    methods.forEach(function (method) {
      obj[method] = function () {
        var args = Array.prototype.slice.call(arguments);
        if (!handler) return Promise.reject(new Error('native bridge unavailable: ' + handlerName));
        return handler.postMessage({ method: method, args: args });
      };
    });
    return obj;
  }

  window.NativeFile = make('nativeFile', [
    'read', 'getSize', 'readBytes', 'delete', 'write', 'writeBytes',
    'listDirectories', 'listFiles', 'ensureDirectory',
    'exportData', 'exportCrashLog', 'pickImportFile'
  ]);

  window.NativeLogs = make('nativeLogs', [
    'init', 'getCharacters', 'loadIndex',
    'logMessage', 'getBacklog', 'getLogs', 'repair'
  ]);

  window.NativeNotification = make('nativeNotification', [
    'notify', 'playSound', 'requestPermission', 'setSoundTheme'
  ]);

  window.NativeClipboard = make('nativeClipboard', ['writeText', 'readText']);

  window.NativeBackground = make('nativeBackground', ['start', 'stop']);

  window.NativeView = make('nativeView', ['setTheme']);

  // The F-List WebSocket runs natively (NativeSocket.swift) so it survives backgrounding; its
  // presence is also how mobile/chat.ts detects iOS and picks the native transport. Events come
  // back via window.__nativeSocketEvent, defined by mobile/NativeSocketConnection.ts.
  window.NativeSocket = make('nativeSocket', ['connect', 'send', 'close', 'setNotifyConfig', 'clearConversation']);

  // Native HTTP for the LAN log sync session (NativeSync.swift). request(method, url, headers,
  // bodyBase64, timeoutMs) resolves to { status, bodyBase64 }, or rejects on a connection failure.
  window.NativeSync = make('nativeSync', ['request']);
})();
