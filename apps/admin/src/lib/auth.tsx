import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { api, setToken, setRefresh, getToken, getRefresh, setAdminSite } from './api';

export interface Me { id: string; role: 'admin' | 'super_admin'; email: string; display_name: string; permissions: string[]; is_teacher?: boolean; programs?: string[]; }
interface AuthState {
  me: Me | null; ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  can: (perm: string) => boolean;
  sites: string[]; activeSite: string; switchSite: (site: string) => void;
  program: 'ccat' | 'ngat' | 'math'; setProgram: (p: 'ccat' | 'ngat' | 'math') => void;
  allowedPrograms: ('ccat' | 'ngat' | 'math')[];
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  // Multi-site (CCAT / Teacher Hub) switcher state — consumed by Layout. Persisted per-admin.
  const [activeSite, setActiveSite] = useState<string>(() => { try { return localStorage.getItem('ccat_admin_site') || 'ccat'; } catch { return 'ccat'; } });
  const switchSite = useCallback((site: string) => { setActiveSite(site); setAdminSite(site); try { localStorage.setItem('ccat_admin_site', site); } catch { /* ignore */ } }, []);
  // Program (CCAT / NGAT) — the content/teacher workspace dimension, independent of activeSite. Persisted per-admin.
  const [program, setProgramState] = useState<'ccat' | 'ngat' | 'math'>(() => { try { return (localStorage.getItem('ccat_admin_program') as 'ccat' | 'ngat' | 'math') || 'ccat'; } catch { return 'ccat'; } });
  const setProgram = useCallback((p: 'ccat' | 'ngat' | 'math') => { setProgramState(p); setAdminSite(p === 'math' ? 'math' : 'ccat'); try { localStorage.setItem('ccat_admin_program', p); } catch { /* ignore */ } }, []);

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

  // Sites this admin can see: CCAT always; Teacher Hub when super_admin or holding any teacher.* permission.
  const sites = useMemo(() => {
    const out = ['ccat'];
    if (me && (me.role === 'super_admin' || (me.permissions || []).some((p) => p.startsWith('teacher.')))) out.push('teacher');
    return out;
  }, [me]);
  // If the remembered site is no longer available (e.g. signed in as a non-teacher), fall back to CCAT.
  // Only fall back AFTER auth resolves. During load `me` is null so `sites` is transiently ['ccat'];
  // resetting then would wipe a remembered 'teacher' site on every hard refresh (chrome/URL mismatch).
  useEffect(() => { if (ready && !sites.includes(activeSite)) setActiveSite('ccat'); }, [ready, sites, activeSite]);

  // X-Admin-Site is the STUDENT-POOL signal. Math is a PROGRAM (not a workspace), but its students are a
  // separate pool (site_id='math'); CCAT+NGAT share the 'ccat' pool. The TeacherHub workspace keeps its
  // own site. So: teacher workspace -> 'teacher'; else program 'math' -> 'math'; else 'ccat'.
  useEffect(() => { setAdminSite(activeSite === 'teacher' ? 'teacher' : program === 'math' ? 'math' : 'ccat'); }, [activeSite, program]);

  // Which PROGRAMS this account may switch between. A TEACHER account is limited to the programs assigned
  // to it on the Teachers page (me.programs, from ccat.teacher_programs); a teacher with none defaults to
  // CCAT. Every non-teacher admin sees all three.
  const ALL: ('ccat' | 'ngat' | 'math')[] = ['ccat', 'ngat', 'math'];
  const allowedPrograms = useMemo<('ccat' | 'ngat' | 'math')[]>(() => {
    if (me?.is_teacher) {
      const ap = (me.programs || []).filter((x): x is 'ccat' | 'ngat' | 'math' => x === 'ccat' || x === 'ngat' || x === 'math');
      return ap.length ? ap : ['ccat'];
    }
    return ALL;
  }, [me]);
  // Clamp the active program to one the account is allowed (after auth resolves) — e.g. a teacher whose
  // remembered program is 'math' but who is only assigned CCAT lands on CCAT.
  useEffect(() => { if (ready && !allowedPrograms.includes(program)) setProgram(allowedPrograms[0]!); }, [ready, allowedPrograms, program, setProgram]);

  return <Ctx.Provider value={{ me, ready, login, logout, can, sites, activeSite, switchSite, program, setProgram, allowedPrograms }}>{children}</Ctx.Provider>;
}
export function useAuth() { const v = useContext(Ctx); if (!v) throw new Error('useAuth outside provider'); return v; }
