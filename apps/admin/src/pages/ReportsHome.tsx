import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useNavigate } from 'react-router-dom';
import { useTeacherHubTz, thConvert, thZoneLabel } from '../lib/thtz';

// Reports — TeacherHub workspace. Availability/booking analytics computed live from all teachers'
// slots (api.teacherSlots). KPIs, slots-by-hour, slots-by-teacher, weekly-by-subject, with Week/Time/
// Day filters and CSV export. Recurring + available slots count every week; one-time (makeup/demo)
// bookings count only in the week their occurrence falls. Read-only.

interface Slot {
  id: string; teacher_id: string; teacher_name: string; subject: string;
  day_of_week: string; start_time: string; end_time: string;
  status: string; timezone: string; session_type?: string | null;
  booked_student?: string | null; booked_at?: string | null;
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BANDS: { label: string; all?: boolean; lo?: number; hi?: number }[] = [
  { label: 'All 24h', all: true },
  { label: '2am–8am', lo: 2, hi: 8 },
  { label: '8am–2pm', lo: 8, hi: 14 },
  { label: '2pm–8pm', lo: 14, hi: 20 },
  { label: '8pm–2am', lo: 20, hi: 26 },
];

const hourOf = (t: string) => Number(String(t).split(':')[0]) || 0;
const hourLabel = (h: number) => { const ap = h < 12 ? 'am' : 'pm'; const hh = h % 12 === 0 ? 12 : h % 12; return `${hh}:00 ${ap}`; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); };
const sameOrAfter = (a: Date, b: Date) => a.getTime() >= b.getTime();

export function ReportsHome() {
  const { zone } = useTeacherHubTz();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [weekIdx, setWeekIdx] = useState(0);
  const [band, setBand] = useState('All 24h');
  const [days, setDays] = useState<Set<string>>(new Set(DAYS));
  const [teacherQ, setTeacherQ] = useState('');
  const nav = useNavigate();
  const [teacherSort, setTeacherSort] = useState<'name' | 'available' | 'booked'>('name');
  const [teacherDir, setTeacherDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    let alive = true; setLoading(true); setErr('');
    api.teacherSlots().then(r => { if (alive) { setSlots((r.slots as Slot[]) || []); setLoading(false); } })
      .catch(e => { if (alive) { setErr((e as Error).message || 'Could not load reports'); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  const now = new Date();
  const weeks = useMemo(() => {
    const m0 = mondayOf(now);
    return Array.from({ length: 4 }, (_, i) => { const ws = addDays(m0, i * 7); const we = addDays(ws, 6); return { start: ws, end: we, label: `${MN[ws.getMonth()]} ${ws.getDate()} – ${MN[we.getMonth()]} ${we.getDate()}` }; });
  }, []);
  const week = weeks[weekIdx] || weeks[0];

  const bandOn = (h: number) => { const b = BANDS.find(x => x.label === band) || BANDS[0]; if (b.all) return true; if (b.lo === 20) return h >= 20 || h < 2; return h >= (b.lo as number) && h < (b.hi as number); };

  // Normalise slots → rows that pass the Week filter + carry the fields the report needs.
  const rows = useMemo(() => slots
    .filter(s => s.status === 'available' || s.status === 'booked')
    .map(s => {
      const cv = thConvert(s.day_of_week, s.start_time, s.timezone || 'IST', zone);
      const dayIdx = DAYS.indexOf(cv.day);
      const booked = s.status === 'booked' && !!(s.booked_student && s.booked_student.trim());
      const st = (s.session_type || 'recurring').toLowerCase();
      const oneTime = booked && (st === 'makeup' || st === 'demo');
      let occ: Date | null = null;
      if (oneTime && s.booked_at && dayIdx >= 0) {
        const b = new Date(s.booked_at); let d = new Date(b.getFullYear(), b.getMonth(), b.getDate());
        for (let i = 0; i < 7; i++) { if (((d.getDay() + 6) % 7) === dayIdx) break; d = addDays(d, 1); }
        occ = d;
      }
      return { teacher: s.teacher_name || 'Unknown', tid: s.teacher_id, subject: s.subject || '—', dayIdx, hour: hourOf(cv.time), booked, makeup: booked && (st === 'makeup' || st === 'demo'), oneTime, occ };
    })
    .filter(r => r.dayIdx >= 0), [slots, zone]);

  const inWeek = (r: typeof rows[number]) => !r.oneTime || (r.occ != null && sameOrAfter(r.occ, week.start) && r.occ.getTime() <= addDays(week.end, 1).getTime() - 1);
  const passFilters = (r: typeof rows[number]) => inWeek(r) && days.has(DAYS[r.dayIdx]) && bandOn(r.hour);

  const data = useMemo(() => {
    const f = rows.filter(passFilters);
    let total = 0, avail = 0, booked = 0, makeup = 0;
    // by teacher
    const tMap = new Map<string, { id: string; name: string; subjects: Set<string>; avail: number; booked: number; makeup: number }>();
    // by subject
    const sMap = new Map<string, { avail: number; booked: number; teachers: Set<string> }>();
    // by hour × day
    const hourSet = new Set<number>();
    const grid: Record<string, { a: number; b: number }> = {}; // key hour|dayIdx
    f.forEach(r => {
      total++; if (r.booked) booked++; else avail++; if (r.makeup) makeup++;
      let t = tMap.get(r.teacher); if (!t) { t = { id: r.tid, name: r.teacher, subjects: new Set(), avail: 0, booked: 0, makeup: 0 }; tMap.set(r.teacher, t); }
      t.subjects.add(r.subject); if (r.booked) t.booked++; else t.avail++; if (r.makeup) t.makeup++;
      let sj = sMap.get(r.subject); if (!sj) { sj = { avail: 0, booked: 0, teachers: new Set() }; sMap.set(r.subject, sj); }
      if (r.booked) sj.booked++; else sj.avail++; sj.teachers.add(r.teacher);
      hourSet.add(r.hour);
      const k = r.hour + '|' + r.dayIdx; const g = grid[k] || (grid[k] = { a: 0, b: 0 }); if (r.booked) g.b++; else g.a++;
    });
    const byTeacher = [...tMap.values()].map(t => { const tot = t.avail + t.booked; return { id: t.id, name: t.name, subject: [...t.subjects].join(', ') || '—', avail: t.avail, booked: t.booked, makeup: t.makeup, total: tot, pct: tot ? Math.round(t.booked / tot * 100) : 0 }; }).sort((a, b) => b.total - a.total);
    const bySubject = [...sMap.entries()].map(([name, s]) => { const tot = s.avail + s.booked; return { name, teachers: s.teachers.size, avail: s.avail, booked: s.booked, total: tot }; }).sort((a, b) => b.total - a.total);
    const hours = [...hourSet].sort((a, b) => a - b);
    const hourRows = hours.map(h => {
      let rb = 0, ra = 0;
      const cells = DAYS.map((_, di) => {
        if (!days.has(DAYS[di])) return { empty: true, a: 0, b: 0 };
        const g = grid[h + '|' + di]; const a = g ? g.a : 0, b = g ? g.b : 0; rb += b; ra += a;
        if (!g) return { empty: true, a: 0, b: 0 };
        return { empty: false, a, b };
      });
      return { label: hourLabel(h), cells, sumA: ra, sumB: rb };
    });
    return { total, avail, booked, makeup, byTeacher, bySubject, hourRows };
  }, [rows, weekIdx, band, days]);

  const maxTeacherTotal = Math.max(1, ...data.byTeacher.map(t => t.total));
  const grand = data.total;
  const teacherRows = (() => {
    const q = teacherQ.trim().toLowerCase();
    const list = data.byTeacher.filter(t => !q || t.name.toLowerCase().includes(q));
    const dir = teacherDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => teacherSort === 'name' ? a.name.localeCompare(b.name) * dir : teacherSort === 'available' ? (a.avail - b.avail) * dir : (a.booked - b.booked) * dir);
  })();

  const exportCsv = () => {
    const out = [['Teacher', 'Subject', 'Available', 'Booked', 'Make-up', 'Total', 'Utilisation %'],
      ...data.byTeacher.map(t => [t.name, t.subject, t.avail, t.booked, t.makeup, t.total, t.total ? Math.round(t.booked / t.total * 100) : 0])];
    const csv = out.map(x => x.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `teacherhub-report-${week.label.replace(/\s/g, '')}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  const toggleDay = (d: string) => setDays(s => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n.size ? n : new Set(DAYS); });

  const card: React.CSSProperties = { padding: '20px 22px', border: '1px solid #dbe4f4', borderRadius: 14, background: '#fff' };
  const th: React.CSSProperties = { color: '#8b93aa', fontSize: 11, fontWeight: 900, letterSpacing: '.1em', textTransform: 'uppercase' };
  const sel: React.CSSProperties = { height: 38, padding: '0 12px', border: '1px solid #cfd6ea', borderRadius: 7, background: '#fff', color: '#0f1b33', fontSize: 14.5, fontWeight: 700 };

  const KPIS = [
    { label: 'Total slots offered', value: data.total, sub: 'available + booked', color: '#1a4f9e', bg: '#eef4ff' },
    { label: 'Available slots', value: data.avail, sub: 'open to parents', color: '#0e7a52', bg: '#eefaf4' },
    { label: 'Booked slots', value: data.booked, sub: data.total ? Math.round(data.booked / data.total * 100) + '% utilisation' : '—', color: '#b36b00', bg: '#fff6e6' },
    { label: 'Make-up / on-demand', value: data.makeup, sub: 'booked this week', color: '#7b3fb0', bg: '#f6eeff' },
  ];

  return (
    <div className="avrep" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: '#f4f7ff' }}>
      {/* filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '12px 20px', background: '#15215c', color: '#fff' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13.5, fontWeight: 700, color: '#b9c6e8' }}>Week
          <select value={weekIdx} onChange={e => setWeekIdx(Number(e.target.value))} style={{ ...sel, minWidth: 206 }}>
            {weeks.map((w, i) => <option key={i} value={i}>{w.label}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span style={{ color: '#b9c6e8', fontSize: 13.5, fontWeight: 700 }}>Time</span>
          {BANDS.map(b => { const on = band === b.label; return (
            <button key={b.label} onClick={() => setBand(b.label)} style={{ minHeight: 34, padding: '0 14px', border: `1px solid ${on ? '#1d5db5' : '#cfd6ea'}`, borderRadius: 999, background: on ? '#1d5db5' : '#fff', color: on ? '#fff' : '#44465a', fontSize: 13.5, fontWeight: 900, cursor: 'pointer', whiteSpace: 'nowrap' }}>{b.label}</button>
          ); })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span style={{ color: '#b9c6e8', fontSize: 13.5, fontWeight: 700 }}>Days</span>
          {DAYS.map((d, i) => { const on = days.has(d); return (
            <button key={d} onClick={() => toggleDay(d)} style={{ minHeight: 34, padding: '0 12px', border: `1px solid ${on ? '#102842' : '#dbe4f4'}`, borderRadius: 999, background: on ? '#102842' : '#fff', color: on ? '#fff' : '#44465a', fontSize: 13.5, fontWeight: 900, cursor: 'pointer' }}>{DAY3[i]}</button>
          ); })}
          <button onClick={() => setDays(new Set(DAYS))} style={{ minHeight: 34, padding: '0 12px', border: '1px dashed rgba(255,255,255,.4)', borderRadius: 999, background: 'transparent', color: '#dbe3f7', fontSize: 13.5, fontWeight: 900, cursor: 'pointer' }}>All days</button>
        </div>
        <button onClick={exportCsv} style={{ marginLeft: 'auto', height: 40, padding: '0 20px', borderRadius: 999, border: '1.5px solid rgba(255,255,255,.4)', background: 'rgba(255,255,255,.1)', color: '#fff', fontSize: 14.5, fontWeight: 900, cursor: 'pointer', whiteSpace: 'nowrap' }}>Export CSV</button>
      </div>

      {loading && <div style={{ padding: '40px 24px', color: '#8a93a6', fontSize: 14.5, fontWeight: 700 }}>Loading reports…</div>}
      {err && !loading && <div style={{ padding: '24px', color: '#c22a21', fontSize: 14.5, fontWeight: 700 }}>{err}</div>}

      {!loading && !err && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 20px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
            {KPIS.map(k => (
              <div key={k.label} style={{ padding: '16px 18px', border: '1px solid #dbe4f4', borderRadius: 14, background: k.bg }}>
                <p style={{ margin: '0 0 7px', color: '#5a6576', fontSize: 13, fontWeight: 800 }}>{k.label}</p>
                <p style={{ margin: 0, fontSize: 34, lineHeight: 1, fontWeight: 900, letterSpacing: '-.04em', color: k.color }}>{k.value}</p>
                <p style={{ margin: '9px 0 0', color: '#6f7890', fontSize: 13, fontWeight: 700 }}>{k.sub}</p>
              </div>
            ))}
          </div>

          {/* Slots by hour */}
          <div style={card}>
            <h2 style={{ margin: '0 0 4px', fontSize: 19, fontWeight: 900, letterSpacing: '-.02em' }}>Slots by hour</h2>
            <p style={{ margin: '0 0 14px', color: '#6f7890', fontSize: 14, fontWeight: 600 }}>Shown as <strong style={{ color: '#0e7a52' }}>available</strong> / <strong style={{ color: '#1a4f9e' }}>booked</strong> across all teachers for each hour. Times in {thZoneLabel(zone)}.</p>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 720 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '120px repeat(7,minmax(0,1fr)) 80px 80px', gap: 6, paddingBottom: 7 }}>
                  <span style={th}>Hour</span>
                  {DAY3.map(d => <span key={d} style={{ ...th, textAlign: 'center' }}>{d}</span>)}
                  <span style={{ ...th, textAlign: 'center' }}>Total avail</span>
                  <span style={{ ...th, textAlign: 'center' }}>Total booked</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {data.hourRows.length === 0 && <div style={{ color: '#8a93a6', fontSize: 14, fontWeight: 700, padding: '10px 2px' }}>No slots match the current filters.</div>}
                  {data.hourRows.map(r => (
                    <div key={r.label} style={{ display: 'grid', gridTemplateColumns: '120px repeat(7,minmax(0,1fr)) 80px 80px', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 13.5, fontWeight: 800, color: '#44465a' }}>{r.label}</span>
                      {r.cells.map((c, i) => <span key={i} style={{ display: 'grid', placeItems: 'center', minHeight: 36, borderRadius: 8, background: c.empty ? '#fafbfe' : '#e9f6ef', color: c.empty ? '#c3ccdb' : '#0b5d4f', fontSize: 14, fontWeight: 900 }}>{c.empty ? '–' : <span>{c.a} / <span style={{ color: '#1a4f9e' }}>{c.b}</span></span>}</span>)}
                      <span style={{ display: 'grid', placeItems: 'center', minHeight: 36, borderRadius: 8, background: '#dcf0e5', color: '#0b5d4f', fontSize: 14, fontWeight: 900 }}>{r.sumA}</span>
                      <span style={{ display: 'grid', placeItems: 'center', minHeight: 36, borderRadius: 8, background: '#eef3ff', color: '#1a4f9e', fontSize: 14, fontWeight: 900 }}>{r.sumB}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Slots by teacher */}
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 19, fontWeight: 900, letterSpacing: '-.02em' }}>Slots by teacher</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <input value={teacherQ} onChange={e => setTeacherQ(e.target.value)} placeholder="Search teacher…" style={{ width: 200, maxWidth: '55vw', boxSizing: 'border-box', border: '1px solid #dbe4f4', borderRadius: 9, padding: '8px 12px', font: 'inherit', fontSize: 14 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: '#64708a' }}>Sort</span>
                  <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 999, background: '#eef2f8' }}>
                    {([['name', 'Name'], ['available', 'Available'], ['booked', 'Booked']] as const).map(([k, lbl]) => {
                      const on = teacherSort === k;
                      return <button key={k} onClick={() => { if (teacherSort === k) setTeacherDir(d => d === 'asc' ? 'desc' : 'asc'); else { setTeacherSort(k); setTeacherDir(k === 'name' ? 'asc' : 'desc'); } }} style={{ border: 0, borderRadius: 999, padding: '6px 11px', fontSize: 12, fontWeight: 900, cursor: 'pointer', whiteSpace: 'nowrap', background: on ? '#fff' : 'transparent', color: on ? '#15215c' : '#64708a', boxShadow: on ? '0 1px 3px rgba(16,32,64,.18)' : 'none' }}>{lbl}{on ? (teacherDir === 'asc' ? ' ↑' : ' ↓') : ''}</button>;
                    })}
                  </div>
                </div>
              </div>
            </div>
            <p style={{ margin: '0 0 14px', color: '#6f7890', fontSize: 14, fontWeight: 600 }}>Total slots given (available + booked), plus make-up / on-demand bookings.</p>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 760 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(190px,1.4fr) 140px 100px 100px 96px 110px minmax(120px,1fr)', gap: 10, padding: '9px 12px', background: '#f7f9fd', borderRadius: 8, ...th }}>
                  <span>Teacher</span><span>Subject</span><span>Available</span><span>Booked</span><span>Make-up</span><span>Total slots</span><span>Utilisation</span>
                </div>
                {teacherRows.length === 0 && <div style={{ color: '#8a93a6', fontSize: 14, fontWeight: 700, padding: '12px' }}>No teachers match{teacherQ.trim() ? ' your search' : ' the current filters'}.</div>}
                {teacherRows.map(t => (
                  <div key={t.name} style={{ display: 'grid', gridTemplateColumns: 'minmax(190px,1.4fr) 140px 100px 100px 96px 110px minmax(120px,1fr)', gap: 10, alignItems: 'center', padding: '11px 12px', borderBottom: '1px solid #eef2f9', fontSize: 14 }}>
                    <button onClick={() => t.id && nav('/teacherhub/teachers?teacher=' + encodeURIComponent(t.id))} title="Open in Teachers" style={{ textAlign: 'left', border: 0, background: 'none', padding: 0, cursor: t.id ? 'pointer' : 'default', fontWeight: 900, fontSize: 14, color: t.id ? '#1a4f9e' : 'inherit', fontFamily: 'inherit' }}>{t.name}{t.id ? ' ↗' : ''}</button>
                    <span style={{ color: '#44465a', fontWeight: 700 }}>{t.subject}</span>
                    <span style={{ fontWeight: 900, color: '#0e7a52' }}>{t.avail}</span>
                    <span style={{ fontWeight: 900, color: '#1a4f9e' }}>{t.booked}</span>
                    <span style={{ fontWeight: 900, color: '#7b3fb0' }}>{t.makeup}</span>
                    <span style={{ fontWeight: 900 }}>{t.total}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span style={{ flex: 1, minWidth: 50, height: 8, borderRadius: 99, background: '#e9eef8', overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', borderRadius: 99, background: '#1d5db5', width: t.pct + '%' }} /></span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: '#44465a' }}>{t.total ? t.pct + '%' : '—'}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Weekly availability by subject */}
          <div style={card}>
            <h2 style={{ margin: '0 0 4px', fontSize: 19, fontWeight: 900, letterSpacing: '-.02em' }}>Weekly availability by subject</h2>
            <p style={{ margin: '0 0 14px', color: '#6f7890', fontSize: 14, fontWeight: 600 }}>How the week's capacity splits across subjects.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px,1fr) 100px 110px 100px 110px minmax(120px,1.2fr)', gap: 10, padding: '9px 12px', background: '#f7f9fd', borderRadius: 8, ...th }}>
              <span>Subject</span><span>Teachers</span><span>Available</span><span>Booked</span><span>Total</span><span>Share of week</span>
            </div>
            {data.bySubject.length === 0 && <div style={{ color: '#8a93a6', fontSize: 14, fontWeight: 700, padding: '12px' }}>No data for the current filters.</div>}
            {data.bySubject.map(s => (
              <div key={s.name} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px,1fr) 100px 110px 100px 110px minmax(120px,1.2fr)', gap: 10, alignItems: 'center', padding: '11px 12px', borderBottom: '1px solid #eef2f9', fontSize: 14 }}>
                <span style={{ fontWeight: 900 }}>{s.name}</span>
                <span style={{ color: '#44465a', fontWeight: 700 }}>{s.teachers}</span>
                <span style={{ fontWeight: 900, color: '#0e7a52' }}>{s.avail}</span>
                <span style={{ fontWeight: 900, color: '#1a4f9e' }}>{s.booked}</span>
                <span style={{ fontWeight: 900 }}>{s.total}</span>
                <span style={{ height: 9, borderRadius: 99, background: '#e9eef8', overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', borderRadius: 99, background: '#eaa32a', width: (grand ? Math.round(s.total / grand * 100) : 0) + '%' }} /></span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
