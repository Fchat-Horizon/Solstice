// Shim for 'archiver' in mobile (WebView) context — zip operations handled natively in Kotlin
const noop = () => stream;
const stream = {
    append: noop,
    directory: noop,
    file: noop,
    glob: noop,
    finalize: () => Promise.resolve(),
    on: noop,
    pipe: noop,
    pointer: () => 0,
    abort: noop,
};
module.exports = function archiver() { return stream; };
module.exports.create = module.exports;
