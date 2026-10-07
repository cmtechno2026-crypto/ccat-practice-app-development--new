import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useTeacherHubTz, thConvert, thZoneLabel } from '../lib/thtz';

// Availability Calendar — TeacherHub workspace. Shows real availability across all teachers,
// projected onto actual week/month dates, in the timezone chosen in the top-panel selector.
// Recurring slots repeat every matching weekday; one-time (demo/make-up) booked slots appear
// only on their single occurrence (derived from booked_at). Display-only — no writes here.

interface Slot {
  id: string; teacher_id: string; teacher_name: string; subject: string;
  grade: number | null; grade_min?: number | null; grade_max?: number | null;
  day_of_week: string; start_time: string; end_time: string;
  status: string; timezone: string; session_type?: string | null;
  booked_student?: string | null; booked_at?: string | null; is_custom?: boolean;
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MNAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Event colors: open availability = green; booked colored by session type.
const COLORS: Record<string, { bg: string; line: string; fg: string }> = {
  open: { bg: '#eaf7ec', line: '#7fc78f', fg: '#1d5b2c' },
  recurring: { bg: '#f1faf0', line: '#bfe0b8', fg: '#2f6b2a' },
  makeup: { bg: '#fdf4e0', line: '#e8c583', fg: '#7a5200' },
  demo: { bg: '#fdf0f6', line: '#e9bed5', fg: '#8a3a62' },
};

const H = 48; // px per hour row
const timeMin = (t: string) => { const p = String(t).split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); };
const pad2 = (n: number) => (n < 10 ? '0' + n : '' + n);
const hourLabel = (h: number) => { const ap = h < 12 ? 'am' : 'pm'; const hh = h % 12 === 0 ? 12 : h % 12; return `${hh} ${ap}`; };
const timeLabel = (mins: number) => { const h = Math.floor(mins / 60) % 24, m = mins % 60; const ap = h < 12 ? 'am' : 'pm'; const hh = h % 12 === 0 ? 12 : h % 12; return `${hh}:${pad2(m)} ${ap}`; };
const sameDate = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d: Date) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -d.getDay()); // Sunday

function gradeLabel(s: Slot): string {
  if (s.grade != null) return 'G' + s.grade;
  if (s.grade_min != null && s.grade_max != null) return s.grade_min === s.grade_max ? 'G' + s.grade_min : `G${s.grade_min}–${s.grade_max}`;
  if (s.grade_min != null) return 'G' + s.grade_min;
  return '';
}
function gradeMatches(s: Slot, g: number): boolean {
  if (s.grade != null) return s.grade === g;
  if (s.grade_min != null && s.grade_max != null) return g >= s.grade_min && g <= s.grade_max;
  if (s.grade_min != null) return s.grade_min === g;
  return false;
}

// A converted, display-zone view of a slot (weekday + minutes may shift vs stored base zone).
interface Ev { slot: Slot; dayIdx: number; startMin: number; endMin: number; color: string; label: string; kind: string; oneTime: boolean; occ: Date | null; }

export function AvailabilityCalendar() {
  const { zone } = useTeacherHubTz();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [sel, setSel] = useState<{ teacher: Set<string>; subject: Set<string>; grade: Set<number> }>({ teacher: new Set(), subject: new Set(), grade: new Set() });
  const [openDim, setOpenDim] = useState<string | null>(null);
  const [span, setSpan] = useState<'Weekly' | 'Monthly'>('Weekly');
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [focus, setFocus] = useState<number | null>(null);        // weekly: focused column date index
  const [openDay, setOpenDay] = useState<string | null>(null);     // monthly: selected day (toDateString)
  const [picked, setPicked] = useState<{ label: string; kind: string; when: string; color: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr('');
    api.teacherSlots().then(r => { if (alive) { setSlots((r.slots as Slot[]) || []); setLoading(false); } })
      .catch(e => { if (alive) { setErr((e as Error).message || 'Could not load availability'); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  const now = new Date();

  // Convert each slot into a display-zone event template (recurring pattern + one-time occurrence).
  const allEv = useMemo<Ev[]>(() => slots
    .filter(s => s.status === 'available' || s.status === 'booked')   // skip admin-blocked (unavailable)
    .map(s => {
      const base = s.timezone || 'IST';
      const cs = thConvert(s.day_of_week, s.start_time, base, zone);
      const ce = thConvert(s.day_of_week, s.end_time, base, zone);
      const dayIdx = DOW.indexOf(cs.day);
      const booked = s.status === 'booked' && !!(s.booked_student && s.booked_student.trim());
      const st = (s.session_type || 'recurring').toLowerCase();
      const oneTime = booked && (st === 'makeup' || st === 'demo');
      const color = !booked ? 'open' : (st === 'makeup' ? 'makeup' : st === 'demo' ? 'demo' : 'recurring');
      const gl = gradeLabel(s);
      const label = booked
        ? `${s.booked_student}${gl ? ` (${gl})` : ''} · ${s.subject || 'Session'} · ${s.teacher_name}`
        : `Open · ${s.subject || 'Availability'} · ${s.teacher_name}`;
      const kind = booked ? (st === 'makeup' ? 'Make-Up / On Demand' : st === 'demo' ? 'Demo' : 'Recurring') : 'Open availability';
      // One-time occurrence date: the converted weekday on/after booked_at's date.
      let occ: Date | null = null;
      if (oneTime && s.booked_at && dayIdx >= 0) {
        const b = new Date(s.booked_at);
        let d = new Date(b.getFullYear(), b.getMonth(), b.getDate());
        for (let i = 0; i < 7; i++) { if (d.getDay() === dayIdx) break; d = addDays(d, 1); }
        occ = d;
      }
      return { slot: s, dayIdx, startMin: timeMin(cs.time), endMin: timeMin(ce.time), color, label, kind, oneTime, occ };
    })
    .filter(e => e.dayIdx >= 0 && e.endMin > e.startMin), [slots, zone]);

  // Filter options from the data.
  const opts = useMemo(() => {
    const teachers = [...new Set(slots.map(s => s.teacher_name).filter(Boolean))].sort();
    const subjects = [...new Set(slots.map(s => s.subject).filter(Boolean))].sort();
    const grades = new Set<number>();
    slots.forEach(s => { if (s.grade != null) grades.add(s.grade); else { if (s.grade_min != null && s.grade_max != null) for (let g = s.grade_min; g <= s.grade_max; g++) grades.add(g); else if (s.grade_min != null) grades.add(s.grade_min); } });
    return { teachers, subjects, grades: [...grades].sort((a, b) => a - b) };
  }, [slots]);

  // Apply filters.
  const ev = useMemo(() => allEv.filter(e => {
    if (sel.teacher.size && !sel.teacher.has(e.slot.teacher_name)) return false;
    if (sel.subject.size && !sel.subject.has(e.slot.subject)) return false;
    if (sel.grade.size && ![...sel.grade].some(g => gradeMatches(e.slot, g))) return false;
    return true;
  }), [allEv, sel]);

  // Does an event appear on calendar date D?
  const onDate = (e: Ev, d: Date) => e.oneTime ? (e.occ != null && sameDate(e.occ, d)) : (d.getDay() === e.dayIdx);
  const isPast = (e: Ev, d: Date) => { const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0); dt.setMinutes(e.startMin); return dt.getTime() < now.getTime(); };

  // Hour range from visible events (fallback 8am–8pm).
  const [minH, maxH] = useMemo(() => {
    if (!ev.length) return [8, 20];
    let lo = 24, hi = 0;
    ev.forEach(e => { lo = Math.min(lo, Math.floor(e.startMin / 60)); hi = Math.max(hi, Math.ceil(e.endMin / 60)); });
    lo = Math.max(0, Math.min(lo, 23)); hi = Math.min(24, Math.max(hi, lo + 1));
    return [lo, hi];
  }, [ev]);
  const hours = useMemo(() => Array.from({ length: maxH - minH }, (_, i) => hourLabel(minH + i)), [minH, maxH]);

  // Weekly dates.
  const weekDates = useMemo(() => { const ws = addDays(startOfWeek(now), weekOffset * 7); return Array.from({ length: 7 }, (_, i) => addDays(ws, i)); }, [weekOffset]);
  const weekRange = `${MNAMES[weekDates[0].getMonth()].slice(0, 3)} ${weekDates[0].getDate()} – ${MNAMES[weekDates[6].getMonth()].slice(0, 3)} ${weekDates[6].getDate()}, ${weekDates[6].getFullYear()}`;

  // Monthly cells.
  const month = useMemo(() => {
    const base = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const y = base.getFullYear(), mi = base.getMonth();
    const first = new Date(y, mi, 1).getDay();
    const days = new Date(y, mi + 1, 0).getDate();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < first; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(new Date(y, mi, d));
    while (cells.length % 7) cells.push(null);
    return { y, mi, cells, label: `${MNAMES[mi]} ${y}` };
  }, [monthOffset]);

  const filterNote = (() => {
    const nSel = sel.teacher.size + sel.subject.size + sel.grade.size;
    const n = ev.length;
    return nSel ? `${n} session${n === 1 ? '' : 's'} · ${nSel} filter${nSel > 1 ? 's' : ''}` : `${n} session${n === 1 ? '' : 's'}`;
  })();

  // ---- filter dropdown rendering ----
  const DIMS: { key: 'teacher' | 'subject' | 'grade'; label: string; title: string; options: string[]; values: (string | number)[] }[] = [
    { key: 'teacher', label: 'Teachers', title: 'Select teachers', options: opts.teachers, values: opts.teachers },
    { key: 'subject', label: 'Subjects', title: 'Select subjects', options: opts.subjects, values: opts.subjects },
    { key: 'grade', label: 'Grades', title: 'Select grades', options: opts.grades.map(g => 'Grade ' + g), values: opts.grades },
  ];
  const selSize = (k: string) => k === 'teacher' ? sel.teacher.size : k === 'subject' ? sel.subject.size : sel.grade.size;
  const isOn = (k: string, v: string | number) => k === 'teacher' ? sel.teacher.has(v as string) : k === 'subject' ? sel.subject.has(v as string) : sel.grade.has(v as number);
  const toggleOpt = (k: string, v: string | number) => setSel(s => {
    const next = { teacher: new Set(s.teacher), subject: new Set(s.subject), grade: new Set(s.grade) } as typeof s;
    const set = (next as any)[k] as Set<any>; if (set.has(v)) set.delete(v); else set.add(v); return next;
  });
  const setAll = (k: string, vals: (string | number)[], all: boolean) => setSel(s => {
    const next = { teacher: new Set(s.teacher), subject: new Set(s.subject), grade: new Set(s.grade) } as typeof s;
    (next as any)[k] = all ? new Set() : new Set(vals); return next;
  });

  const barBtn: React.CSSProperties = { minHeight: 38, padding: '0 15px', border: '1px solid #cfd6ea', borderRadius: 7, background: '#fff', color: '#15215c', fontWeight: 800, fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: '#fff', minHeight: 0 }}>
      {/* filter toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '10px 18px', background: '#15215c', color: '#fff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {DIMS.map(d => {
            const count = selSize(d.key);
            const allSel = d.values.length > 0 && count === d.values.length;
            return (
              <div key={d.key} style={{ position: 'relative' }}>
                <button onClick={() => setOpenDim(o => o === d.key ? null : d.key)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40, padding: '0 13px', border: '1px solid #cfd6ea', borderRadius: 7, background: '#fff', color: '#0f1b33', fontSize: 14.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {d.label}
                  {count > 0 && <span style={{ display: 'grid', placeItems: 'center', minWidth: 21, height: 21, padding: '0 6px', borderRadius: 999, background: '#1d5db5', color: '#fff', fontSize: 12, fontWeight: 900 }}>{count}</span>}
                  <span style={{ color: '#64708a', fontSize: 11 }}>▾</span>
                </button>
                {openDim === d.key && (
                  <>
                    <div onClick={() => setOpenDim(null)} style={{ position: 'fixed', inset: 0, zIndex: 25 }} />
                    <div style={{ position: 'absolute', left: 0, top: 46, zIndex: 30, width: 252, border: '1px solid #cfd6ea', borderRadius: 10, background: '#fff', boxShadow: '0 14px 34px rgba(10,20,50,.28)', overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '9px 12px', borderBottom: '1px solid #eef2f8', background: '#f7f9fd' }}>
                        <span style={{ color: '#64708a', fontSize: 11, fontWeight: 900, letterSpacing: '.11em', textTransform: 'uppercase' }}>{d.title}</span>
                        <button onClick={() => setAll(d.key, d.values, true)} style={{ border: 0, background: 'none', color: '#1d5db5', fontSize: 12.5, fontWeight: 900, cursor: 'pointer', padding: 0 }}>Clear</button>
                      </div>
                      <div style={{ padding: 6, maxHeight: 232, overflowY: 'auto' }}>
                        <button onClick={() => setAll(d.key, d.values, allSel)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 34, marginBottom: 4, padding: '0 10px', border: 0, borderBottom: '1px solid #eef2f8', borderRadius: 6, background: allSel ? '#eaf2ff' : '#fff', color: '#0f1b33', fontSize: 14.5, fontWeight: 900, cursor: 'pointer', textAlign: 'left' }}>
                          <span style={{ display: 'grid', placeItems: 'center', width: 17, height: 17, borderRadius: 4, border: `2px solid ${count ? '#1d5db5' : '#c3ccdb'}`, background: count ? '#1d5db5' : '#fff', color: '#fff', fontSize: 11, fontWeight: 900, flex: 'none' }}>{allSel ? '✓' : count ? '–' : ''}</span>
                          {allSel ? 'Unselect all' : 'Select all'}
                        </button>
                        {d.options.map((o, i) => {
                          const v = d.values[i]; const on = isOn(d.key, v);
                          return (
                            <button key={o} onClick={() => toggleOpt(d.key, v)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 34, padding: '0 10px', border: 0, borderRadius: 6, background: on ? '#eaf2ff' : '#fff', color: '#0f1b33', fontSize: 14.5, fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>
                              <span style={{ display: 'grid', placeItems: 'center', width: 17, height: 17, borderRadius: 4, border: `2px solid ${on ? '#1d5db5' : '#c3ccdb'}`, background: on ? '#1d5db5' : '#fff', color: '#fff', fontSize: 11, fontWeight: 900, flex: 'none' }}>{on ? '✓' : ''}</span>{o}
                            </button>
                          );
                        })}
                        {d.options.length === 0 && <div style={{ padding: '10px', color: '#8a93a6', fontSize: 13 }}>None</div>}
                      </div>
                      <button onClick={() => setOpenDim(null)} style={{ width: '100%', minHeight: 40, border: 0, borderTop: '1px solid #eef2f8', background: '#fff', color: '#15215c', fontSize: 14, fontWeight: 900, cursor: 'pointer' }}>Done</button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
          <span style={{ color: '#b9c6e8', fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{filterNote} · {thZoneLabel(zone)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <span style={{ color: '#b9c6e8', fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{span === 'Monthly' ? month.label : weekRange}</span>
          <button onClick={() => { setWeekOffset(0); setMonthOffset(0); setFocus(null); setOpenDay(null); setPicked(null); }} style={barBtn}>Today</button>
          <button title={span === 'Monthly' ? 'Previous month' : 'Previous week'} onClick={() => { span === 'Monthly' ? setMonthOffset(o => o - 1) : setWeekOffset(o => o - 1); setPicked(null); setOpenDay(null); }} style={{ display: 'grid', placeItems: 'center', width: 34, height: 38, border: 0, borderRadius: 7, background: 'transparent', color: '#dbe3f7', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>‹</button>
          <button title={span === 'Monthly' ? 'Next month' : 'Next week'} onClick={() => { span === 'Monthly' ? setMonthOffset(o => o + 1) : setWeekOffset(o => o + 1); setPicked(null); setOpenDay(null); }} style={{ display: 'grid', placeItems: 'center', width: 34, height: 38, border: 0, borderRadius: 7, background: 'transparent', color: '#dbe3f7', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>›</button>
          <button title="Switch between weekly and monthly" onClick={() => { setSpan(s => s === 'Weekly' ? 'Monthly' : 'Weekly'); setPicked(null); }} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 38, padding: '0 14px', border: '1px solid #cfd6ea', borderRadius: 7, background: '#fff', color: '#0f1b33', fontSize: 14, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}>{span}<span style={{ color: '#64708a', fontSize: 11 }}>⇄</span></button>
        </div>
      </div>

      {loading && <div style={{ padding: '40px 24px', color: '#8a93a6', fontSize: 14.5, fontWeight: 700 }}>Loading availability…</div>}
      {err && !loading && <div style={{ padding: '24px', color: '#c22a21', fontSize: 14.5, fontWeight: 700 }}>{err}</div>}

      {/* WEEKLY */}
      {!loading && !err && span === 'Weekly' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflowX: 'auto' }}>
          <div style={{ minWidth: 760, flex: 1, minHeight: 0, overflowY: 'auto', maxHeight: '66vh' }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 2, display: 'grid', gridTemplateColumns: '56px repeat(7,minmax(0,1fr))', borderBottom: '1px solid #e6ebf4', background: '#fff' }}>
              <span />
              {weekDates.map((d, di) => {
                const on = focus === di; const today = sameDate(d, now);
                return (
                  <button key={di} onClick={() => setFocus(f => f === di ? null : di)} style={{ padding: '12px 0', textAlign: 'center', background: on ? '#f2f5fd' : '#fff', border: 0, borderLeft: '1px solid #eef1f7', borderBottom: `3px solid ${on ? '#1d5db5' : today ? '#9cc2ef' : 'transparent'}`, cursor: 'pointer', width: '100%' }}>
                    <span style={{ fontSize: 18, fontWeight: 700, color: on ? '#15215c' : today ? '#15215c' : '#8a93a6' }}>{d.getDate()}</span>
                    <span style={{ marginLeft: 6, fontSize: 12.5, fontWeight: 600, color: on ? '#5a6576' : '#aab3c2' }}>{DOW3[d.getDay()]}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '56px repeat(7,minmax(0,1fr))', position: 'relative' }}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {hours.map((t, i) => <span key={i} style={{ height: H, paddingRight: 8, textAlign: 'right', color: '#8a93a6', fontSize: 11.5, fontWeight: 600, transform: 'translateY(-6px)' }}>{t}</span>)}
              </div>
              {weekDates.map((d, di) => {
                const colEv = ev.filter(e => onDate(e, d));
                return (
                  <div key={di} onClick={() => setFocus(di)} style={{ position: 'relative', borderLeft: '1px solid #eef1f7', background: focus === di ? '#f2f5fd' : '#fff', height: hours.length * H, cursor: 'pointer' }}>
                    {hours.map((_, i) => <div key={i} style={{ height: H, borderBottom: '1px solid #f1f4f9' }} />)}
                    {colEv.map((e, i) => {
                      const past = isPast(e, d); const c = COLORS[e.color];
                      const top = (e.startMin / 60 - minH) * H; const h = Math.max(22, ((e.endMin - e.startMin) / 60) * H);
                      const lines = String(Math.max(1, Math.floor((h - 8) / 12.5)));
                      return (
                        <button key={e.slot.id + '|' + i} title={`${e.label} · ${timeLabel(e.startMin)}–${timeLabel(e.endMin)}${past ? ' · past' : ''}`}
                          onClick={ev2 => { ev2.stopPropagation(); setFocus(di); setPicked({ label: e.label, kind: past ? 'Past · ' + e.kind : e.kind, color: e.color, when: `${DOW3[d.getDay()]} ${MNAMES[d.getMonth()].slice(0, 3)} ${d.getDate()} · ${timeLabel(e.startMin)}–${timeLabel(e.endMin)} ${thZoneLabel(zone)}` }); }}
                          style={{ position: 'absolute', left: 3, right: 3, top, height: h, opacity: past ? .55 : 1, padding: '4px 6px', border: `1px solid ${past ? '#cfd6e4' : c.line}`, borderRadius: 6, background: c.bg, color: c.fg, textAlign: 'left', cursor: 'pointer', overflow: 'hidden' }}>
                          <span style={{ display: '-webkit-box', WebkitLineClamp: lines as any, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 10, fontWeight: 700, lineHeight: 1.25 }}>{e.label}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* MONTHLY */}
      {!loading && !err && span === 'Monthly' && (
        <>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', maxHeight: '66vh', padding: '14px 18px 18px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', gap: 6, marginBottom: 6 }}>
              {DOW3.map(w => <span key={w} style={{ textAlign: 'center', color: '#64708a', fontSize: 11.5, fontWeight: 900, letterSpacing: '.09em', textTransform: 'uppercase' }}>{w}</span>)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', gap: 6 }}>
              {month.cells.map((d, i) => {
                if (!d) return <div key={'b' + i} style={{ minHeight: 112, padding: 7, border: '1px solid #eef2f8', borderRadius: 9, background: '#fafbfe' }} />;
                const dayEv = ev.filter(e => onDate(e, d)).sort((a, b) => a.startMin - b.startMin);
                const today = sameDate(d, now); const isOpen = openDay === d.toDateString(); const past = d < new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const shown = dayEv.slice(0, 2);
                return (
                  <div key={d.toDateString()} onClick={() => { setOpenDay(d.toDateString()); setPicked(null); }} style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 112, padding: 7, border: `1px solid ${isOpen ? '#1d5db5' : today ? '#9cc2ef' : '#e6ebf4'}`, borderRadius: 9, background: isOpen ? '#e4efff' : today ? '#eaf2ff' : past ? '#fbfcfe' : '#fff', cursor: 'pointer' }}>
                    <span style={{ fontSize: 13, fontWeight: 900, color: today ? '#15215c' : past ? '#9aa6b8' : '#0f1b33' }}>{d.getDate()}</span>
                    {shown.map((e, k) => { const c = COLORS[e.color]; const ep = isPast(e, d); return (
                      <button key={e.slot.id + '|' + k} title={`${e.label} · ${timeLabel(e.startMin)}–${timeLabel(e.endMin)}`} onClick={ev2 => { ev2.stopPropagation(); setOpenDay(d.toDateString()); }}
                        style={{ display: '-webkit-box', WebkitLineClamp: 2 as any, WebkitBoxOrient: 'vertical', overflow: 'hidden', width: '100%', padding: '3px 6px', border: `1px solid ${ep ? '#cfd6e4' : c.line}`, borderRadius: 5, background: c.bg, color: c.fg, opacity: ep ? .55 : 1, fontSize: 9.5, fontWeight: 800, lineHeight: 1.25, textAlign: 'left', cursor: 'pointer' }}>{e.label}</button>
                    ); })}
                    {dayEv.length > 2 && <span style={{ color: '#8a93a6', fontSize: 10.5, fontWeight: 800 }}>+{dayEv.length - 2} more</span>}
                  </div>
                );
              })}
            </div>
          </div>
          {openDay && (() => {
            const d = new Date(openDay); const rows = ev.filter(e => onDate(e, d)).sort((a, b) => a.startMin - b.startMin);
            return (
              <div style={{ margin: '0 18px 16px', border: '1px solid #e1e9f6', borderRadius: 11, background: '#fff', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', background: '#f7f9fd', borderBottom: '1px solid #eef2f8' }}>
                  <div>
                    <p style={{ margin: '0 0 3px', fontSize: 16, fontWeight: 900, letterSpacing: '-.02em' }}>{DOW[d.getDay()]}, {MNAMES[d.getMonth()]} {d.getDate()}</p>
                    <p style={{ margin: 0, color: '#64708a', fontSize: 13, fontWeight: 700 }}>{rows.length} session{rows.length === 1 ? '' : 's'}{sameDate(d, now) ? ' · today' : ''}</p>
                  </div>
                  <button onClick={() => setOpenDay(null)} style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, border: '1px solid #d5deec', borderRadius: 999, background: '#fff', color: '#44546e', fontSize: 13, fontWeight: 900, cursor: 'pointer' }}>✕</button>
                </div>
                {rows.map((e, i) => { const c = COLORS[e.color]; const past = isPast(e, d); return (
                  <div key={e.slot.id + '|' + i} style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '11px 16px', borderBottom: '1px solid #f1f4fa', background: past ? '#fbfcfe' : '#fff' }}>
                    <span style={{ minWidth: 124, fontSize: 14.5, fontWeight: 900, letterSpacing: '-.01em', color: '#0f1b33' }}>{timeLabel(e.startMin)} – {timeLabel(e.endMin)}</span>
                    <span style={{ flex: 1, minWidth: 200, fontSize: 14, fontWeight: 700, color: '#2a3550' }}>{e.label}</span>
                    <span style={{ padding: '3px 10px', borderRadius: 999, background: past ? '#eef1f6' : c.bg, color: past ? '#8a93a6' : c.fg, fontSize: 12, fontWeight: 900, whiteSpace: 'nowrap' }}>{past ? 'Past' : e.kind}</span>
                  </div>
                ); })}
                {rows.length === 0 && <p style={{ margin: 0, padding: '18px 16px', color: '#8a93a6', fontSize: 14, fontWeight: 700 }}>No sessions on this day with the current filters.</p>}
              </div>
            );
          })()}
        </>
      )}

      {/* legend */}
      {!loading && !err && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', padding: '10px 20px', borderTop: '1px solid #e6ebf4', background: '#fbfcff' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#44546e', fontSize: 13, fontWeight: 700 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: '#f1faf0', border: '1px solid #bfe0b8', flex: 'none' }} />Upcoming</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#44546e', fontSize: 13, fontWeight: 700 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: '#f1faf0', border: '1px solid #cfd6e4', opacity: .55, flex: 'none' }} />Past</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#44546e', fontSize: 13, fontWeight: 700 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: '#eaf7ec', border: '1px solid #7fc78f', flex: 'none' }} />Open availability</span>
        </div>
      )}

      {/* selection bar */}
      {picked && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '14px 20px', borderTop: '1px solid #e6ebf4', background: '#f7f9fd' }}>
          <span style={{ fontSize: 15.5, fontWeight: 800 }}>{picked.label}</span>
          <span style={{ padding: '4px 11px', borderRadius: 999, background: COLORS[picked.color].bg, color: COLORS[picked.color].fg, fontSize: 12.5, fontWeight: 800 }}>{picked.kind}</span>
          <span style={{ color: '#5a6576', fontSize: 14, fontWeight: 600 }}>{picked.when}</span>
          <button onClick={() => setPicked(null)} style={{ marginLeft: 'auto', border: 0, background: 'none', color: '#1d5db5', fontSize: 14, fontWeight: 800, cursor: 'pointer' }}>Close</button>
        </div>
      )}
    </div>
  );
}
