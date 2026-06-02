// Shim for 'fs' module in mobile (WebView) context
const noop = () => undefined;
const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

const MOBILE_THEMES = [
    'classic.css', 'dark dimmed.css', 'dark.css', 'default.css', 'dracula.css',
    'light.css', 'mars.css', 'mocha.css', 'moon-prism.css', 'no-exceptions.css',
    'peached.css', 'snowed-in.css', 'wilted-rose.css',
];

// Bundle every sound theme's sound.json so notifications.ts (which loads them via
// window.require('fs').readFileSync) can read them without real filesystem access.
const soundThemeJson = require.context('../../chat/sound-themes', true, /sound\.json$/);
// Theme directory names derived from the bundled sound.json keys ('./Ocean/sound.json' -> 'Ocean').
const SOUND_THEME_NAMES = soundThemeJson
    .keys()
    .map(k => (/^\.\/([^/]+)\/sound\.json$/.exec(k) || [])[1])
    .filter(Boolean);
function readSoundThemeJson(filePath) {
    const match = /sound-themes\/([^/]+)\/sound\.json$/.exec(String(filePath).replace(/\\/g, '/'));
    if (!match) return null;
    try {
        return JSON.stringify(soundThemeJson(`./${match[1]}/sound.json`));
    } catch (e) {
        return null;
    }
}

module.exports = {
    // Sound-theme JSON is served from the bundle; everything else returns '' —
    // Settings.vue wraps readFileSync in try/catch and the mobile theme CSS is loaded separately.
    readFileSync: (filePath) => {
        const themeJson = readSoundThemeJson(filePath);
        return themeJson !== null ? themeJson : '';
    },
    readdirSync: (dir, options) => {
        const p = dir ? String(dir).replace(/\\/g, '/') : '';
        if (options && options.withFileTypes) {
            // sound-themes listing: one Dirent-like entry per bundled theme
            if (p.includes('sound-themes'))
                return SOUND_THEME_NAMES.map(name => ({ name, isDirectory: () => true }));
            return [];
        }
        if (p.includes('theme')) return MOBILE_THEMES; // CSS themes
        return [];
    },
    existsSync: (p) => {
        const match = /sound-themes\/([^/]+)\/sound\.json$/.exec(String(p).replace(/\\/g, '/'));
        return match ? SOUND_THEME_NAMES.includes(match[1]) : false;
    },
    writeFileSync: noop,
    mkdirSync: noop,
    statSync: enoent,
    stat: (_path, cb) => cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
};
