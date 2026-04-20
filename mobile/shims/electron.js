// Shim for 'electron' module in mobile (WebView) context
const noop = () => undefined;
module.exports = {
    app: {
        getLocale: () => 'en-GB',
        getPath: () => '/',
        getVersion: () => '',
        getLocaleCountryCode: () => '',
    },
    shell: { openExternal: noop, openPath: noop },
    clipboard: { writeText: noop, readText: () => '' },
    ipcRenderer: { on: noop, send: noop, removeListener: noop, invoke: () => Promise.resolve() },
};
