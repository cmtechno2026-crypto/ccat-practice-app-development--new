import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Requests inbox (Teacher Hub) — two kinds, split by tab:
//   • Parent requests: parents ask to book slots via a booking link; admin approves (books the chosen
//     slots) or rejects. Subjects/grades are intentionally omitted here — name + time are what matter.
//   • Teacher requests: teachers submit LEAVE (date range + reason) in the TeachTime app; admin
//     approves (which hides that teacher's availability for the range) or rejects.
interface Slot {
  slot_id: string; outcome: string; teacher_id: string; teacher_name: string;
  day_of_week: string; start_time: string; end_time: string; mode: string; status: string;
}
interface RequestRow {
  id: string; parent_name: string; parent_email: string; parent_phone: string | null;
  student_name: string | null; notes: string | null; parent_timezone: string | null;
  status: string; decided_by_name: string | null; decided_at: string | null; created_at: string; slots: Slot[];
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
function fmtDate(d: string) { const dt = new Date(d + (d.length <= 10 ? 'T00:00:00' : '')); return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }

export function BookingRequests() {
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');
  const [tab, setTab] = useState<'parent' | 'teacher'>('parent');
  const [status, setStatus] = useState('pending');
  const [sort, setSort] = useState('newest');
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [leave, setLeave] = useState<LeaveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [chosen, setChosen] = useState<Record<string, Set<string>>>({});

  const load = () => {
    setLoading(true); setErr('');
    if (tab === 'parent') api.teacherBookingRequests({ status }).then(r => setRows(r.requests)).catch(e => setErr(e.message)).finally(() => setLoading(false));
    else api.teacherLeaveRequests(status).then(r => setLeave(r.requests as LeaveRow[])).catch(e => setErr(e.message)).finally(() => setLoading(false));
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
    if (ids.length === 0) { setErr('Select at least one slot to approve, or reject the request.'); return; }
    setBusy(r.id); setErr('');
    try { const res = await api.teacherApproveRequest(r.id, ids.length === r.slots.length ? undefined : ids); load(); if (res.taken) setErr(`${res.taken} slot(s) were already taken and could not be booked.`); }
    catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };
  const reject = async (r: RequestRow) => {
    const reason = window.prompt('Reason for rejecting? (added to the request notes; optional)') ?? undefined;
    setBusy(r.id); setErr('');
    try { await api.teacherRejectRequest(r.id, reason || undefined); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };
  const decideLeave = async (l: LeaveRow, decision: 'approve' | 'reject') => {
    setBusy(l.id); setErr('');
    try { await api.teacherDecideLeave(l.id, decision); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };

  const sortedRows = useMemo(() => {
    const a = [...rows];
    if (sort === 'name') a.sort((x, y) => (x.parent_name || '').localeCompare(y.parent_name || ''));
    else a.sort((x, y) => (sort === 'oldest' ? 1 : -1) * String(y.created_at).localeCompare(String(x.created_at)));
    return a;
  }, [rows, sort]);
  const sortedLeave = useMemo(() => {
    const a = [...leave];
    if (sort === 'name') a.sort((x, y) => (x.teacher_name || '').localeCompare(y.teacher_name || ''));
    else a.sort((x, y) => (sort === 'oldest' ? 1 : -1) * String(y.created_at).localeCompare(String(x.created_at)));
    return a;
  }, [leave, sort]);

  const tabBtn = (key: 'parent' | 'teacher', label: string): React.CSSProperties => ({ cursor: 'pointer', fontWeight: 800, fontSize: 14, padding: '8px 16px', borderRadius: 10, border: tab === key ? '2px solid var(--brand,#2f6fd0)' : '1px solid var(--line,#e6e6ef)', background: tab === key ? 'var(--brand-soft,#e7f0fc)' : 'var(--card,#fff)', color: 'inherit' });

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => { setTab('parent'); setStatus('pending'); }} style={tabBtn('parent', 'Parent requests')}>Parent requests</button>
        <button onClick={() => { setTab('teacher'); setStatus('pending'); }} style={tabBtn('teacher', 'Teacher requests')}>Teacher requests</button>
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
          sortedRows.length === 0 ? <div className="muted" style={{ padding: 12 }}>Nothing here.</div> : (
            <div style={{ display: 'grid', gap: 10 }}>
              {sortedRows.map(r => {
                const pend = r.status === 'pending';
                const chosenSet = chosenFor(r);
                const teacherNames = [...new Set(r.slots.map(s => s.teacher_name).filter(Boolean))];
                const allIds = r.slots.map(s => s.slot_id);
                return (
                  <div key={r.id} style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 14 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 800, fontSize: 16 }}>{r.parent_name}</span>
                      {r.student_name && <span style={{ fontSize: 13 }} className="muted">for <b style={{ color: 'var(--ink,inherit)' }}>{r.student_name}</b></span>}
                      {teacherNames.length > 0 && <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--brand-soft,#e7f0fc)', color: 'var(--brand,#2f6fd0)' }}>👩‍🏫 {teacherNames.join(', ')}</span>}
                      {statusChip(r.status)}
                      <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{new Date(r.created_at).toLocaleString()}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                      <a href={`mailto:${r.parent_email}`}>{r.parent_email}</a>{r.parent_phone ? ` · ${r.parent_phone}` : ''}{r.parent_timezone ? ` · ${r.parent_timezone}` : ''}
                    </div>
                    {r.notes && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap', background: 'var(--card2,#f7f9fc)', borderRadius: 8, padding: '6px 10px' }}>{r.notes}</div>}
                    <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                      {r.slots.map(s => (
                        <label key={s.slot_id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: 'var(--card2,#f7f9fc)', borderRadius: 8, padding: '8px 10px', cursor: pend && canManage ? 'pointer' : 'default' }}>
                          {pend && canManage && <input type="checkbox" checked={chosenSet.has(s.slot_id)} onChange={() => pick(r.id, s.slot_id, allIds)} />}
                          <span style={{ fontWeight: 800, minWidth: 34 }}>{DAY_ABBR[s.day_of_week] || s.day_of_week}</span>
                          <span style={{ fontWeight: 700 }}>{s.start_time}–{s.end_time}</span>
                          <span className="muted" style={{ fontSize: 12.5 }}>{teacherNames.length > 1 ? `${s.teacher_name} · ${s.mode}` : s.mode}</span>
                          {s.status === 'booked' && s.outcome !== 'approved' && <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--amber,#b8860b)' }}>SLOT TAKEN</span>}
                          {s.outcome && s.outcome !== 'pending' && <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', color: '#666' }}>{s.outcome}</span>}
                        </label>
                      ))}
                    </div>
                    {pend && canManage && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                        <button onClick={() => approve(r)} disabled={busy === r.id} style={{ ...inp, cursor: 'pointer', fontWeight: 800, background: 'var(--good,#0f9d6b)', color: '#fff', border: 'none', opacity: busy === r.id ? 0.6 : 1 }}>{busy === r.id ? 'Working…' : `Approve ${chosenSet.size === allIds.length ? 'all' : chosenSet.size + ' slot(s)'}`}</button>
                        <button onClick={() => reject(r)} disabled={busy === r.id} style={{ ...inp, cursor: 'pointer', fontWeight: 800, color: 'var(--coral,#c0392b)' }}>Reject</button>
                      </div>
                    )}
                    {!pend && r.decided_at && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Decided {new Date(r.decided_at).toLocaleString()}{r.decided_by_name ? ` by ${r.decided_by_name}` : ''}</div>}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          sortedLeave.length === 0 ? <div className="muted" style={{ padding: 12 }}>Nothing here.</div> : (
            <div style={{ display: 'grid', gap: 10 }}>
              {sortedLeave.map(l => {
                const pend = l.status === 'pending';
                const range = l.start_date === l.end_date ? fmtDate(l.start_date) : `${fmtDate(l.start_date)} – ${fmtDate(l.end_date)}`;
                return (
                  <div key={l.id} style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderLeft: '4px solid var(--brand,#2f6fd0)', borderRadius: 12, padding: 14 }}>
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
          )
        )}
    </div>
  );
}
