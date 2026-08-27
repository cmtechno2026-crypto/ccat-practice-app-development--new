// Live theme application: a theme's palette is a map of CSS token → hex (e.g. {"--primary":"#8b5cf6"}).
// Applying writes those variables onto <html> so the whole UI repaints instantly; the last applied
// palette is cached in localStorage so the theme paints on the next load before any fetch.
const BASE_KEYS = ['--primary', '--primary-dark', '--tint-blue'];
const LS_KEY = 'cmThemePalette';

export function applyPalette(palette: Record<string, string> | null | undefined): void {
  const root = document.documentElement;
  // Clear any previously-set theme tokens first so switching themes doesn't leave stragglers.
  for (const k of BASE_KEYS) root.style.removeProperty(k);
  if (palette) for (const [k, v] of Object.entries(palette)) if (k.startsWith('--') && typeof v === 'string') root.style.setProperty(k, v);
}

export function storePalette(palette: Record<string, string> | null | undefined): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(palette ?? {})); } catch { /* */ }
}

export function applyStoredPalette(): void {
  try { const p = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (p) applyPalette(p); } catch { /* */ }
}
