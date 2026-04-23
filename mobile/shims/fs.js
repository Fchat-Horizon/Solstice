// Shim for 'fs' module in mobile (WebView) context
const noop = () => undefined;
const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

const MOBILE_THEMES = [
    'classic.css', 'dark dimmed.css', 'dark.css', 'default.css', 'dracula.css',
    'light.css', 'mars.css', 'mocha.css', 'moon-prism.css', 'no-exceptions.css',
    'peached.css', 'snowed-in.css', 'wilted-rose.css',
];

module.exports = {
    // Return empty string — Settings.vue wraps this in try/catch; mobile theme is loaded separately
    readFileSync: () => '',
    readdirSync: (dir, options) => {
        if (options && options.withFileTypes) return []; // sound themes listing
        if (dir && dir.toString().includes('theme')) return MOBILE_THEMES;
        return [];
    },
    existsSync: () => false,
    writeFileSync: noop,
    mkdirSync: noop,
    statSync: enoent,
    stat: (_path, cb) => cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
};
