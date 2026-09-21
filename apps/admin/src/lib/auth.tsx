import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setToken, getToken, setSite, getSite } from './api';

export interface Me { id: string; role: 'admin' | 'super_admin'; email: string; display_name: string; permissions: string[]; sites?: string[]; active_site?: string; }
interface AuthState {
  me: Me | null; ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  can: (perm: string) => boolean;
  sites: string[];               // sites this admin may access (>=1)
  activeSite: string;            // site the console is currently scoped to
  switchSite: (site: string) => void;
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      if (getToken()) { try { setMe(await api.me()); } catch { setToken(null); } }
      setReady(true);
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password);
    setToken(r.access_token);
    setMe(await api.me());
  }, []);
  const logout = useCallback(() => { setToken(null); setMe(null); }, []);
  const can = useCallback((perm: string) => !!me && (me.role === 'super_admin' || me.permissions.includes(perm)), [me]);

  const sites = (me?.sites && me.sites.length ? me.sites : ['ccat']);
  const activeSite = (getSite() || me?.active_site || 'ccat');
  // Switching reloads to the target site's home so every page re-fetches under the new site header.
  const switchSite = useCallback((site: string) => {
    setSite(site === 'ccat' ? null : site); // ccat is the gateway default → no header needed
    window.location.assign(site === 'teacher' ? '/teacher' : '/');
  }, []);

  return <Ctx.Provider value={{ me, ready, login, logout, can, sites, activeSite, switchSite }}>{children}</Ctx.Provider>;
}
export function useAuth() { const v = useContext(Ctx); if (!v) throw new Error('useAuth outside provider'); return v; }
