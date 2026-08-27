import { CcatClient, type TokenStore, type TokenPair } from '@ccat/api-client';

// Gateway base URL is the ONLY required config (VITE_GATEWAY_URL). No Supabase key, no secrets.
const baseUrl: string =
  (import.meta.env.VITE_GATEWAY_URL as string | undefined)?.replace(/\/$/, '') || 'http://localhost:8080';

// Web token store: access token in memory (stateless, cache-friendly), refresh token in
// localStorage so a reload can resume. Mirrors the mobile SecureStore store's shape — same
// identity model, platform-appropriate storage.
const ACCESS = 'ccat_access';
const REFRESH = 'ccat_refresh';
let accessMem: string | null = sessionStorage.getItem(ACCESS);

export const webTokenStore: TokenStore = {
  getAccess() { return accessMem; },
  getRefresh() { try { return localStorage.getItem(REFRESH); } catch { return null; } },
  set(t: TokenPair) {
    accessMem = t.access_token;
    try { sessionStorage.setItem(ACCESS, t.access_token); localStorage.setItem(REFRESH, t.refresh_token); } catch { /* private mode */ }
  },
  clear() {
    accessMem = null;
    try { sessionStorage.removeItem(ACCESS); localStorage.removeItem(REFRESH); } catch { /* ignore */ }
  },
};

// fetch must be invoked with `this === window` in browsers; the shared client stores the impl and
// calls it as `this.f(...)`, so bind it here to avoid "Illegal invocation".
export const client = new CcatClient({ baseUrl, tokens: webTokenStore, fetchImpl: window.fetch.bind(window) });
export const gatewayUrl = baseUrl;

// Stable per-browser device id — the web analog of the mobile per-install id. Preserves the
// gateway's single-enrolled-device model (device replacement swaps it).
export function getDeviceHash(): string {
  try {
    let id = localStorage.getItem('ccat_device');
    if (!id) {
      id = `web_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)}`;
      localStorage.setItem('ccat_device', id);
    }
    return id;
  } catch {
    return 'web_ephemeral';
  }
}
