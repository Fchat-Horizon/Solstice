// Shim for 'electron/filesystem' module in mobile (WebView) context
// Only exports used by learn/conversation-draft-cache are needed
const noop = () => undefined;
module.exports = {
    getDrafts: () => ({}),
    saveDrafts: () => Promise.resolve(),
};
