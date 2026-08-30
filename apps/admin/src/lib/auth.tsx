import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setToken, getToken } from './api';

export interface Me { id: string; role: 'admin' | 'super_admin'; email: string; display_name: string; permissions: string[]; }
interface AuthState {
  me: Me | null; ready: boolean;
  login: (email: string, password: string, mfaCode?: string) => Promise<void>;
  changePassword: (changeToken: string, newPassword: string) => Promise<void>;
  logout: () => void;
  can: (perm: string) => boolean;
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

  const login = useCallback(async (email: string, password: string, mfaCode?: string) => {
    const r = await api.login(email, password, mfaCode);
    setToken(r.access_token);
    setMe(await api.me());
  }, []);
  const changePassword = useCallback(async (changeToken: string, newPassword: string) => {
    const r = await api.changePassword(changeToken, newPassword);
    setToken(r.access_token);
    setMe(await api.me());
  }, []);
  const logout = useCallback(() => { setToken(null); setMe(null); }, []);
  const can = useCallback((perm: string) => !!me && (me.role === 'super_admin' || me.permissions.includes(perm)), [me]);

  return <Ctx.Provider value={{ me, ready, login, changePassword, logout, can }}>{children}</Ctx.Provider>;
}
export function useAuth() { const v = useContext(Ctx); if (!v) throw new Error('useAuth outside provider'); return v; }
