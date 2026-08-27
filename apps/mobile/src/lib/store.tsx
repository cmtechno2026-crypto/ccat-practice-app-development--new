import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { client } from './api';
import type { StudentProfile, SessionResult } from '@ccat/api-client';

// Minimal app state: auth status + a tiny screen router. A production app would use
// expo-router / react-navigation; this keeps the starter dependency-light and legible.

export type ScreenName = 'welcome' | 'register' | 'login' | 'home' | 'session' | 'result' | 'bookmarks' | 'achievements' | 'recovery' | 'deviceReplace' | 'customize' | 'bookstore';

export interface NavParams { setVersionId?: string; sessionId?: string; result?: SessionResult; }

interface AppState {
  ready: boolean;
  profile: StudentProfile | null;
  screen: ScreenName;
  params: NavParams;
  navigate: (screen: ScreenName, params?: NavParams) => void;
  setProfile: (p: StudentProfile | null) => void;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [screen, setScreen] = useState<ScreenName>('welcome');
  const [params, setParams] = useState<NavParams>({});

  const navigate = useCallback((s: ScreenName, p: NavParams = {}) => { setScreen(s); setParams(p); }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const me = await client.profile();
      setProfile(me);
    } catch {
      setProfile(null);
    }
  }, []);

  const signOut = useCallback(async () => {
    try { await client.logout(); } catch { /* ignore */ }
    setProfile(null);
    navigate('welcome');
  }, [navigate]);

  // On launch, try to resume a session from a stored token.
  useEffect(() => {
    (async () => {
      const token = await client.tokens.getAccess();
      if (token) {
        try { setProfile(await client.profile()); setScreen('home'); } catch { /* token invalid */ }
      }
      setReady(true);
    })();
  }, []);

  // When a profile appears via login/register, land on home.
  useEffect(() => { if (profile && (screen === 'welcome' || screen === 'login' || screen === 'register')) setScreen('home'); }, [profile]);

  return (
    <Ctx.Provider value={{ ready, profile, screen, params, navigate, setProfile, refreshProfile, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used within AppProvider');
  return v;
}
