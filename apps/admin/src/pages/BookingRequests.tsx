import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Booking Requests inbox (Teacher Hub). Parents submit requests via a booking link; an admin approves
// (books the chosen slots in one race-safe transaction) or rejects (slots stay available; reason is
// appended to the request notes). Approval outcomes per slot: approved / taken (grabbed meanwhile) /
// rejected (left out of the approve set).
interface Slot {
  slot_id: string; outcome: string; teacher_id: string; teacher_name: string; subject: string;
  day_of_week: string; start_time: string; end_time: string; mode: string; status: string; timezone: string;
}
interface RequestRow {
  id: string; link_id: string; num_classes: number; parent_name: string; parent_email: string;
  parent_phone: string | null; student_name: string | null; notes: string | null; parent_timezone: string | null;
  status: string; decided_by: string | null; decided_by_name: string | null; decided_at: string | null;
  created_at: string; link_subject: string; link_grade: number; link_label: string | null; slots: Slot[];
}

const inp: React.CSSProperties = { padding: '8px 10px', border: '1px solid var(--line,#d7dce8)', borderRadius: 8, background: 'var(--card2,#f7f9fc)', color: 'inherit' };
const DAY_ABBR: Record<string, string> = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };

export function BookingRequests() {
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [filter, setFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  // per-request chosen slots for approval (default: all requested slots)
  const [chosen, setChosen] = useState<Record<string, Set<string>>>({});

  const load = () => { setLoading(true); api.teacherBookingRequests({ status: filter }).then(r => setRows(r.requests)).catch(e => setErr(e.message)).finally(() => setLoading(false)); };
  useEffect(load, [filter]);

  const pick = (reqId: string, slotId: string, allSlots: string[]) => setChosen(prev => {
    const cur = prev[reqId] ? new Set(prev[reqId]) : new Set(allSlots);
    if (cur.has(slotId)) cur.delete(slotId); else cur.add(slotId);
    return { ...prev, [reqId]: cur };
  });
  const chosenFor = (r: RequestRow) => chosen[r.id] ?? new Set(r.slots.map(s => s.slot_id));

  const approve = async (r: RequestRow) => {
    const ids = [...chosenFor(r)];
    if (ids.length === 0) { setErr('Select at least one slot to approve, or reject the request.'); return; }
    setBusy(r.id); setErr('');
    try { const res = await api.teacherApproveRequest(r.id, ids.length === r.slots.length ? undefined : ids);
      setErr(''); load();
      if (res.taken) setErr(`${res.taken} slot(s) were already taken and could not be booked.`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };
  const reject = async (r: RequestRow) => {
    const reason = window.prompt('Reason for rejecting? (added to the request notes; optional)') ?? undefined;
    setBusy(r.id); setErr('');
    try { await api.teacherRejectRequest(r.id, reason || undefined); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };

  const reqChip = (st: string) => {
    const map: Record<string, [string, string]> = {
      pending: ['var(--amber,#b8860b)', '#fbf0d5'], approved: ['var(--good,#0f9d6b)', 'var(--good-soft,#dcf5ea)'],
      partially_approved: ['var(--brand,#2f6fd0)', 'var(--brand-soft,#e7f0fc)'], rejected: ['var(--coral,#c0392b)', 'var(--coral-soft,#fdece9)'],
      cancelled: ['var(--ink,#666)', '#eee'],
    };
    const [c, bg] = map[st] || ['#333', '#eee'];
    return <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', padding: '2px 8px', borderRadius: 999, background: bg, color: c }}>{st.replace('_', ' ')}</span>;
  };
  const outcomeChip = (o: string) => {
    if (!o || o === 'pending') return null;
    const map: Record<string, string> = { approved: 'var(--good,#0f9d6b)', taken: 'var(--amber,#b8860b)', rejected: 'var(--coral,#c0392b)', cancelled: '#888' };
    return <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', color: map[o] || '#666' }}>{o}</span>;
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {['pending', 'approved', 'partially_approved', 'rejected', 'all'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ ...inp, cursor: 'pointer', fontWeight: 700, textTransform: 'capitalize', border: filter === f ? '2px solid var(--brand,#2f6fd0)' : inp.border }}>{f.replace('_', ' ')}</button>
        ))}
      </div>
      {err && <div className="empty" style={{ padding: 10, color: 'var(--coral,#c0392b)' }}>{err}</div>}
      {loading ? <div className="muted" style={{ padding: 12 }}>Loading…</div> : rows.length === 0 ? <div className="muted" style={{ padding: 12 }}>Nothing here.</div> : (
        <div style={{ display: 'grid', gap: 10 }}>
          {rows.map(r => {
            const pend = r.status === 'pending';
            const chosenSet = chosenFor(r);
            const allIds = r.slots.map(s => s.slot_id);
            return (
              <div key={r.id} style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 14 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 800 }}>{r.parent_name}</span>
                  {reqChip(r.status)}
                  <span className="muted" style={{ fontSize: 12 }}>{r.link_subject} · G{r.link_grade} · {r.num_classes} class{r.num_classes === 1 ? '' : 'es'}</span>
                  <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{new Date(r.created_at).toLocaleString()}</span>
                </div>
                <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                  {r.student_name ? <>Student: <b>{r.student_name}</b> · </> : null}
                  <a href={`mailto:${r.parent_email}`}>{r.parent_email}</a>{r.parent_phone ? ` · ${r.parent_phone}` : ''}
                  {r.parent_timezone ? ` · ${r.parent_timezone}` : ''}
                </div>
                {r.notes && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap', background: 'var(--card2,#f7f9fc)', borderRadius: 8, padding: '6px 10px' }}>{r.notes}</div>}

                <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                  {r.slots.map(s => (
                    <label key={s.slot_id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: 'var(--card2,#f7f9fc)', borderRadius: 8, padding: '6px 10px', cursor: pend && canManage ? 'pointer' : 'default' }}>
                      {pend && canManage && <input type="checkbox" checked={chosenSet.has(s.slot_id)} onChange={() => pick(r.id, s.slot_id, allIds)} />}
                      <span style={{ fontWeight: 800, minWidth: 34 }}>{DAY_ABBR[s.day_of_week] || s.day_of_week}</span>
                      <span>{s.start_time}–{s.end_time}</span>
                      <span className="muted" style={{ fontSize: 12 }}>{s.teacher_name} · {s.subject} · {s.mode}</span>
                      {s.status === 'booked' && s.outcome !== 'approved' && <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--amber,#b8860b)' }}>SLOT TAKEN</span>}
                      <span style={{ marginLeft: 'auto' }}>{outcomeChip(s.outcome)}</span>
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
      )}
    </div>
  );
}
