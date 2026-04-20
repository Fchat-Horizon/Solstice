// Shim for 'electron-log' module in mobile (WebView) context
const noop = () => undefined;
const log = { debug: noop, info: noop, warn: noop, error: noop, verbose: noop, silly: noop };
module.exports = log;
module.exports.default = log;
