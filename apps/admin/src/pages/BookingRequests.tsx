import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Requests inbox (Teacher Hub) — routed by the TEACHER's decision:
//   • Parent requests: booking requests still on the teacher's side — Pending (teacher hasn't decided)
//     or Declined (kept, annotated "Declined by <teacher>"). Admin can Reject/close here.
//   • Teacher requests: things needing a teacher/admin action — bookings the teacher ACCEPTED
//     ("Ready to book", admin books the child in), plus teacher LEAVE requests.
// Subjects/grades are intentionally omitted; the teacher shows on the header line, not per slot.
interface Slot {
  slot_id: string; outcome: string; teacher_id: string; teacher_name: string;
  day_of_week: string; start_time: string; end_time: string; mode: string; status: string;
}
interface RequestRow {
  id: string; parent_name: string; parent_email: string; parent_phone: string | null;
  student_name: string | null; notes: string | null; parent_timezone: string | null;
  status: string; teacher_status: string; teacher_decided_at: string | null;
  decided_by_name: string | null; decided_at: string | null; created_at: string; slots: Slot[];
}
interface LeaveRow {
  id: string; teacher_id: string; teacher_name: string; teacher_email: string;
  start_date: string; end_date: string; reason: string; status: string;
  decided_by: string | null; decided_at: string | null; created_at: string;
}

const inp: React.CSSProperties = { padding: '8px 10px', border: '1px solid var(--line,#d7dce8)', borderRadius: 8, background: 'var(--card2,#f7f9fc)', color: 'inherit' };
const DAY_ABBR: Record<string, string> = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const chipStyle = (bg: string, c: string): React.CSSProperties => ({ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', padding: '2px 8px', borderRadius: 999, background: bg, color: c });
function statusChip(st: string) {
  const map: Record<string, [string, string]> = {
    pending: ['#fbf0d5', 'var(--amber,#b8860b)'], approved: ['var(--good-soft,#dcf5ea)', 'var(--good,#0f9d6b)'],
    partially_approved: ['var(--brand-soft,#e7f0fc)', 'var(--brand,#2f6fd0)'], rejected: ['var(--coral-soft,#fdece9)', 'var(--coral,#c0392b)'],
    cancelled: ['#eee', '#666'],
  };
  const [bg, c] = map[st] || ['#eee', '#333'];
  return <span style={chipStyle(bg, c)}>{st.replace('_', ' ')}</span>;
}
const teacherChip = (names: string[]) => names.length > 0
  ? <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--brand-soft,#e7f0fc)', color: 'var(--brand,#2f6fd0)' }}>👩‍🏫 {names.join(', ')}</span>
  : null;
function fmtDate(d: string) { const dt = new Date(d + (d.length <= 10 ? 'T00:00:00' : '')); return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }
const namesOf = (r: RequestRow) => [...new Set(r.slots.map(s => s.teacher_name).filter(Boolean))];
// Teacher who declined: prefer the request's slot teacher(s).
const declinedBy = (r: RequestRow) => namesOf(r).join(', ') || 'the teacher';

export function BookingRequests() {
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');
  const [tab, setTab] = useState<'parent' | 'teacher'>('parent');
  const [status, setStatus] = useState('pending');
  const [sort, setSort] = useState('newest');
  const [rows, setRows] = useState<RequestRow[]>([]);       // parent-tab bookings
  const [ready, setReady] = useState<RequestRow[]>([]);     // teacher-tab: accepted & pending bookings
  const [leave, setLeave] = useState<LeaveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [chosen, setChosen] = useState<Record<string, Set<string>>>({});

  const load = () => {
    setLoading(true); setErr('');
    if (tab === 'parent') {
      api.teacherBookingRequests({ status }).then(r => setRows(r.requests)).catch(e => setErr(e.message)).finally(() => setLoading(false));
    } else {
      Promise.all([
        api.teacherBookingRequests({ teacher_status: 'accepted', status: 'pending' }).then(r => r.requests || []).catch(() => []),
        api.teacherLeaveRequests(status).then(r => (r.requests as LeaveRow[]) || []).catch(() => []),
      ]).then(([rb, lv]) => { setReady(rb as RequestRow[]); setLeave(lv); }).finally(() => setLoading(false));
    }
  };
  useEffect(load, [tab, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const statusOpts = tab === 'parent'
    ? ['pending', 'approved', 'partially_approved', 'rejected', 'all']
    : ['pending', 'approved', 'rejected', 'cancelled', 'all'];

  const chosenFor = (r: RequestRow) => chosen[r.id] ?? new Set(r.slots.map(s => s.slot_id));
  const pick = (reqId: string, slotId: string, allSlots: string[]) => setChosen(prev => {
    const cur = prev[reqId] ? new Set(prev[reqId]) : new Set(allSlots);
    if (cur.has(slotId)) cur.delete(slotId); else cur.add(slotId);
    return { ...prev, [reqId]: cur };
  });

  const approve = async (r: RequestRow) => {
    const ids = [...chosenFor(r)];
    if (ids.length === 0) { setErr('Select at least one slot to book, or reject the request.'); return; }
    setBusy(r.id); setErr('');
    try { const res = await api.teacherApproveRequest(r.id, ids.length === r.slots.length ? undefined : ids); load(); if (res.taken) setErr(`${res.taken} slot(s) were already taken and could not be booked.`); }
    catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };
  const reject = async (r: RequestRow) => {
    const reason = window.prompt('Reason for rejecting? (added to the request notes; optional)') ?? undefined;
    setBusy(r.id); setErr('');
    try { await api.teacherRejectRequest(r.id, reason || undefined); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };
  const acceptOnBehalf = async (r: RequestRow) => {
    setBusy(r.id); setErr('');
    try { await api.teacherSetTeacherDecision(r.id, 'accept'); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };
  const decideLeave = async (l: LeaveRow, decision: 'approve' | 'reject') => {
    setBusy(l.id); setErr('');
    try { await api.teacherDecideLeave(l.id, decision); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };

  const sortRows = (arr: RequestRow[]) => {
    const a = [...arr];
    if (sort === 'name') a.sort((x, y) => (x.parent_name || '').localeCompare(y.parent_name || ''));
    else a.sort((x, y) => (sort === 'oldest' ? 1 : -1) * String(y.created_at).localeCompare(String(x.created_at)));
    return a;
  };
  // Parent tab excludes requests the teacher already accepted while still pending (those live under Teacher requests).
  const parentRows = useMemo(() => sortRows(rows.filter(r => !(r.teacher_status === 'accepted' && r.status === 'pending'))), [rows, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const readyRows = useMemo(() => sortRows(ready), [ready, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const sortedLeave = useMemo(() => {
    const a = [...leave];
    if (sort === 'name') a.sort((x, y) => (x.teacher_name || '').localeCompare(y.teacher_name || ''));
    else a.sort((x, y) => (sort === 'oldest' ? 1 : -1) * String(y.created_at).localeCompare(String(x.created_at)));
    return a;
  }, [leave, sort]);
  const showReady = status === 'pending' || status === 'all';

  const tabBtn = (key: 'parent' | 'teacher'): React.CSSProperties => ({ cursor: 'pointer', fontWeight: 800, fontSize: 14, padding: '8px 16px', borderRadius: 10, border: tab === key ? '2px solid var(--brand,#2f6fd0)' : '1px solid var(--line,#e6e6ef)', background: tab === key ? 'var(--brand-soft,#e7f0fc)' : 'var(--card,#fff)', color: 'inherit' });
  const groupLabel = (t: string, n: number, sub?: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 2px 6px', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted,#647089)' }}>
      {t}<span style={{ background: 'var(--brand,#2f6fd0)', color: '#fff', borderRadius: 999, fontSize: 10, fontWeight: 800, padding: '1px 7px' }}>{n}</span>{sub && <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>· {sub}</span>}
    </div>
  );

  // A parent-tab card (read-only slots; teacher must accept before booking).
  const parentCard = (r: RequestRow) => {
    const names = namesOf(r);
    const declined = r.teacher_status === 'declined';
    const waiting = r.status === 'pending' && r.teacher_status === 'pending';
    return (
      <div key={r.id} style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderLeft: declined ? '4px solid var(--coral,#c0392b)' : '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 14 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 16 }}>{r.parent_name}</span>
          {r.student_name && <span style={{ fontSize: 13 }} className="muted">for <b style={{ color: 'var(--ink,inherit)' }}>{r.student_name}</b></span>}
          {teacherChip(names)}
          {r.status !== 'pending' ? statusChip(r.status) : declined ? <span style={chipStyle('var(--coral-soft,#fdece9)', 'var(--coral,#c0392b)')}>Declined</span> : <span style={chipStyle('#fbf0d5', 'var(--amber,#b8860b)')}>Pending</span>}
          <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{new Date(r.created_at).toLocaleString()}</span>
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
          <a href={`mailto:${r.parent_email}`}>{r.parent_email}</a>{r.parent_phone ? ` · ${r.parent_phone}` : ''}{r.parent_timezone ? ` · ${r.parent_timezone}` : ''}
        </div>
        {declined && <div style={{ marginTop: 8, fontSize: 12.5, borderRadius: 8, padding: '7px 10px', background: 'var(--coral-soft,#fdece9)', color: '#8a2318', border: '1px solid #f4cfc8' }}>✕ Declined by <b>{declinedBy(r)}</b>{r.teacher_decided_at ? ` · ${new Date(r.teacher_decided_at).toLocaleString()}` : ''}</div>}
        {waiting && <div className="muted" style={{ marginTop: 8, fontSize: 12.5, borderRadius: 8, padding: '7px 10px', background: 'var(--card2,#f7f9fc)' }}>Waiting for {names.length ? names.join(', ') : 'the teacher'} to accept in the teacher app.</div>}
        {r.notes && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap', background: 'var(--card2,#f7f9fc)', borderRadius: 8, padding: '6px 10px' }}>{r.notes}</div>}
        <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
          {r.slots.map(s => (
            <div key={s.slot_id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: 'var(--card2,#f7f9fc)', borderRadius: 8, padding: '8px 10px' }}>
              <span style={{ fontWeight: 800, minWidth: 34 }}>{DAY_ABBR[s.day_of_week] || s.day_of_week}</span>
              <span style={{ fontWeight: 700 }}>{s.start_time}–{s.end_time}</span>
              <span className="muted" style={{ fontSize: 12.5 }}>{names.length > 1 ? `${s.teacher_name} · ${s.mode}` : s.mode}</span>
            </div>
          ))}
        </div>
        {r.status === 'pending' && canManage && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {r.teacher_status === 'pending' && <button onClick={() => acceptOnBehalf(r)} disabled={busy === r.id} title="Accept on behalf of the teacher" style={{ ...inp, cursor: 'pointer', fontWeight: 800, background: 'var(--good,#0f9d6b)', color: '#fff', border: 'none', opacity: busy === r.id ? 0.6 : 1 }}>{busy === r.id ? 'Working…' : 'Accept for teacher'}</button>}
            <button onClick={() => reject(r)} disabled={busy === r.id} style={{ ...inp, cursor: 'pointer', fontWeight: 800, color: 'var(--coral,#c0392b)' }}>{declined ? 'Close request' : 'Reject'}</button>
          </div>
        )}
        {r.status !== 'pending' && r.decided_at && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Decided {new Date(r.decided_at).toLocaleString()}{r.decided_by_name ? ` by ${r.decided_by_name}` : ''}</div>}
      </div>
    );
  };

  // A "ready to book" card (teacher accepted): checkboxes + Book slots.
  const readyCard = (r: RequestRow) => {
    const names = namesOf(r);
    const chosenSet = chosenFor(r);
    const allIds = r.slots.map(s => s.slot_id);
    return (
      <div key={r.id} style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderLeft: '4px solid var(--good,#0f9d6b)', borderRadius: 12, padding: 14 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 16 }}>{r.parent_name}</span>
          {r.student_name && <span style={{ fontSize: 13 }} className="muted">for <b style={{ color: 'var(--ink,inherit)' }}>{r.student_name}</b></span>}
          {teacherChip(names)}
          <span style={chipStyle('var(--good-soft,#dcf5ea)', 'var(--good,#0f9d6b)')}>Accepted</span>
          <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{new Date(r.created_at).toLocaleString()}</span>
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}><a href={`mailto:${r.parent_email}`}>{r.parent_email}</a>{r.parent_phone ? ` · ${r.parent_phone}` : ''}</div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12.5, borderRadius: 8, padding: '7px 10px', background: 'var(--card2,#f7f9fc)' }}>{names.length ? names.join(', ') : 'The teacher'} accepted — book the slots to confirm (the child's name is attached).</div>
        {r.notes && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap', background: 'var(--card2,#f7f9fc)', borderRadius: 8, padding: '6px 10px' }}>{r.notes}</div>}
        <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
          {r.slots.map(s => (
            <label key={s.slot_id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: 'var(--card2,#f7f9fc)', borderRadius: 8, padding: '8px 10px', cursor: canManage ? 'pointer' : 'default' }}>
              {canManage && <input type="checkbox" checked={chosenSet.has(s.slot_id)} onChange={() => pick(r.id, s.slot_id, allIds)} />}
              <span style={{ fontWeight: 800, minWidth: 34 }}>{DAY_ABBR[s.day_of_week] || s.day_of_week}</span>
              <span style={{ fontWeight: 700 }}>{s.start_time}–{s.end_time}</span>
              <span className="muted" style={{ fontSize: 12.5 }}>{names.length > 1 ? `${s.teacher_name} · ${s.mode}` : s.mode}</span>
            </label>
          ))}
        </div>
        {canManage && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={() => approve(r)} disabled={busy === r.id} style={{ ...inp, cursor: 'pointer', fontWeight: 800, background: 'var(--teal,#0f766e)', color: '#fff', border: 'none', opacity: busy === r.id ? 0.6 : 1 }}>{busy === r.id ? 'Booking…' : `Book ${chosenSet.size === allIds.length ? 'slots' : chosenSet.size + ' slot(s)'}`}</button>
            <button onClick={() => reject(r)} disabled={busy === r.id} style={{ ...inp, cursor: 'pointer', fontWeight: 800, color: 'var(--coral,#c0392b)' }}>Reject</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => { setTab('parent'); setStatus('pending'); }} style={tabBtn('parent')}>Parent requests</button>
        <button onClick={() => { setTab('teacher'); setStatus('pending'); }} style={tabBtn('teacher')}>Teacher requests</button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {statusOpts.map(f => (
          <button key={f} onClick={() => setStatus(f)} style={{ ...inp, cursor: 'pointer', fontWeight: 700, textTransform: 'capitalize', border: status === f ? '2px solid var(--brand,#2f6fd0)' : inp.border }}>{f.replace('_', ' ')}</button>
        ))}
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }} className="muted">Sort
          <select value={sort} onChange={e => setSort(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
            <option value="newest">Newest</option><option value="oldest">Oldest</option><option value="name">Name</option>
          </select>
        </label>
      </div>

      {err && <div className="empty" style={{ padding: 10, color: 'var(--coral,#c0392b)' }}>{err}</div>}

      {loading ? <div className="muted" style={{ padding: 12 }}>Loading…</div>
        : tab === 'parent' ? (
          parentRows.length === 0 ? <div className="muted" style={{ padding: 12 }}>Nothing here.</div>
            : <div style={{ display: 'grid', gap: 10 }}>{parentRows.map(parentCard)}</div>
        ) : (
          <div>
            {showReady && (readyRows.length > 0
              ? <>{groupLabel('Ready to book', readyRows.length, 'teacher accepted')}<div style={{ display: 'grid', gap: 10 }}>{readyRows.map(readyCard)}</div></>
              : <>{groupLabel('Ready to book', 0, 'teacher accepted')}<div className="muted" style={{ padding: '4px 2px 8px' }}>No accepted requests waiting to be booked.</div></>)}
            {groupLabel('Leave', sortedLeave.length)}
            {sortedLeave.length === 0 ? <div className="muted" style={{ padding: '4px 2px' }}>No leave requests.</div> : (
              <div style={{ display: 'grid', gap: 10 }}>
                {sortedLeave.map(l => {
                  const pend = l.status === 'pending';
                  const range = l.start_date === l.end_date ? fmtDate(l.start_date) : `${fmtDate(l.start_date)} – ${fmtDate(l.end_date)}`;
                  return (
                    <div key={l.id} style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderLeft: '4px solid #7c3aed', borderRadius: 12, padding: 14 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 800, fontSize: 16 }}>{l.teacher_name}</span>
                        <span style={chipStyle('#eef2ff', '#4338ca')}>Leave</span>
                        {statusChip(l.status)}
                        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{new Date(l.created_at).toLocaleString()}</span>
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 15, marginTop: 8 }}>{range}</div>
                      {l.reason && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap', background: 'var(--card2,#f7f9fc)', borderRadius: 8, padding: '6px 10px' }}>{l.reason}</div>}
                      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}><a href={`mailto:${l.teacher_email}`}>{l.teacher_email}</a></div>
                      {pend && canManage && (
                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                          <button onClick={() => decideLeave(l, 'approve')} disabled={busy === l.id} style={{ ...inp, cursor: 'pointer', fontWeight: 800, background: 'var(--good,#0f9d6b)', color: '#fff', border: 'none', opacity: busy === l.id ? 0.6 : 1 }}>{busy === l.id ? 'Working…' : 'Approve leave'}</button>
                          <button onClick={() => decideLeave(l, 'reject')} disabled={busy === l.id} style={{ ...inp, cursor: 'pointer', fontWeight: 800, color: 'var(--coral,#c0392b)' }}>Reject</button>
                        </div>
                      )}
                      {!pend && l.decided_at && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Decided {new Date(l.decided_at).toLocaleString()}{l.decided_by ? ` by ${l.decided_by}` : ''}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
    </div>
  );
}
