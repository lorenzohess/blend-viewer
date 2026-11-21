/** UI toggles remembered between sessions. Storage can be unavailable (private mode, file:// policies): never throw. */
export interface Prefs {
  ortho: boolean;
  wireframe: boolean;
  xray: boolean;
  grid: boolean;
  axes: boolean;
  info: boolean;
  outlinerWidth: number;
}

const KEY = 'blend-viewer:prefs:v1';
const DEFAULTS: Prefs = { ortho: false, wireframe: false, xray: false, grid: true, axes: true, info: true, outlinerWidth: 280 };

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<Prefs>;
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof Prefs)[]) {
      if (typeof p[k] === typeof DEFAULTS[k]) (out as Record<string, unknown>)[k] = p[k];
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: keep the in-memory values */
  }
}
