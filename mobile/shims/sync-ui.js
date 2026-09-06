// Shim for electron/services/sync/sync-ui in the mobile (WebView) context.
//
// The desktop Device Sync UI hosts an HTTP server via worker_threads, which a
// WebView cannot run. On mobile, syncing happens as a CLIENT through the
// character-select "Device sync" button (mobile/DeviceSyncDialog.vue backed by
// mobile/sync/), so the desktop server code must never be bundled. Aliasing
// sync-ui to these no-op stubs keeps electron/Exporter.vue's references
// resolvable while cutting the worker_threads/http subtree; Exporter.vue hides
// its device-sync section on mobile, so the stubs are never actually called.
module.exports.startSyncSession = () => Promise.resolve();
module.exports.stopSyncSession = () => Promise.resolve();
module.exports.abortSyncForConnectedCharacter = () => {};
module.exports.copySyncPayload = () => {};
module.exports.describeSyncState = () => '';
