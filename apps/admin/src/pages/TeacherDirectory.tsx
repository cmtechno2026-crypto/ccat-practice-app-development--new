import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Teacher Hub — Sample A (master-detail). Left: teacher roster. Right: the selected teacher's grouped
// subject+grade offerings, a status-only week of slots (Available / Unavailable / Booked), and the
// parent booking requests for that teacher. A request the TEACHER has accepted (teacher_status) shows
// a Book action here; booking writes the slot in the Teacher Hub DB with the child's name.
interface TeacherRow { id: string; name: string; email: string; subjects: string[]; slots: number; open_slots: number; created_at: string; }
interface Slot {
  id: string; subject: string; grade: number | null; grade_min?: number | null; grade_max?: number | null; day_of_week: string; start_time: string; end_time: string;
  mode: string; status: string; timezone: string; notes: string;
  booked_student?: string | null; booked_note?: string | null; booked_by?: string | null;
}
interface Req {
  id: string; num_classes: number; parent_name: string; parent_email: string; parent_phone: string | null;
  student_name: string | null; notes: string | null; status: string; teacher_status: string; teacher_decided_at: string | null;
  created_at: string; slots: Array<{ slot_id: string; teacher_id: string; teacher_name: string; day_of_week: string; start_time: string; end_time: string; outcome: string }>;
}

const DAY_ABBR: Record<string, string> = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const WEEK_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const GRADS = ['g1', 'g2', 'g3', 'g4', 'g5'];
const wdhStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '2px 2px 8px', fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--brand,#2f6fd0)' };
const countBadge: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: '#fff', background: 'var(--brand,#2f6fd0)', borderRadius: 999, minWidth: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' };

const PALETTE = [
  { bg: '#eef2ff', tx: '#4338ca', bd: '#c7d2fe' }, { bg: '#e2f6f3', tx: '#0f766e', bd: '#b7e6df' },
  { bg: '#fef6e7', tx: '#b45309', bd: '#fde3ad' }, { bg: '#fdeef2', tx: '#be123c', bd: '#fbcfe0' },
  { bg: '#f5edff', tx: '#7c3aed', bd: '#ddc9fb' }, { bg: '#e8f4fd', tx: '#0369a1', bd: '#bae0fb' },
  { bg: '#eafbf0', tx: '#067647', bd: '#bfe6cf' }, { bg: '#fdefe6', tx: '#c2410c', bd: '#f7ccae' },
  { bg: '#e6f7fb', tx: '#0e7490', bd: '#b3e6f0' }, { bg: '#fbecfb', tx: '#a21caf', bd: '#f2c9f0' },
];
function slotGrades(s: Slot) {
  const lo = s.grade_min != null ? Number(s.grade_min) : (s.grade != null ? Number(s.grade) : 1);
  const hi = s.grade_max != null ? Number(s.grade_max) : (s.grade != null ? Number(s.grade) : 12);
  return { lo, hi };
}
function gkey(s: Slot) { const g = slotGrades(s); return (g.lo === 1 && g.hi === 12) ? 'all' : (g.lo === g.hi ? String(g.lo) : (g.lo + '-' + g.hi)); }
function gradeShort(s: Slot) { const g = slotGrades(s); if (g.lo === 1 && g.hi === 12) return ''; return g.lo === g.hi ? ('G' + g.lo) : ('G' + g.lo + '-' + g.hi); }
function comboColor(subject: string, grade: string) {
  const k = String(subject || '').toLowerCase().trim() + '|' + (grade || 'all');
  let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
// Compress a sorted grade list into runs: [1,4,5] -> "1, 4–5".
function compressGrades(gs: number[]) {
  if (!gs.length) return '';
  const out: string[] = []; let a = gs[0], p = gs[0];
  for (let i = 1; i < gs.length; i++) { if (gs[i] === p + 1) { p = gs[i]; continue; } out.push(a === p ? String(a) : a + '–' + p); a = gs[i]; p = gs[i]; }
  out.push(a === p ? String(a) : a + '–' + p);
  return out.join(', ');
}
// Group a teacher's "Subject (Grade N)" list into { subject, grades[] }.
function groupSubjects(subjects: string[]) {
  const map = new Map<string, number[]>();
  (subjects || []).forEach(raw => {
    const m = /^(.*?)\s*\(\s*Grade\s*(\d{1,2})\s*\)\s*$/i.exec(raw || '');
    if (m) { const sub = m[1].trim(); const g = Number(m[2]); if (!map.has(sub)) map.set(sub, []); if (g >= 1 && g <= 12 && !map.get(sub)!.includes(g)) map.get(sub)!.push(g); }
    else if (raw && raw.trim()) { if (!map.has(raw.trim())) map.set(raw.trim(), []); }
  });
  return [...map.entries()].map(([subject, grades]) => ({ subject, grades: grades.sort((x, y) => x - y) }));
}

export function TeacherDirectory() {
  const [rows, setRows] = useState<TeacherRow[] | null>(null);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [slots, setSlots] = useState<Record<string, Slot[]>>({});
  const [slotErr, setSlotErr] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [savingSlot, setSavingSlot] = useState<string | null>(null);
  const [popSlot, setPopSlot] = useState<string | null>(null);
  const [comboSel, setComboSel] = useState<Record<string, string>>({});
  const [pStudent, setPStudent] = useState('');
  const [pNote, setPNote] = useState('');
  const [pErr, setPErr] = useState('');
  const [allReqs, setAllReqs] = useState<Req[] | null>(null);
  const [actingReq, setActingReq] = useState<string | null>(null);
  const [fSubject, setFSubject] = useState('');
  const [fGrade, setFGrade] = useState('');
  const [links, setLinks] = useState<any[]>([]);
  const [copied, setCopied] = useState(false);
  const studentRef = useRef<HTMLInputElement>(null);
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');

  const load = (q: string) => { setErr(''); api.teacherTeachers(q).then(r => setRows(r.teachers || [])).catch(e => setErr((e as Error).message || 'Failed to load')); };
  const loadReqs = () => { api.teacherBookingRequests({ status: 'all' }).then(r => setAllReqs((r.requests || []) as Req[])).catch(() => setAllReqs([])); };
  useEffect(() => { load(''); loadReqs(); }, []);
  useEffect(() => { api.teacherBookingLinks().then(r => setLinks(r.links || [])).catch(() => {}); }, []);

  const ensureSlots = async (id: string) => {
    if (slots[id]) return;
    setLoadingId(id);
    try { const r = await api.teacherSlots(id); setSlots(s => ({ ...s, [id]: r.slots || [] })); }
    catch (e) { setSlotErr(m => ({ ...m, [id]: (e as Error).message || 'Failed to load slots' })); }
    finally { setLoadingId(null); }
  };
  const selectTeacher = (id: string) => { setSelected(id); setPopSlot(null); ensureSlots(id); };
  // Auto-select the first teacher once the roster loads.
  useEffect(() => { if (rows && rows.length && !selected) selectTeacher(rows[0].id); /* eslint-disable-next-line */ }, [rows]);

  const reqsForTeacher = (id: string): Req[] => (allReqs || []).filter(r => (r.slots || []).some(s => s.teacher_id === id));
  const reqBadge = (id: string) => reqsForTeacher(id).filter(r => r.teacher_status === 'accepted' && r.status === 'pending').length;

  const openPopover = (slotId: string) => { setPopSlot(slotId); setPStudent(''); setPNote(''); setPErr(''); setTimeout(() => studentRef.current?.focus(), 0); };
  const patchLocal = (teacherId: string, slotId: string, next: Partial<Slot>) =>
    setSlots(m => ({ ...m, [teacherId]: (m[teacherId] || []).map(x => x.id === slotId ? { ...x, ...next } : x) }));

  const book = async (teacherId: string, slot: Slot) => {
    if (!pStudent.trim()) { setPErr('Student name is required.'); studentRef.current?.focus(); return; }
    setSavingSlot(slot.id); setPErr('');
    try {
      const u = await api.teacherSetSlotStatus(slot.id, 'booked', { student: pStudent.trim(), note: pNote.trim() });
      patchLocal(teacherId, slot.id, { status: 'booked', booked_student: u.booked_student, booked_note: u.booked_note, booked_by: u.booked_by });
      setPopSlot(null);
    } catch (e) { setPErr((e as Error).message || 'Could not book'); }
    finally { setSavingSlot(null); }
  };
  const unbook = async (teacherId: string, slot: Slot) => {
    setSavingSlot(slot.id);
    try {
      await api.teacherSetSlotStatus(slot.id, 'available');
      patchLocal(teacherId, slot.id, { status: 'available', booked_student: null, booked_note: null, booked_by: null });
    } catch (e) { setSlotErr(m => ({ ...m, [teacherId]: (e as Error).message || 'Could not update slot' })); }
    finally { setSavingSlot(null); }
  };

  // Admin books the slots the teacher accepted (child name comes from the request).
  const bookReq = async (teacherId: string, reqId: string) => {
    setActingReq(reqId);
    try { await api.teacherApproveRequest(reqId); const r = await api.teacherSlots(teacherId); setSlots(s => ({ ...s, [teacherId]: r.slots || [] })); loadReqs(); }
    catch (e) { setSlotErr(m => ({ ...m, [teacherId]: (e as Error).message || 'Could not book' })); }
    finally { setActingReq(null); }
  };
  const rejectReq = async (reqId: string) => {
    setActingReq(reqId);
    try { await api.teacherRejectRequest(reqId); loadReqs(); }
    catch (e) { setErr((e as Error).message || 'Could not reject'); }
    finally { setActingReq(null); }
  };

  const copyLink = async (url: string) => { try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };
  const initials = (n: string) => (n || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const inp = { padding: '7px 9px', border: '1px solid var(--line,#d7dce8)', borderRadius: 8, background: 'var(--card2,#f7f9fc)', color: 'inherit', width: '100%' } as React.CSSProperties;

  const slotById = (id: string, sid: string) => (slots[id] || []).find(x => x.id === sid) || null;
  const renderPopover = (id: string) => {
    if (!popSlot) return null;
    const s = slotById(id, popSlot);
    if (!s) return null;
    const booked = s.status === 'booked';
    const hasStudent = booked && !!(s.booked_student && s.booked_student.trim());
    return (
      <>
        <button aria-label="Close" onClick={() => setPopSlot(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(12,22,40,.28)', border: 0, zIndex: 40, cursor: 'default' }} />
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 50, width: 300, maxWidth: '92vw', background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, boxShadow: '0 20px 50px rgba(10,28,56,.32)', padding: 14, display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint,#93a6b3)' }}>{DAY_ABBR[s.day_of_week] || s.day_of_week} · {s.start_time}–{s.end_time} · {s.subject}</div>
          {booked ? (
            <>
              {hasStudent && <div style={{ fontSize: 13 }}>Booked for <b>{s.booked_student}</b>{s.booked_by ? <span className="muted"> · by {s.booked_by}</span> : null}</div>}
              {s.booked_note && <div className="muted" style={{ fontSize: 12 }}>📝 {s.booked_note}</div>}
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => unbook(id, s)} disabled={savingSlot === s.id} style={{ flex: 1, fontWeight: 800, padding: '7px', borderRadius: 8, border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'inherit', cursor: 'pointer', opacity: savingSlot === s.id ? .6 : 1 }}>{savingSlot === s.id ? 'Working…' : (hasStudent ? 'Unbook' : 'Make available')}</button>
                <button onClick={() => setPopSlot(null)} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'var(--muted,#5c7080)', cursor: 'pointer' }}>Close</button>
              </div>
            </>
          ) : (
            <>
              <input ref={studentRef} value={pStudent} onChange={e => setPStudent(e.target.value)} placeholder="Student name" autoComplete="off" style={inp}
                onKeyDown={e => { if (e.key === 'Enter') book(id, s); if (e.key === 'Escape') setPopSlot(null); }} />
              <input value={pNote} onChange={e => setPNote(e.target.value)} placeholder="Note (optional)" style={inp}
                onKeyDown={e => { if (e.key === 'Enter') book(id, s); if (e.key === 'Escape') setPopSlot(null); }} />
              {pErr && <div style={{ color: 'var(--coral,#c0392b)', fontSize: 12 }}>{pErr}</div>}
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => book(id, s)} disabled={savingSlot === s.id} style={{ flex: 1, fontWeight: 800, padding: '7px', borderRadius: 8, border: 0, background: 'var(--teal,#0f766e)', color: '#fff', cursor: 'pointer', opacity: savingSlot === s.id ? .6 : 1 }}>{savingSlot === s.id ? 'Booking…' : 'Book'}</button>
                <button onClick={() => setPopSlot(null)} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'var(--muted,#5c7080)', cursor: 'pointer' }}>Esc</button>
              </div>
            </>
          )}
        </div>
      </>
    );
  };
  const renderSlots = (id: string) => {
    if (loadingId === id && !slots[id]) return <div className="muted" style={{ padding: '10px 0' }}>Loading slots…</div>;
    if (slotErr[id]) return <div className="empty" style={{ padding: '10px 0' }}>{slotErr[id]}</div>;
    const list = slots[id] || [];
    if (list.length === 0) return <div className="muted" style={{ padding: '10px 0' }}>No slots for this teacher.</div>;
    const timeMin = (t: string) => { const p = String(t).split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); };
    const comboMap = new Map<string, { key: string; label: string; count: number }>();
    list.forEach(s => { const key = s.subject + '|' + gkey(s); const gs = gradeShort(s); const label = s.subject + (gs ? ' · ' + gs : ''); const e = comboMap.get(key); if (e) e.count++; else comboMap.set(key, { key, label, count: 1 }); });
    const combos = [...comboMap.values()].sort((a, b) => a.label.localeCompare(b.label));
    const selCombo = comboSel[id] || 'all';
    const filtered = selCombo === 'all' ? list : list.filter(s => (s.subject + '|' + gkey(s)) === selCombo);
    const tz = (filtered.find(s => s.timezone) || {} as any).timezone || '';
    const rowMap = new Map<string, { label: string; key: number }>();
    const cell: Record<string, Slot> = {};
    filtered.forEach(s => { const range = s.start_time + '–' + s.end_time; if (!rowMap.has(range)) rowMap.set(range, { label: range, key: timeMin(s.start_time) }); cell[s.day_of_week + '|' + range] = s; });
    const rowKeys = [...rowMap.keys()].sort((a, b) => rowMap.get(a)!.key - rowMap.get(b)!.key);
    return (
      <>
        {combos.length > 1 && (
          <div style={{ display: 'flex', gap: 2, borderBottom: '2px solid var(--line,#e6e6ef)', flexWrap: 'wrap', marginBottom: 4 }}>
            {[{ key: 'all', label: 'All', count: list.length }, ...combos].map(c => {
              const on = selCombo === c.key;
              return (
                <button key={c.key} onClick={() => setComboSel(m => ({ ...m, [id]: c.key }))}
                  style={{ cursor: 'pointer', fontSize: 13, fontWeight: 800, padding: '8px 12px', background: 'transparent', border: 0, borderBottom: '3px solid ' + (on ? 'var(--brand,#2f6fd0)' : 'transparent'), color: on ? 'var(--brand,#2f6fd0)' : 'var(--muted,#64748b)', marginBottom: -2 }}>
                  {c.label}<span style={{ fontSize: 11, opacity: .7, marginLeft: 5 }}>{c.count}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="cm-wg-wrap">
          <table className="cm-wg">
            <thead><tr><th></th>{WEEK_FULL.map(d => <th key={d}>{DAY_ABBR[d]}</th>)}</tr></thead>
            <tbody>
              {rowKeys.map(rk => (
                <tr key={rk}>
                  <td className="cm-wg-tl">{rowMap.get(rk)!.label}{tz ? <span className="cm-wg-tz"> {tz}</span> : null}</td>
                  {WEEK_FULL.map(d => {
                    const s = cell[d + '|' + rk];
                    if (!s) return <td key={d}><div className="cm-wg-empty">·</div></td>;
                    const booked = s.status === 'booked';
                    const hasStudent = booked && !!(s.booked_student && s.booked_student.trim());
                    const cls = hasStudent ? 'bk' : booked ? 'un' : 'av';
                    const lab = hasStudent ? 'Booked' : booked ? 'Unavailable' : 'Available';
                    return (
                      <td key={d}>
                        <div className={'cm-wg-cell ' + cls} onClick={canManage ? () => openPopover(s.id) : undefined} title={s.subject + (gradeShort(s) ? ' · ' + gradeShort(s) : '')} style={{ cursor: canManage ? 'pointer' : 'default' }}>
                          <span>{lab}</span>
                          {hasStudent && <span className="cm-wg-who">{s.booked_student}</span>}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="cm-wg-legend"><span className="cm-wg-sw av" /> Available<span className="cm-wg-sw bk" /> Booked<span className="cm-wg-sw un" /> Unavailable<span style={{ flex: 1 }} />{tz ? 'Times in ' + tz : ''}</div>
        {renderPopover(id)}
      </>
    );
  };
  const tstatusChip = (ts: string) => {
    const map: Record<string, [string, string, string]> = {
      pending: ['#fbf0d5', '#8a6d1b', 'Awaiting teacher'], accepted: ['var(--brand-soft,#e7f0fc)', 'var(--brand,#2f6fd0)', 'Teacher accepted'], declined: ['#e7ebf2', '#5c6675', 'Teacher declined'],
    };
    const [bg, c, lab] = map[ts] || ['#eee', '#333', ts];
    return <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', padding: '2px 8px', borderRadius: 20, background: bg, color: c }}>{lab}</span>;
  };
  const bstatusChip = (st: string) => {
    if (st === 'pending') return null;
    const map: Record<string, [string, string, string]> = {
      approved: ['var(--good-bg,#e2f6f3)', 'var(--good,#0f766e)', 'Booked'], partially_approved: ['var(--brand-soft,#e7f0fc)', 'var(--brand,#2f6fd0)', 'Partly booked'],
      rejected: ['var(--coral-soft,#fdecea)', 'var(--coral,#c0392b)', 'Rejected'], cancelled: ['#e7ebf2', '#5c6675', 'Cancelled'],
    };
    const [bg, c, lab] = map[st] || ['#eee', '#333', st];
    return <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', padding: '2px 8px', borderRadius: 20, background: bg, color: c }}>{lab}</span>;
  };

  const renderRequests = (id: string) => {
    if (allReqs === null) return <div className="muted" style={{ padding: '4px 0' }}>Loading requests…</div>;
    const list = reqsForTeacher(id).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (list.length === 0) return <div className="muted" style={{ padding: '4px 0' }}>No parent requests for this teacher.</div>;
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        {list.map(r => {
          const canBook = r.teacher_status === 'accepted' && r.status === 'pending';
          const terminal = r.status !== 'pending';
          const mine = (r.slots || []).filter(s => s.teacher_id === id);
          return (
            <div key={r.id} style={{ border: '1px solid var(--line,#e6e6ef)', borderLeft: '4px solid ' + (canBook ? 'var(--brand,#2f6fd0)' : r.teacher_status === 'declined' ? 'var(--coral,#c0392b)' : '#e2c05a'), borderRadius: 12, padding: 12, background: 'var(--card,#fff)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 800 }}>{r.parent_name}</span>
                {tstatusChip(r.teacher_status)}
                {bstatusChip(r.status)}
                <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{new Date(r.created_at).toLocaleDateString()}</span>
              </div>
              <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
                {r.student_name ? <>Student: <b>{r.student_name}</b> · </> : null}{r.num_classes} class{r.num_classes === 1 ? '' : 'es'}
                {r.parent_email ? <> · <a href={'mailto:' + r.parent_email}>{r.parent_email}</a></> : null}{r.parent_phone ? ' · ' + r.parent_phone : ''}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {mine.map(s => (
                  <span key={s.slot_id} style={{ fontSize: 11, fontWeight: 700, background: 'var(--card2,#f2f5fa)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 8, padding: '3px 8px' }}>
                    {DAY_ABBR[s.day_of_week] || s.day_of_week} {s.start_time}–{s.end_time}{s.outcome && s.outcome !== 'pending' ? ' · ' + s.outcome : ''}
                  </span>
                ))}
              </div>
              {r.notes && <div className="muted" style={{ fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap' }}>{r.notes}</div>}
              {canManage && !terminal && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  {canBook
                    ? <button onClick={() => bookReq(id, r.id)} disabled={actingReq === r.id} style={{ fontWeight: 800, fontSize: 12.5, borderRadius: 8, padding: '7px 14px', border: 0, background: 'var(--teal,#0f766e)', color: '#fff', cursor: 'pointer', opacity: actingReq === r.id ? .6 : 1 }}>{actingReq === r.id ? 'Booking…' : 'Book slots'}</button>
                    : <span className="muted" style={{ fontSize: 12 }}>{r.teacher_status === 'pending' ? 'Waiting for the teacher to accept…' : 'Teacher declined this request.'}</span>}
                  <button onClick={() => rejectReq(r.id)} disabled={actingReq === r.id} style={{ fontWeight: 700, fontSize: 12.5, borderRadius: 8, padding: '7px 12px', border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'var(--coral,#c0392b)', cursor: 'pointer' }}>Reject</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const subjOpts = [...new Set((rows || []).flatMap(t => groupSubjects(t.subjects).map(g => g.subject)))].sort();
  const gradeOpts = [...new Set((rows || []).flatMap(t => groupSubjects(t.subjects).flatMap(g => g.grades)))].sort((a, b) => a - b);
  const filteredRows = (rows || []).filter(t => {
    const q = search.trim().toLowerCase();
    if (q && !(t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q))) return false;
    const gs = groupSubjects(t.subjects);
    if (fSubject && !gs.some(g => g.subject === fSubject)) return false;
    if (fGrade && !gs.some(g => g.grades.includes(Number(fGrade)))) return false;
    return true;
  });
  const teacherLink = (rows && selected) ? (links.find((l: any) => Array.isArray(l.teacher_ids) && l.teacher_ids.includes(selected) && l.status === 'active') || links.find((l: any) => Array.isArray(l.teacher_ids) && l.teacher_ids.includes(selected)) || null) : null;
  const sel = rows && selected ? rows.find(t => t.id === selected) : null;

  return (
    <div>
      <style>{`
        .cm-md{display:grid;grid-template-columns:320px 1fr;gap:14px;align-items:start}
        .cm-av.g1{background:linear-gradient(135deg,#2f6fd0,#1e4e9e)}
        .cm-av.g2{background:linear-gradient(135deg,#7c3aed,#5b21b6)}
        .cm-av.g3{background:linear-gradient(135deg,#0f766e,#0b5a54)}
        .cm-av.g4{background:linear-gradient(135deg,#d4620e,#b45309)}
        .cm-av.g5{background:linear-gradient(135deg,#be123c,#9d174d)}
        .cm-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;padding:10px 0 0}
        .cm-wday{border:1px solid var(--line,#e6e6ef);border-radius:12px;padding:8px 8px 10px;min-height:88px}
        .cm-wday.cm-empty{opacity:.5}
        .cm-wg-wrap{overflow-x:auto}
        .cm-wg{border-collapse:separate;border-spacing:6px;width:100%;min-width:640px}
        .cm-wg th{font-size:11px;color:var(--brand,#2f6fd0);text-transform:uppercase;letter-spacing:.04em;font-weight:800;text-align:center;padding:2px}
        .cm-wg td{padding:0;vertical-align:top}
        .cm-wg-tl{font-size:11px;color:var(--muted,#64748b);font-weight:700;white-space:nowrap;text-align:right;padding-right:6px}
        .cm-wg-tz{font-size:9px;letter-spacing:.03em}
        .cm-wg-cell{border-radius:10px;padding:8px 6px;font-size:11px;font-weight:800;text-align:center;border:1.5px solid;display:flex;flex-direction:column;gap:2px;align-items:center;justify-content:center;min-height:44px}
        .cm-wg-cell.av{border-color:#0f766e;background:#e6f7f2;color:#0f766e}
        .cm-wg-cell.bk{border-color:#b45309;color:#b45309;background:repeating-linear-gradient(45deg,#fbeeda,#fbeeda 6px,#fff6e9 6px,#fff6e9 12px)}
        .cm-wg-cell.un{border-color:#c7ccd6;color:#6b7280;background:repeating-linear-gradient(45deg,#eef1f6,#eef1f6 6px,#f7f9fc 6px,#f7f9fc 12px)}
        .cm-wg-who{font-size:10px;font-weight:700}
        .cm-wg-empty{border:1.5px dashed var(--line,#e6e6ef);border-radius:10px;color:#c3ccda;text-align:center;padding:8px 6px;min-height:44px;display:flex;align-items:center;justify-content:center}
        .cm-wg-legend{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted,#64748b);margin-top:8px;flex-wrap:wrap}
        .cm-wg-sw{width:12px;height:12px;border-radius:3px;border:1.5px solid;display:inline-block}
        .cm-wg-sw.av{border-color:#0f766e;background:#e6f7f2}
        .cm-wg-sw.bk{border-color:#b45309;background:#fbeeda}
        .cm-wg-sw.un{border-color:#c7ccd6;background:#eef1f6}
        @media(max-width:920px){
          .cm-md{grid-template-columns:1fr}
          .cm-week{grid-template-columns:1fr}
          .cm-wday.cm-empty{display:none}
          .cm-wday{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}
          .cm-wday>div:first-child{width:100%}
          .cm-slot{flex:1 1 240px;margin-bottom:0 !important}
        }
      `}</style>
      {err && <div className="empty" style={{ marginBottom: 12 }}>{err}</div>}
      {!rows && !err && <div className="empty">Loading…</div>}
      {rows && (
        <div className="cm-md">
          {/* LEFT: roster */}
          <div style={{ display: 'grid', gap: 10 }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or email…"
              style={{ padding: '8px 10px', border: '1px solid var(--line,#e6e6ef)', borderRadius: 10, background: 'var(--card,#fff)', color: 'inherit' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={fSubject} onChange={e => setFSubject(e.target.value)} style={{ flex: 1, padding: '7px 9px', border: '1px solid var(--line,#e6e6ef)', borderRadius: 10, background: 'var(--card,#fff)', color: 'inherit', cursor: 'pointer' }}>
                <option value="">All subjects</option>
                {subjOpts.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
              <select value={fGrade} onChange={e => setFGrade(e.target.value)} style={{ flex: 1, padding: '7px 9px', border: '1px solid var(--line,#e6e6ef)', borderRadius: 10, background: 'var(--card,#fff)', color: 'inherit', cursor: 'pointer' }}>
                <option value="">All grades</option>
                {gradeOpts.map(g => <option key={g} value={String(g)}>Grade {g}</option>)}
              </select>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {filteredRows.length === 0 && <div className="muted" style={{ padding: 8 }}>No teachers found.</div>}
              {filteredRows.map((t, i) => {
                const on = selected === t.id; const badge = reqBadge(t.id);
                return (
                  <button key={t.id} onClick={() => selectTeacher(t.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', width: '100%', padding: 10, borderRadius: 12, cursor: 'pointer',
                      border: '1px solid ' + (on ? 'var(--brand,#2f6fd0)' : 'var(--line,#e6e6ef)'), background: on ? 'var(--brand-soft,#e7f0fc)' : 'var(--card,#fff)', color: 'inherit' }}>
                    <span className={'cm-av ' + GRADS[i % GRADS.length]} style={{ width: 38, height: 38, borderRadius: '50%', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 13, flex: 'none' }}>{initials(t.name)}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 800, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                      <span className="muted" style={{ fontSize: 11.5 }}>{t.slots} slots · {t.open_slots} open</span>
                    </span>
                    {badge > 0 && <span style={{ ...countBadge, background: 'var(--amber,#b45309)' }}>{badge}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* RIGHT: detail */}
          <div style={{ border: '1px solid var(--line,#e6e6ef)', borderRadius: 14, background: 'var(--card,#fff)', padding: 16, minHeight: 200 }}>
            {!sel ? <div className="muted" style={{ padding: 20, textAlign: 'center' }}>Select a teacher.</div> : (
              <div style={{ display: 'grid', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span className={'cm-av ' + GRADS[(filteredRows.findIndex(t => t.id === sel.id)) % GRADS.length]} style={{ width: 44, height: 44, borderRadius: '50%', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 15, flex: 'none' }}>{initials(sel.name)}</span>
                  <div><div style={{ fontWeight: 800, fontSize: 17 }}>{sel.name}</div><div className="muted" style={{ fontSize: 12 }}>{sel.email}</div></div>
                  {reqBadge(sel.id) > 0 && <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 800, color: 'var(--amber,#b45309)' }}>{reqBadge(sel.id)} ready to book</span>}
                </div>

                <div>
                  <h4 style={{ margin: '0 0 8px', fontSize: 12, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#64748b)' }}>Teaches</h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {groupSubjects(sel.subjects).map(g => { const c = comboColor(g.subject, 'all'); return (
                      <span key={g.subject} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 8, background: c.bg, color: c.tx, border: '1px solid ' + c.bd }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.tx }} />{g.subject}{g.grades.length ? <span style={{ fontWeight: 800 }}>{' · ' + compressGrades(g.grades)}</span> : null}
                      </span>
                    ); })}
                    {groupSubjects(sel.subjects).length === 0 && <span className="muted" style={{ fontSize: 12 }}>No subjects listed.</span>}
                  </div>
                </div>

                <div>
                  <h4 style={{ margin: '0 0 6px', fontSize: 12, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#64748b)' }}>Booking link</h4>
                  {teacherLink ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'var(--card2,#f2f5fa)', border: '1px solid var(--line,#e6e9f0)', borderRadius: 8, padding: '6px 8px' }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: teacherLink.url ? 'inherit' : 'var(--muted,#8a93a3)' }}>{teacherLink.url || ('/b/' + teacherLink.token)}</span>
                      <button onClick={() => copyLink(teacherLink.url || ('/b/' + teacherLink.token))} title="Copy link" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', borderRadius: 6, padding: '4px 8px', color: copied ? 'var(--good,#0f9d6b)' : 'inherit', fontWeight: 700, fontSize: 12 }}>{copied ? 'Copied' : 'Copy'}</button>
                    </div>
                  ) : <div className="muted" style={{ fontSize: 12 }}>No active booking link — create one in Link Generator.</div>}
                </div>

                <div>
                  <h4 style={{ margin: '0 0 4px', fontSize: 12, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#64748b)' }}>Availability</h4>
                  {renderSlots(sel.id)}
                </div>

                <div>
                  <h4 style={{ margin: '0 0 8px', fontSize: 12, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#64748b)' }}>Parent requests {reqBadge(sel.id) > 0 && <span style={{ ...countBadge, background: 'var(--amber,#b45309)' }}>{reqBadge(sel.id)}</span>}</h4>
                  {renderRequests(sel.id)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
