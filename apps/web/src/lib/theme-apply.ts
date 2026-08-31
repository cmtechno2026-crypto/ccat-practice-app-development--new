// Live theme application: a theme's palette is a map of CSS token → hex (e.g. {"--primary":"#8b5cf6"}).
// Applying writes those variables onto <html> so the whole UI repaints instantly; the last applied
// palette is cached in localStorage so the theme paints on the next load before any fetch.
const BASE_KEYS = ['--primary', '--primary-dark', '--tint-blue'];
const LS_KEY = 'cmThemePalette';
// Remember every token the last-applied palette set, so switching to a theme that omits a token (or to
// the base default) removes it instead of leaving a straggler (e.g. --app-bg / --card / --ink from a
// gradient or dark theme). Themes can carry any --token, not just BASE_KEYS.
let lastKeys: string[] = [];

export function applyPalette(palette: Record<string, string> | null | undefined): void {
  const root = document.documentElement;
  // Clear the base tokens + anything the previous palette set, so no token strands across a switch.
  for (const k of new Set([...BASE_KEYS, ...lastKeys])) root.style.removeProperty(k);
  const applied: string[] = [];
  if (palette) for (const [k, v] of Object.entries(palette)) {
    if (k.startsWith('--') && typeof v === 'string') { root.style.setProperty(k, v); applied.push(k); }
  }
  lastKeys = applied;
}

export function storePalette(palette: Record<string, string> | null | undefined): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(palette ?? {})); } catch { /* */ }
}

export function applyStoredPalette(): void {
  try { const p = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (p) applyPalette(p); } catch { /* */ }
}
