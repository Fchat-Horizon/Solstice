// Shim for '@electron/remote' module in mobile (WebView) context
const noop = () => undefined;
const fakeWindow = {
    focus: noop,
    minimize: noop,
    on: noop,
    close: () => window.dispatchEvent(new CustomEvent('settings-window-close')),
    webContents: {
        send: noop,
        session: { availableSpellCheckerLanguages: [] },
    },
};
module.exports = {
    dialog: {
        showMessageBoxSync: ({ message }) => (window.confirm(message) ? 0 : 1),
        showMessageBox: () => Promise.resolve({ response: 1 }),
        showOpenDialogSync: () => undefined,
        showSaveDialogSync: () => undefined,
        showErrorBox: noop,
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
    nativeTheme: { shouldUseDarkColors: false, on: noop },
    session: { defaultSession: { availableSpellCheckerLanguages: [] } },
};
