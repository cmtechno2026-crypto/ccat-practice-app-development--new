import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// ── TeacherHub timezone support for the admin TeacherHub workspace ──────────────
// Ported verbatim (semantics-wise) from the teacher app (public/teacher.html) so the
// admin's displayed slot times match TeacherHub exactly, DST-accurately. Slots are
// stored as wall-clock HH:MM + a source zone label (IST/EST/…) and/or iana_timezone;
// everything here is DISPLAY-ONLY — slot ids/actions are never touched.

export const TH_TZ: Record<string, string> = {
  IST: 'Asia/Kolkata',
  EST: 'America/Toronto',
  PST: 'America/Los_Angeles',
  MST: 'America/Denver',
  CST: 'America/Chicago',
};

// Dropdown order + labels mirror TeacherHub's selector.
export const TH_ZONES: { key: string; label: string }[] = [
  { key: 'IST', label: 'India (IST)' },
  { key: 'EST', label: 'Toronto (ET)' },
  { key: 'PST', label: 'Pacific (PT)' },
  { key: 'MST', label: 'Mountain (MT)' },
  { key: 'CST', label: 'Central (CT)' },
];

const TH_SHORT: Record<string, string> = { EST: 'ET', PST: 'PT', MST: 'MT', CST: 'CT', IST: 'IST' };
export function thZoneLabel(k?: string): string { return (k && TH_SHORT[k]) || k || 'IST'; }

const TH_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function thOffMin(iana: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: iana, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const m: Record<string, string> = {};
  dtf.formatToParts(date).forEach(x => { m[x.type] = x.value; });
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return (asUTC - date.getTime()) / 60000;
}

function thWallToUtc(y: number, mo: number, d: number, h: number, mi: number, iana: string): Date {
  const g = Date.UTC(y, mo, d, h, mi);
  const off = thOffMin(iana, new Date(g));
  let dt = new Date(g - off * 60000);
  const off2 = thOffMin(iana, dt);
  if (off2 !== off) dt = new Date(g - off2 * 60000);
  return dt;
}

export type ThSlotLike = { timezone?: string | null; iana_timezone?: string | null };

// Source IANA for a slot: explicit iana_timezone wins, else its label, else IST.
export function thIanaOf(s?: ThSlotLike | null): string {
  return (s && s.iana_timezone) || TH_TZ[(s && s.timezone) || 'IST'] || 'Asia/Kolkata';
}

// Convert a (day, HH:MM) wall time from one zone to another, DST-accurately using the
// next occurrence of that weekday as the reference date. fromZone/toZone may be a label
// (IST/EST/…) or an IANA name.
export function thConvert(day: string, hhmm: string, fromZone: string, toZone: string): { day: string; time: string } {
  const fi = TH_TZ[fromZone] || fromZone;
  const ti = TH_TZ[toZone] || toZone;
  if (!fi || !ti || fi === ti) return { day, time: hhmm };
  const parts = String(hhmm).split(':');
  const h = parseInt(parts[0], 10) || 0, mi = parseInt(parts[1], 10) || 0;
  const dow = TH_DAYS.indexOf(day);
  if (dow < 0) return { day, time: hhmm };
  const now = new Date();
  const ref = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 0; i < 7; i++) { if (ref.getDay() === dow) break; ref.setDate(ref.getDate() + 1); }
  const utc = thWallToUtc(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, mi, fi);
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: ti, hour12: false, weekday: 'long', hour: '2-digit', minute: '2-digit' });
  const m: Record<string, string> = {};
  dtf.formatToParts(utc).forEach(x => { m[x.type] = x.value; });
  let hh = m.hour; if (hh === '24') hh = '00';
  return { day: m.weekday, time: hh + ':' + m.minute };
}

// ── React context: the selected zone, persisted to localStorage ────────────────
const LS_KEY = 'th_admin_tz';
function readZone(): string { try { return localStorage.getItem(LS_KEY) || 'IST'; } catch { return 'IST'; } }
function writeZone(z: string): void { try { localStorage.setItem(LS_KEY, z); } catch { /* ignore */ } }

type TzCtx = { zone: string; setZone: (z: string) => void };
const TeacherHubTzContext = createContext<TzCtx>({ zone: 'IST', setZone: () => { } });

export function TeacherHubTzProvider({ children }: { children: React.ReactNode }) {
  const [zone, setZoneState] = useState<string>(() => readZone());
  const setZone = useCallback((z: string) => { writeZone(z); setZoneState(z); }, []);
  // Keep in sync if another tab changes it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === LS_KEY && e.newValue) setZoneState(e.newValue); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const value = useMemo(() => ({ zone, setZone }), [zone, setZone]);
  return <TeacherHubTzContext.Provider value={value}>{children}</TeacherHubTzContext.Provider>;
}

export function useTeacherHubTz() {
  const { zone, setZone } = useContext(TeacherHubTzContext);
  // Convenience: convert a slot's start/end into the currently-selected zone.
  const convertSlot = useCallback((s: ThSlotLike & { day_of_week?: string; start_time?: string; end_time?: string }) => {
    const from = thIanaOf(s);
    const st = thConvert(s.day_of_week || '', s.start_time || '', from, zone);
    const en = thConvert(s.day_of_week || '', s.end_time || '', from, zone);
    return { day: st.day, start: st.time, end: en.time };
  }, [zone]);
  return { zone, setZone, convertSlot, zoneLabel: thZoneLabel(zone) };
}
