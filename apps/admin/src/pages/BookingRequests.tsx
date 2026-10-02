import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Requests (TeacherHub) — one unified inbox for parent booking requests.
// Flow: parent requests slots → teacher accepts/rejects in the teacher app → admin books the accepted ones.
// Stage is driven by the REAL request lifecycle:
//   status='pending'  + teacher_status='pending'  → Awaiting teacher
//                     + teacher_status='accepted' → Needs booking (admin books the accepted slots)
//                     + teacher_status='declined' → Teacher rejected
//   status='approved' → Booked · 'partially_approved' → Partially booked · 'rejected' → Declined
// Per-slot teacher_slot_status (surfaced by the endpoint) drives the slot chips; it falls back to the
// request-level teacher_status when a row predates per-slot capture. Booking is a single approve() call:
// the chosen accepted slots are booked and every other requested slot is declined, deciding the request.
// Teacher LEAVE requests keep their own section at the bottom.

interface Slot {
  slot_id: string; outcome: string; teacher_slot_status?: string | null;
  teacher_id: string; teacher_name: string; subject: string;
  day_of_week: string; start_time: string; end_time: string; status: string; timezone?: string | null;
  session_type?: string | null;
}
interface RequestRow {
  id: string; parent_name: string; parent_email: string; parent_phone: string | null;
  student_name: string | null; notes: string | null; parent_timezone: string | null;
  session_type?: string | null; custom_time_requests?: any[] | null;
  status: string; teacher_status: string; teacher_decided_at: string | null;
  decided_by_name: string | null; decided_at: string | null; created_at: string; slots: Slot[];
}
interface LeaveRow {
  id: string; teacher_id: string; teacher_name: string; teacher_email: string;
  start_date: string; end_date: string; reason: string; status: string;
  decided_by: string | null; decided_at: string | null; created_at: string;
}

const DAY_ABBR: Record<string, string> = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const shortDay = (d: string) => DAY_ABBR[d] || d;

// palette (matches the approved sample)
const TP: Record<string, { label: string; dot: string; fg: string }> = {
  pending: { label: 'Awaiting teacher', dot: '#f7b12b', fg: '#a06a00' },
  accepted: { label: 'Accepted', dot: '#10a869', fg: '#0e7a52' },
  rejected: { label: 'Rejected', dot: '#d42a21', fg: '#c22a21' },
};
const AP: Record<string, { label: string; dot: string; fg: string }> = {
  approved: { label: 'Booked', dot: '#10a869', fg: '#0e7a52' },
  taken: { label: 'Taken by another', dot: '#b36b00', fg: '#b36b00' },
  rejected: { label: 'Declined by admin', dot: '#d42a21', fg: '#c22a21' },
  none: { label: 'Not booked yet', dot: '#c9d3e3', fg: '#8b93aa' },
  na: { label: '—', dot: '#eef2f9', fg: '#b3bcca' },
};
const PILL: Record<string, { label: string; bg: string; fg: string }> = {
  action: { label: 'NEEDS BOOKING', bg: '#e7efff', fg: '#1a4f9e' },
  awaiting: { label: 'AWAITING TEACHER', bg: '#fff0cf', fg: '#b36b00' },
  booked: { label: 'BOOKED', bg: '#dff9ed', fg: '#039b68' },
  partial: { label: 'PARTIALLY BOOKED', bg: '#e0f3ff', fg: '#0b6f9e' },
  declined: { label: 'DECLINED', bg: '#fdecea', fg: '#c62a1e' },
  norefused: { label: 'TEACHER REJECTED', bg: '#f5e7ff', fg: '#7b3fb0' },
};
const FILTERS: [string, string, string][] = [
  ['Needs booking', 'action', '#2f6fde'], ['Awaiting teacher', 'awaiting', '#f7b12b'],
  ['Booked', 'booked', '#10a869'], ['Declined / rejected', 'closed', '#d42a21'], ['All', 'all', '#8b93aa'],
];

const SESSION_TYPE: Record<string, { label: string; bg: string; fg: string }> = {
  demo: { label: 'Demo', bg: '#e7efff', fg: '#1a4f9e' },
  recurring: { label: 'Recurring', bg: '#e6f5ec', fg: '#0e7a52' },
  makeup: { label: 'Make-up', bg: '#fbf1dc', fg: '#a4701a' },
};


const stageOf = (r: RequestRow): keyof typeof PILL => {
  if (r.status === 'approved') return 'booked';
  if (r.status === 'partially_approved') return 'partial';
  if (r.status === 'rejected') return r.teacher_status === 'declined' ? 'norefused' : 'declined';
  if (r.teacher_status === 'declined') return 'norefused';
  if (r.teacher_status === 'accepted') return 'action';
  return 'awaiting';
};
const bucketOf = (r: RequestRow) => {
  const k = stageOf(r);
  return k === 'action' ? 'Needs booking' : k === 'awaiting' ? 'Awaiting teacher'
    : (k === 'booked' || k === 'partial') ? 'Booked' : 'Declined / rejected';
};
// per-slot teacher decision, with a fallback to the request-level status for older rows
const slotTeacher = (s: Slot, r: RequestRow): string =>
  s.teacher_slot_status || (r.teacher_status === 'accepted' ? 'accepted' : r.teacher_status === 'declined' ? 'rejected' : 'pending');
const isBookable = (s: Slot, r: RequestRow) => slotTeacher(s, r) === 'accepted' && s.outcome !== 'approved' && s.outcome !== 'taken';
const teacherNames = (r: RequestRow) => [...new Set(r.slots.map(s => s.teacher_name).filter(Boolean))];
const teacherLabel = (r: RequestRow) => { const n = teacherNames(r); return n.length === 0 ? '—' : n.length === 1 ? n[0] : `${n[0]} +${n.length - 1}`; };
const whenParts = (iso: string) => { const d = new Date(iso); return { date: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }; };
const fmtLeave = (d: string) => { const dt = new Date(d + (d.length <= 10 ? 'T00:00:00' : '')); return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); };

export function BookingRequests() {
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [leave, setLeave] = useState<LeaveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState('Needs booking');
  const [sort, setSort] = useState<'Newest' | 'Oldest' | 'Most slots'>('Newest');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, Set<string>>>({});
  const [autoBook, setAutoBook] = useState<boolean | null>(null);
  const [savingAuto, setSavingAuto] = useState(false);

  const reload = () => {
    setLoading(true); setErr('');
    Promise.all([
      api.teacherBookingRequests({ status: 'all' }).then(r => (r.requests as RequestRow[]) || []),
      api.teacherLeaveRequests('all').then(r => (r.requests as LeaveRow[]) || []).catch(() => []),
    ]).then(([rq, lv]) => { setRows(rq); setLeave(lv); setChosen({}); })
      .catch(e => setErr((e as Error).message || 'Failed to load requests'))
      .finally(() => setLoading(false));
  };
  useEffect(reload, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.teacherGetSettings().then(r => setAutoBook(!!r.auto_book)).catch(() => setAutoBook(false)); }, []);

  const toggleAuto = async () => {
    if (autoBook === null || savingAuto) return;
    const next = !autoBook; setSavingAuto(true); setErr('');
    try { await api.teacherSetSettings(next); setAutoBook(next); }
    catch (e) { setErr((e as Error).message || 'Could not update Auto Booking'); }
    finally { setSavingAuto(false); }
  };

  const bookableIds = (r: RequestRow) => r.slots.filter(s => isBookable(s, r)).map(s => s.slot_id);
  const chosenFor = (r: RequestRow) => chosen[r.id] ?? new Set(bookableIds(r));
  const toggleSlot = (r: RequestRow, sid: string) => setChosen(prev => {
    const cur = new Set(prev[r.id] ?? bookableIds(r));
    if (cur.has(sid)) cur.delete(sid); else cur.add(sid);
    return { ...prev, [r.id]: cur };
  });

  const approve = async (r: RequestRow) => {
    const ids = [...chosenFor(r)].filter(id => bookableIds(r).includes(id));
    if (ids.length === 0) { setErr('Tick at least one accepted slot to book, or use Decline for the whole request.'); return; }
    setBusy(r.id); setErr('');
    try { const res = await api.teacherApproveRequest(r.id, ids); if (res.taken) setErr(`${res.taken} slot(s) were already taken and could not be booked.`); reload(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const reject = async (r: RequestRow) => {
    const reason = window.prompt('Reason for declining this request? (optional, added to the notes)') ?? undefined;
    setBusy(r.id); setErr('');
    try { await api.teacherRejectRequest(r.id, reason || undefined); reload(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const decideLeave = async (l: LeaveRow, decision: 'approve' | 'reject') => {
    setBusy(l.id); setErr('');
    try { await api.teacherDecideLeave(l.id, decision); reload(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    FILTERS.forEach(([l]) => { c[l] = l === 'All' ? rows.length : rows.filter(r => bucketOf(r) === l).length; });
    return c;
  }, [rows]);
  const actionCount = counts['Needs booking'] || 0;

  const stats = useMemo(() => {
    const bookedSlots = rows.reduce((n, r) => n + r.slots.filter(s => s.outcome === 'approved').length, 0);
    const totalSlots = rows.reduce((n, r) => n + r.slots.length, 0);
    return [
      { icon: '📥', value: actionCount, label: 'Ready for you to book', bg: '#e7efff', color: '#1a4f9e' },
      { icon: '⏳', value: counts['Awaiting teacher'] || 0, label: 'Waiting on a teacher', bg: '#fff0cf', color: '#b36b00' },
      { icon: '✅', value: bookedSlots, label: 'Slots booked', bg: '#dff9ed', color: '#0e7a52' },
      { icon: '🗓', value: totalSlots, label: 'Slots requested in total', bg: '#f3e8ff', color: '#7b3fb0' },
    ];
  }, [rows, counts, actionCount]);

  const view = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = rows.filter(r => (filter === 'All' || bucketOf(r) === filter)
      && (!ql || `${r.parent_name} ${r.student_name || ''} ${teacherLabel(r)}`.toLowerCase().includes(ql)));
    list = [...list].sort((a, b) => sort === 'Most slots' ? b.slots.length - a.slots.length
      : (sort === 'Oldest' ? 1 : -1) * (new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
    return list;
  }, [rows, filter, sort, q]);

  const openLeave = leave.filter(l => l.status !== 'cancelled');

  // ---------- styles ----------
  const card: React.CSSProperties = { border: '1px solid #dbe4f4', borderRadius: 14, background: '#fff' };
  const pill = (on: boolean): React.CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, padding: '0 15px', borderRadius: 999, border: '1.5px solid ' + (on ? '#0f2842' : '#dbe4f4'), background: on ? '#0f2842' : '#fff', color: on ? '#fff' : '#44465a', fontSize: 14, fontWeight: 900, cursor: 'pointer', whiteSpace: 'nowrap' });
  const gridCols = 'minmax(0,1.7fr) 108px minmax(0,1fr) minmax(0,1.6fr) 126px 158px';
  const chip = (bg: string, line: string, fg: string): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 8, border: `1px solid ${line}`, background: bg, color: fg, fontSize: 12, fontWeight: 900, whiteSpace: 'nowrap' });
  const ell: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

  const slotChip = (s: Slot, r: RequestRow) => {
    const stt = s.outcome === 'approved' ? 'booked' : s.outcome === 'taken' ? 'taken' : s.outcome === 'rejected' ? 'declined' : slotTeacher(s, r);
    const m: Record<string, [string, string, string, string]> = {
      pending: ['⏳', '#fffaf0', '#f4d58e', '#a06a00'], accepted: ['✓', '#eefaf4', '#bfe8d4', '#0e7a52'],
      rejected: ['✕', '#fdf3f2', '#f3c9c4', '#c22a21'], booked: ['📌', '#e7f4ff', '#b9dcf7', '#0b6f9e'],
      taken: ['🔒', '#fdf6ea', '#f0dcb0', '#a4701a'], declined: ['⊘', '#f6f8fc', '#e3eaf6', '#8b93aa'],
    };
    const c = m[stt] || m.pending;
    const stKey = s.session_type || r.session_type; const st = stKey ? SESSION_TYPE[stKey] : null;
    return <span key={s.slot_id} style={chip(c[1], c[2], c[3])} title={`${s.day_of_week} ${s.start_time}–${s.end_time} · ${s.teacher_name}`}>{c[0]} {shortDay(s.day_of_week)} {s.start_time}{st ? ` ${st.label}` : ''}</span>;
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* Auto-book */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '15px 20px', ...card }}>
        <button onClick={toggleAuto} disabled={autoBook === null || savingAuto} aria-pressed={!!autoBook} title="Toggle Auto Booking"
          style={{ position: 'relative', width: 52, height: 30, borderRadius: 99, border: 0, flex: 'none', cursor: (autoBook === null || savingAuto) ? 'default' : 'pointer', background: autoBook ? '#10a869' : '#c9d3e3', opacity: (autoBook === null || savingAuto) ? 0.7 : 1 }}>
          <span style={{ position: 'absolute', top: 3, left: autoBook ? 25 : 3, width: 24, height: 24, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.2)', transition: 'left .15s' }} />
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 900 }}>⚡ Auto-book on teacher acceptance{autoBook === null ? '' : autoBook ? ' · ON' : ' · OFF'}</div>
          <div style={{ color: '#6f7890', fontSize: 13, marginTop: 2 }}>{autoBook ? 'Accepted slots are booked the moment a teacher accepts — no admin step needed.' : 'Teacher acceptances are recorded; you book the accepted slots in the table below.'}</div>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
        {stats.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', ...card }}>
            <span style={{ display: 'grid', placeItems: 'center', width: 44, height: 44, borderRadius: 13, background: s.bg, fontSize: 20, flex: 'none' }}>{s.icon}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: '-.04em', color: s.color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ marginTop: 5, color: '#6f7890', fontSize: 13, fontWeight: 800 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {FILTERS.map(([l, , dot]) => (
            <button key={l} onClick={() => setFilter(l)} style={pill(filter === l)}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: dot }} />{l}
              <span style={{ padding: '1px 8px', borderRadius: 99, background: filter === l ? 'rgba(255,255,255,.18)' : '#eef2f9', fontSize: 12, fontWeight: 900 }}>{counts[l] ?? 0}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search parent, child or teacher…" style={{ height: 40, width: 230, padding: '0 13px', border: '1px solid #dbe4f4', borderRadius: 10, fontSize: 14, background: '#fff', color: 'inherit' }} />
          <select value={sort} onChange={e => setSort(e.target.value as any)} style={{ height: 40, padding: '0 11px', border: '1px solid #dbe4f4', borderRadius: 10, background: '#fff', fontSize: 14, fontWeight: 800, color: '#151b33' }}>
            <option>Newest</option><option>Oldest</option><option>Most slots</option>
          </select>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, color: '#6f7890', fontWeight: 700, padding: '0 2px' }}>
        {[['⏳', 'Awaiting teacher'], ['✓', 'Accepted'], ['📌', 'Booked'], ['🔒', 'Taken'], ['✕', 'Teacher rejected'], ['⊘', 'Declined']].map(([i, t]) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>{i} {t}</span>
        ))}
      </div>

      {err && <div style={{ ...card, borderColor: '#f0c7c0', background: '#fdeeec', color: '#9a3a2c', fontSize: 13, padding: '9px 14px' }}>{err}</div>}

      {/* Table */}
      <div style={{ ...card, borderRadius: 16, overflow: 'hidden', boxShadow: '0 12px 30px rgba(21,32,56,.05)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 16, alignItems: 'center', padding: '12px 22px', background: '#0f2842', color: '#a9bdd6', fontSize: 11, fontWeight: 900, letterSpacing: '.1em', textTransform: 'uppercase' }}>
          <span>Parent / Child</span><span>Requested</span><span>Teacher</span><span>Slots</span><span>Status</span><span style={{ textAlign: 'center' }}>Actions</span>
        </div>

        {loading ? <div style={{ padding: 20, color: '#6f7890' }}>Loading…</div>
          : view.length === 0 ? <div style={{ padding: 46, textAlign: 'center' }}><p style={{ fontSize: 17, fontWeight: 900 }}>Nothing here</p><p style={{ color: '#6f7890', fontSize: 15, marginTop: 4 }}>No requests match this filter.</p></div>
            : view.map(r => {
              const k = stageOf(r); const edge = k === 'action' ? '#2f6fde' : k === 'awaiting' ? '#f7b12b' : k === 'booked' ? '#10a869' : k === 'partial' ? '#0b6f9e' : '#d42a21';
              const acc = r.slots.filter(s => slotTeacher(s, r) === 'accepted').length;
              const nPend = r.slots.filter(s => slotTeacher(s, r) === 'pending').length;
              const bk = r.slots.filter(s => s.outcome === 'approved').length;
              const substat = nPend ? `${nPend} awaiting${acc ? `, ${acc} accepted` : ''}` : (acc ? `Accepted ${acc}/${r.slots.length}` : `Teacher rejected all ${r.slots.length}`);
              const p = PILL[k]; const w = whenParts(r.created_at); const isOpen = open === r.id;
              const actionable = k === 'action' && canManage;
              const cset = chosenFor(r); const nBookable = bookableIds(r).length;

              return (
                <div key={r.id} style={{ borderBottom: '1px solid #eef2f9', background: isOpen ? '#f8faff' : '#fff' }}>
                  <div onClick={() => setOpen(isOpen ? null : r.id)} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 16, alignItems: 'center', padding: '15px 22px', borderLeft: `4px solid ${edge}`, cursor: 'pointer' }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 15, fontWeight: 900, ...ell }}>{r.parent_name}</p>
                      {r.student_name && <p style={{ marginTop: 3, color: '#6f7890', fontSize: 12.5, fontWeight: 700, ...ell }}>{r.student_name}</p>}
                      <p style={{ marginTop: 4, color: '#8b93aa', fontSize: 12, fontWeight: 600, ...ell }}><a href={`mailto:${r.parent_email}`} onClick={e => e.stopPropagation()} style={{ color: '#3a6bd0', textDecoration: 'none' }}>{r.parent_email}</a></p>
                      {r.parent_phone && <p style={{ marginTop: 3, color: '#8b93aa', fontSize: 12, fontWeight: 600, ...ell }}>{r.parent_phone}</p>}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 14, fontWeight: 900 }}>{w.date}</p>
                      <p style={{ marginTop: 3, color: '#6f7890', fontSize: 12.5, fontWeight: 700 }}>{w.time}</p>
                      {r.parent_timezone && <p style={{ marginTop: 3, color: '#8b93aa', fontSize: 12, fontWeight: 600, ...ell }}>{r.parent_timezone}</p>}
                    </div>
                    <div style={{ minWidth: 0 }}><p style={{ fontSize: 14.5, fontWeight: 900, ...ell }}>{teacherLabel(r)}</p></div>
                    <div style={{ minWidth: 0 }}><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{r.slots.map(s => slotChip(s, r))}</div></div>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ display: 'inline-block', padding: '5px 11px', borderRadius: 999, background: p.bg, color: p.fg, fontSize: 11, fontWeight: 900, letterSpacing: '.05em', whiteSpace: 'nowrap' }}>{p.label}</span>
                      <p style={{ marginTop: 5, color: '#6f7890', fontSize: 12, fontWeight: 700 }}>{substat}</p>
                    </div>
                    <div onClick={e => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {actionable ? (<>
                        <button onClick={() => approve(r)} disabled={busy === r.id || cset.size === 0} style={{ minHeight: 36, padding: '0 12px', border: 0, borderRadius: 9, background: cset.size ? '#0f7a52' : '#a9bfe4', color: '#fff', fontSize: 13, fontWeight: 900, cursor: cset.size ? 'pointer' : 'not-allowed', opacity: busy === r.id ? 0.6 : 1 }}>{busy === r.id ? 'Working…' : `Book ${cset.size || ''}`.trim()}</button>
                        <button onClick={() => reject(r)} disabled={busy === r.id} style={{ minHeight: 36, padding: '0 12px', border: '1.5px solid #f3c9c4', borderRadius: 9, background: '#fff', color: '#d42a21', fontSize: 13, fontWeight: 900, cursor: 'pointer' }}>Decline</button>
                      </>) : (
                        <span style={{ color: '#6f7890', fontSize: 13, fontWeight: 800, textAlign: 'center', padding: '6px 0' }}>{k === 'awaiting' ? 'Teacher to respond' : k === 'norefused' ? 'No slots accepted' : `${bk} booked`}</span>
                      )}
                    </div>
                    {r.notes && <div style={{ gridColumn: '1/-1', marginTop: 10, display: 'flex', gap: 8, alignItems: 'flex-start', color: '#6a5a2e', fontSize: 13, fontWeight: 600, lineHeight: 1.4, background: '#fffaf0', border: '1px solid #f4d58e', borderRadius: 10, padding: '9px 12px' }}><span>📝</span><span><strong style={{ fontWeight: 900, color: '#8a5a00' }}>Parent note:</strong> {r.notes}</span></div>}
                  </div>

                  {isOpen && (
                    <div style={{ padding: '6px 22px 20px', background: '#f8faff', borderTop: '1px dashed #dbe4f4' }}>
                      {actionable && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 0' }}>
                          <button onClick={() => approve(r)} disabled={busy === r.id || cset.size === 0} style={{ minHeight: 36, padding: '0 14px', borderRadius: 9, border: '1.5px solid #0f7a52', background: '#0f7a52', color: '#fff', fontSize: 13, fontWeight: 900, cursor: cset.size ? 'pointer' : 'not-allowed', opacity: (busy === r.id || cset.size === 0) ? 0.5 : 1 }}>Book selected{cset.size ? ` (${cset.size})` : ''}</button>
                          <button onClick={() => reject(r)} disabled={busy === r.id} style={{ minHeight: 36, padding: '0 14px', borderRadius: 9, border: '1.5px solid #f3c9c4', background: '#fff', color: '#d42a21', fontSize: 13, fontWeight: 900, cursor: 'pointer' }}>Decline request</button>
                          <span style={{ color: '#8b93aa', fontSize: 12.5, fontWeight: 700, marginLeft: 'auto' }}>Tick the accepted slots to book — any accepted slot you leave unticked is declined.</span>
                        </div>
                      )}
                      <div style={{ border: '1px solid #e3eaf6', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '44px minmax(0,.9fr) minmax(0,1.1fr) minmax(0,1.1fr)', gap: 14, alignItems: 'center', padding: '10px 18px', background: '#eef3fb', color: '#6f7890', fontSize: 11, fontWeight: 900, letterSpacing: '.08em', textTransform: 'uppercase' }}>
                          <span></span><span>Day / Time</span><span>Teacher response</span><span>Booking status</span>
                        </div>
                        {r.slots.map(s => {
                          const tt = slotTeacher(s, r); const tp = TP[tt] || TP.pending;
                          const ap = s.outcome === 'approved' ? AP.approved : s.outcome === 'taken' ? AP.taken : s.outcome === 'rejected' ? AP.rejected : (tt === 'accepted' ? AP.none : AP.na);
                          const bookable = isBookable(s, r); const checked = cset.has(s.slot_id);
                          const bg = s.outcome === 'approved' ? '#f4fbf7' : (tt === 'rejected' ? '#fdfafa' : '#fff');
                          return (
                            <div key={s.slot_id} style={{ display: 'grid', gridTemplateColumns: '44px minmax(0,.9fr) minmax(0,1.1fr) minmax(0,1.1fr)', gap: 14, alignItems: 'center', padding: '12px 18px', borderTop: '1px solid #f0f4fa', background: bg }}>
                              {actionable && bookable ? <input type="checkbox" checked={checked} onChange={() => toggleSlot(r, s.slot_id)} style={{ width: 18, height: 18, cursor: 'pointer' }} /> : <span />}
                              <span style={{ fontSize: 14.5, fontWeight: 900 }}>{shortDay(s.day_of_week)} <span style={{ color: '#8b93aa', fontWeight: 800, fontSize: 13 }}>{s.start_time}–{s.end_time}</span>{(() => { const tk = s.session_type || r.session_type; const mm = tk ? SESSION_TYPE[tk] : null; return mm ? <span style={{ marginLeft: 8, padding: '1px 7px', borderRadius: 999, background: mm.bg, color: mm.fg, fontSize: 10.5, fontWeight: 800 }}>{mm.label}</span> : null; })()}</span>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 900, color: tp.fg }}><span style={{ width: 9, height: 9, borderRadius: 99, background: tp.dot, flex: 'none' }} />{tp.label}</span>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 900, color: ap.fg }}><span style={{ width: 9, height: 9, borderRadius: 99, background: ap.dot, flex: 'none' }} />{ap.label}{tt !== 'accepted' && s.outcome !== 'approved' ? ` · ${tt === 'pending' ? 'teacher hasn’t replied' : 'teacher rejected'}` : ''}</span>
                            </div>
                          );
                        })}
                      </div>
                      {Array.isArray(r.custom_time_requests) && r.custom_time_requests.length > 0 && (
                        <div style={{ marginTop: 12, border: '1px solid #f0dcb0', background: '#fffaf0', borderRadius: 10, padding: '10px 12px' }}>
                          <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: '.08em', textTransform: 'uppercase', color: '#8a5a00', marginBottom: 6 }}>📅 Custom time requests</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {r.custom_time_requests.map((c: any, i: number) => (
                              <div key={i} style={{ fontSize: 12.5, color: '#6a5a2e' }}>
                                {c && typeof c === 'object'
                                  ? Object.entries(c).map(([k, v]) => <span key={k} style={{ marginRight: 12 }}><b style={{ color: '#8a5a00', fontWeight: 800 }}>{k}:</b> {String(v)}</span>)
                                  : String(c)}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {(r.decided_at || r.teacher_decided_at) && (
                        <div style={{ color: '#8b93aa', fontSize: 12, fontWeight: 700, marginTop: 10 }}>
                          {r.teacher_decided_at ? `Teacher decided ${new Date(r.teacher_decided_at).toLocaleString()}. ` : ''}
                          {r.decided_at ? `Admin decided ${new Date(r.decided_at).toLocaleString()}${r.decided_by_name ? ` by ${r.decided_by_name}` : ''}.` : ''}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
      </div>

      <p style={{ color: '#8b93aa', fontSize: 13, fontWeight: 600 }}>Flow: parent requests slots → teacher accepts or rejects each one in the teacher app → you book the accepted slots. Only teacher-accepted slots can be booked.</p>

      {/* Teacher leave */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 2px 0', fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.06em', color: '#647089' }}>
        Teacher leave<span style={{ background: '#7c3aed', color: '#fff', borderRadius: 999, fontSize: 10, fontWeight: 900, padding: '1px 7px' }}>{openLeave.length}</span>
      </div>
      {openLeave.length === 0 ? <div style={{ color: '#8b93aa', fontSize: 13, padding: '2px 2px' }}>No leave requests.</div> : (
        <div style={{ display: 'grid', gap: 10 }}>
          {openLeave.map(l => {
            const pend = l.status === 'pending';
            const range = l.start_date === l.end_date ? fmtLeave(l.start_date) : `${fmtLeave(l.start_date)} – ${fmtLeave(l.end_date)}`;
            return (
              <div key={l.id} style={{ ...card, borderLeft: '4px solid #7c3aed', padding: 14 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 900, fontSize: 16 }}>{l.teacher_name}</span>
                  <span style={{ fontSize: 11, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.04em', padding: '2px 8px', borderRadius: 999, background: '#eef2ff', color: '#4338ca' }}>Leave</span>
                  <span style={{ color: '#6f7890', fontSize: 12, marginLeft: 'auto' }}>{new Date(l.created_at).toLocaleString()}</span>
                </div>
                <div style={{ fontWeight: 900, fontSize: 15, marginTop: 8 }}>{range}</div>
                {l.reason && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap', background: '#f7f9fc', borderRadius: 8, padding: '6px 10px' }}>{l.reason}</div>}
                <div style={{ color: '#6f7890', fontSize: 12, marginTop: 6 }}><a href={`mailto:${l.teacher_email}`} style={{ color: '#3a6bd0' }}>{l.teacher_email}</a></div>
                {pend && canManage && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button onClick={() => decideLeave(l, 'approve')} disabled={busy === l.id} style={{ minHeight: 36, padding: '0 14px', borderRadius: 9, border: 0, background: '#0f9d6b', color: '#fff', fontSize: 13, fontWeight: 900, cursor: 'pointer', opacity: busy === l.id ? 0.6 : 1 }}>{busy === l.id ? 'Working…' : 'Approve leave'}</button>
                    <button onClick={() => decideLeave(l, 'reject')} disabled={busy === l.id} style={{ minHeight: 36, padding: '0 14px', borderRadius: 9, border: '1.5px solid #f3c9c4', background: '#fff', color: '#d42a21', fontSize: 13, fontWeight: 900, cursor: 'pointer' }}>Reject</button>
                  </div>
                )}
                {!pend && l.decided_at && <div style={{ color: '#8b93aa', fontSize: 12, marginTop: 8 }}>Decided {new Date(l.decided_at).toLocaleString()}{l.decided_by ? ` by ${l.decided_by}` : ''}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
