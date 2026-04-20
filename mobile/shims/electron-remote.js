// Shim for '@electron/remote' module in mobile (WebView) context
const noop = () => undefined;
const fakeWindow = { focus: noop, on: noop, webContents: { send: noop } };
module.exports = {
    dialog: {
        showMessageBoxSync: () => 1,
        showMessageBox: () => Promise.resolve({ response: 1 }),
        showOpenDialogSync: () => undefined,
        showSaveDialogSync: () => undefined,
    },
    getCurrentWindow: () => fakeWindow,
    BrowserWindow: {
        getAllWindows: () => [fakeWindow],
        getFocusedWindow: () => fakeWindow,
    },
    app: {
        getLocale: () => 'en-GB',
        getPath: () => '/',
        getVersion: () => '',
    },
    shell: { openExternal: noop },
};
