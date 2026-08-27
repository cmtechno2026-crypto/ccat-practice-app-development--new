import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { StudentProfile } from '@ccat/api-client';
import { DEFAULT_APP_CONFIG, type AppConfig } from '@ccat/client-core';
import { client } from './api';
import { applyStoredPalette } from './theme-apply';

// App-level state shared across screens: auth/profile + app-config (channel gate) + a toast.
// Screen NAVIGATION uses react-router (URLs); this store holds cross-cutting state only, so web and
// mobile keep the same state shape while differing only in the router technology.

interface AppState {
  ready: boolean;
  profile: StudentProfile | null;
  appConfig: AppConfig;
  toast: string | null;
  setProfile: (p: StudentProfile | null) => void;
  refreshProfile: () => Promise<StudentProfile | null>;
  signOut: () => Promise<void>;
  flash: (msg: string) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [appConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG); // flag-ready; see client-core note
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout((flash as any)._t);
    (flash as any)._t = window.setTimeout(() => setToast(null), 1800);
  }, []);

  const refreshProfile = useCallback(async () => {
    try { const me = await client.profile(); setProfile(me); return me; }
    catch { setProfile(null); return null; }
  }, []);

  const signOut = useCallback(async () => {
    try { await client.logout(); } catch { /* ignore */ }
    setProfile(null);
  }, []);

  // Resume from a stored token on load.
  useEffect(() => {
    applyStoredPalette(); // paint the last-equipped theme before any fetch, so no flash of base colors
    (async () => {
      const tok = await client.tokens.getAccess();
      if (tok) { try { setProfile(await client.profile()); } catch { /* invalid */ } }
      setReady(true);
    })();
  }, []);

  return (
    <Ctx.Provider value={{ ready, profile, appConfig, toast, setProfile, refreshProfile, signOut, flash }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used within AppProvider');
  return v;
}
