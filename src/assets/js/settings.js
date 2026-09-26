const KEY = 'echo-panel-settings'
const THEMES = ['dark', 'midnight', 'rose', 'forest']
const DEFAULTS = { scale: 1, theme: 'dark' }

const MIN_SCALE = 0.5
const MAX_SCALE = 2
const BASE_FONT_PX = 16

export function loadSettings() {
    try {
        const saved = {
            ...DEFAULTS,
            ...JSON.parse(localStorage.getItem(KEY) || '{}'),
        }
        // guard against stale values from older builds
        if (!(saved.scale >= MIN_SCALE && saved.scale <= MAX_SCALE))
            saved.scale = DEFAULTS.scale
        if (!THEMES.includes(saved.theme)) saved.theme = DEFAULTS.theme
        return saved
    } catch {
        return { ...DEFAULTS }
    }
}

export function saveSettings(settings) {
    localStorage.setItem(KEY, JSON.stringify(settings))
}

export function applySettings(settings) {
    document.documentElement.style.fontSize = `${BASE_FONT_PX * settings.scale}px`
    document.documentElement.dataset.theme = settings.theme
}
