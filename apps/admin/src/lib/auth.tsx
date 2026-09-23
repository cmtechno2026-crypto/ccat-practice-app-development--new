import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setToken, setRefresh, getToken, getRefresh } from './api';

export interface Me { id: string; role: 'admin' | 'super_admin'; email: string; display_name: string; permissions: string[]; }
interface AuthState {
  me: Me | null; ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  can: (perm: string) => boolean;
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      // Resume when we have an access token OR just a refresh token: api.me() auto-refreshes on a 401, so an
      // expired 15-min access token (or a tab that cleared sessionStorage) renews silently from the stored
      // refresh token instead of bouncing the admin to the sign-in screen.
      if (getToken() || getRefresh()) {
        try { setMe(await api.me()); } catch { setToken(null); setRefresh(null); }
      }
      setReady(true);
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password);
    setToken(r.access_token);
    if (r.refresh_token) setRefresh(r.refresh_token);
    setMe(await api.me());
  }, []);
  const logout = useCallback(() => { setToken(null); setRefresh(null); setMe(null); }, []);
  const can = useCallback((perm: string) => !!me && (me.role === 'super_admin' || me.permissions.includes(perm)), [me]);

  return <Ctx.Provider value={{ me, ready, login, logout, can }}>{children}</Ctx.Provider>;
}
export function useAuth() { const v = useContext(Ctx); if (!v) throw new Error('useAuth outside provider'); return v; }
