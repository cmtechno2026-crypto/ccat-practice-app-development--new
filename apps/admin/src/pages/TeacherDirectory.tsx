import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Teacher Hub — Sample A (master-detail). Left: teacher roster. Right: the selected teacher's grouped
// subject+grade offerings, a status-only week of slots (Available / Unavailable / Booked), and the
// parent booking requests for that teacher. A request the TEACHER has accepted (teacher_status) shows
// a Book action here; booking writes the slot in the Teacher Hub DB with the child's name.
interface TeacherRow { id: string; name: string; email: string; subjects: string[]; inactive_subjects?: string[] | null; profile_approved?: boolean; slots: number; open_slots: number; created_at: string; banned_at?: string | null; photo_url?: string | null; }
interface Slot {
  id: string; subject: string; grade: number | null; grade_min?: number | null; grade_max?: number | null; day_of_week: string; start_time: string; end_time: string;
  status: string; timezone: string; notes: string;
  booked_student?: string | null; booked_note?: string | null; booked_by?: string | null; session_type?: string | null; is_custom?: boolean;
}

const SESSION_TYPE_META: Record<string, [string, string, string]> = { demo: ['Demo', '#ede9fe', '#6d28d9'], recurring: ['Recurring', '#bfdbfe', '#1d4ed8'], makeup: ['Make-Up / On Demand', '#fef3c7', '#92400e'] };
function stBadge(t?: string | null) { const m = t ? SESSION_TYPE_META[t] : null; return m ? <span style={{ marginLeft: 6, display: 'inline-block', padding: '1px 8px', borderRadius: 999, background: m[1], color: m[2], fontSize: 10.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', verticalAlign: 'middle' }}>{m[0]}</span> : null; }

interface Req {
  id: string; num_classes: number; parent_name: string; parent_email: string; parent_phone: string | null;
  student_name: string | null; notes: string | null; status: string; teacher_status: string; teacher_decided_at: string | null;
  created_at: string; slots: Array<{ slot_id: string; teacher_id: string; teacher_name: string; day_of_week: string; start_time: string; end_time: string; outcome: string }>;
}

const DAY_ABBR: Record<string, string> = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const miniLink: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--brand,#2f6fd0)', fontWeight: 700, fontSize: 12, cursor: 'pointer', padding: 0 };
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
function tzLabel(z: string) { return (({ EST: 'ET', PST: 'PT', CST: 'CT', MST: 'MT', IST: 'IST' } as Record<string, string>)[z]) || z || ''; }
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
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 640);
  useEffect(() => { const on = () => setIsMobile(window.innerWidth <= 640); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  const [slots, setSlots] = useState<Record<string, Slot[]>>({});
  const [slotErr, setSlotErr] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [savingSlot, setSavingSlot] = useState<string | null>(null);
  const [popSlot, setPopSlot] = useState<string | null>(null);
  const [comboSel, setComboSel] = useState<Record<string, string>>({});
  const [pStudent, setPStudent] = useState('');
  const [pNote, setPNote] = useState('');
  const [pErr, setPErr] = useState('');
  const [ubScope, setUbScope] = useState<'slot' | 'child'>('slot');
  const [ubEnd, setUbEnd] = useState(false);
  const [ubEndMode, setUbEndMode] = useState<'date' | 'count'>('date');
  const [ubDate, setUbDate] = useState('');
  const [ubCount, setUbCount] = useState('');
  const [occDates, setOccDates] = useState<string[]>([]);
  const [pType, setPType] = useState<'demo' | 'recurring' | 'makeup'>('recurring');
  const [createCell, setCreateCell] = useState<{ teacherId: string; day: string; start: string; end: string } | null>(null);
  const [cStatus, setCStatus] = useState<'available' | 'booked'>('available');
  const [cStudent, setCStudent] = useState('');
  const [cNote, setCNote] = useState('');
  const [cType, setCType] = useState<'demo' | 'recurring' | 'makeup'>('recurring');
  const [cErr, setCErr] = useState('');
  const [cSaving, setCSaving] = useState(false);
  const openCreate = (teacherId: string, day: string, range: string) => {
    const parts = range.split('\u2013'); const start = parts[0]; const end = parts[1] || parts[0];
    setCreateCell({ teacherId, day, start, end });
    setCStatus('available'); setCStudent(''); setCNote(''); setCType('recurring'); setCErr('');
  };
  const doCreate = async () => {
    if (!createCell) return;
    if (cStatus === 'booked' && !cStudent.trim()) { setCErr('Student name is required to book.'); return; }
    setCSaving(true); setCErr('');
    try {
      // Subject & grade are inherited from the teacher's profile by the gateway.
      await api.teacherCreateSlot({
        teacher_id: createCell.teacherId, day_of_week: createCell.day, start_time: createCell.start, end_time: createCell.end,
        status: cStatus,
        ...(cStatus === 'booked' ? { student: cStudent.trim(), note: cNote.trim() || undefined, session_type: cType } : {}),
      });
      const r = await api.teacherSlots(createCell.teacherId); setSlots(sx => ({ ...sx, [createCell.teacherId]: r.slots || [] }));
      setCreateCell(null);
    } catch (e) { setCErr((e as Error).message || 'Could not create slot'); }
    finally { setCSaving(false); }
  };
  const [allReqs, setAllReqs] = useState<Req[] | null>(null);
  const [actingReq, setActingReq] = useState<string | null>(null);
  const [reqPick, setReqPick] = useState<Record<string, Set<string>>>({});
  const [fSubject, setFSubject] = useState('');
  const [fGrade, setFGrade] = useState('');
  const [links, setLinks] = useState<any[]>([]);
  const [copied, setCopied] = useState(false);
  const [creatingLink, setCreatingLink] = useState(false);
  const [linkErr, setLinkErr] = useState('');
  const studentRef = useRef<HTMLInputElement>(null);
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');

  const load = (q: string) => { setErr(''); api.teacherTeachers(q).then(r => setRows(r.teachers || [])).catch(e => setErr((e as Error).message || 'Failed to load')); };
  const [acting, setActing] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [epName, setEpName] = useState('');
  const [epSubs, setEpSubs] = useState<{ subject: string; grades: number[] }[]>([]);
  const [epNewSub, setEpNewSub] = useState('');
  const [epPw, setEpPw] = useState('');
  const [epSaving, setEpSaving] = useState(false);
  const [epErr, setEpErr] = useState('');
  const openEditProfile = (d: TeacherRow) => { setEditId(d.id); setEpName(d.name || ''); setEpSubs(groupSubjects(d.subjects)); setEpNewSub(''); setEpPw(''); setEpErr(''); setEpSaving(false); };
  const epToggleGrade = (si: number, g: number) => setEpSubs(prev => prev.map((row, i) => i !== si ? row : ({ ...row, grades: row.grades.includes(g) ? row.grades.filter(x => x !== g) : [...row.grades, g].sort((a, b) => a - b) })));
  const epRemoveSub = (si: number) => setEpSubs(prev => prev.filter((_, i) => i !== si));
  const epAddSub = () => { const nm = epNewSub.trim(); if (!nm) return; if (epSubs.some(r => r.subject.toLowerCase() === nm.toLowerCase())) { setEpNewSub(''); return; } setEpSubs(prev => [...prev, { subject: nm, grades: [] }]); setEpNewSub(''); };
  const epSerialize = () => { const out: string[] = []; epSubs.forEach(r => { if (r.grades.length) r.grades.forEach(g => out.push(`${r.subject} (Grade ${g})`)); else out.push(r.subject); }); return out; };
  const saveEditProfile = async () => {
    if (!editId) return;
    const nm = epName.trim();
    if (!nm) { setEpErr('Name cannot be empty.'); return; }
    const pw = epPw.trim();
    if (pw && pw.length < 8) { setEpErr('New password must be at least 8 characters.'); return; }
    setEpSaving(true); setEpErr('');
    try {
      await api.teacherEditProfile(editId, { name: nm, subjects: epSerialize() });
      if (pw) await api.teacherResetPassword(editId, pw);
      setEditId(null); load(search);
    } catch (e) { setEpErr((e as Error).message || 'Could not save'); }
    finally { setEpSaving(false); }
  };
  const banTeacher = async (t: TeacherRow, banned: boolean) => {
    setActing(true); setErr('');
    try { await api.teacherSetBan(t.id, banned); load(search); } catch (e) { setErr((e as Error).message); } finally { setActing(false); }
  };
  const deleteTeacher = async (t: TeacherRow) => {
    const typed = window.prompt(`Permanently delete ${t.name}? This removes their account, availability, sessions and training progress. This cannot be undone.\n\nType the teacher's name to confirm:`);
    if (typed == null) return;
    if (typed.trim().toLowerCase() !== (t.name || '').trim().toLowerCase()) { window.alert(`Name did not match \u2014 nothing was deleted. Type exactly: ${t.name}`); return; }
    setActing(true); setErr('');
    try { await api.teacherDeleteTeacher(t.id); setSelected(null); await load(search); window.alert(`${t.name}'s account has been deleted.`); }
    catch (e) { const m = (e as Error).message || 'Unknown error'; setErr(m); window.alert('Could not delete this teacher: ' + m); }
    finally { setActing(false); }
  };
  const setApproval = async (t: TeacherRow, approved: boolean) => {
    if (!approved && !window.confirm(`Unapprove ${t.name}'s profile? They stop being bookable until re-approved.`)) return;
    setActing(true);
    try { await api.teacherSetApproval(t.id, approved); load(search); } catch (e) { setErr((e as Error).message); } finally { setActing(false); }
  };
  const toggleCapability = async (t: TeacherRow, subject: string, active: boolean) => {
    try { await api.teacherSetCapability(t.id, subject, active); load(search); } catch (e) { setErr((e as Error).message); }
  };
  const loadReqs = () => { api.teacherBookingRequests({ status: 'all' }).then(r => setAllReqs((r.requests || []) as Req[])).catch(() => setAllReqs([])); };
  useEffect(() => { load(''); loadReqs(); }, []);
  useEffect(() => { api.teacherBookingLinks().then(r => setLinks(r.links || [])).catch(() => {}); }, []);
  const createTeacherLink = async (teacherId: string) => {
    setCreatingLink(true); setLinkErr('');
    try {
      const link = await api.teacherCreateBookingLink({ teacher_ids: [teacherId], never_expires: true });
      setLinks(ls => [link, ...ls]);
    } catch (e) { setLinkErr((e as Error).message || 'Could not create booking link'); }
    finally { setCreatingLink(false); }
  };

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

  const openPopover = (slotId: string) => { setPopSlot(slotId); setPStudent(''); setPNote(''); setPErr(''); setPType('recurring'); setTimeout(() => studentRef.current?.focus(), 0); };
  useEffect(() => {
    setUbScope('slot'); setUbEnd(false); setUbEndMode('date'); setUbDate(''); setUbCount(''); setOccDates([]);
    if (!popSlot) return;
    let sl: Slot | undefined;
    for (const arr of Object.values(slots)) { const f = arr.find(x => x.id === popSlot); if (f) { sl = f; break; } }
    if (sl && sl.status === 'booked' && (sl.session_type || 'recurring') === 'recurring') {
      api.teacherSlotOccurrences(popSlot).then(r => {
        const occ = r.occurrences || []; setOccDates(occ);
        if (occ.length) setUbDate(occ[Math.min(2, occ.length - 1)]);
      }).catch(() => setOccDates([]));
    }
  }, [popSlot]);
  const doUnbook = async (teacherId: string, slot: Slot) => {
    const recurring = (slot.session_type || 'recurring') === 'recurring';
    const body: { scope?: 'slot' | 'child'; mode?: 'now' | 'end'; end_mode?: 'date' | 'count'; end_date?: string; end_count?: number } = {};
    if (recurring) {
      body.scope = ubScope;
      if (ubEnd) {
        body.mode = 'end'; body.end_mode = ubEndMode;
        if (ubEndMode === 'date') { if (!ubDate) { setSlotErr(m => ({ ...m, [teacherId]: 'Pick an end date.' })); return; } body.end_date = ubDate; }
        else { const n = parseInt(ubCount, 10); if (!n || n < 1) { setSlotErr(m => ({ ...m, [teacherId]: 'Enter a valid number.' })); return; } body.end_count = n; }
      } else { body.mode = 'now'; }
    }
    setSavingSlot(slot.id);
    try {
      await api.teacherUnbookSlot(slot.id, body);
      const r = await api.teacherSlots(teacherId); setSlots(sx => ({ ...sx, [teacherId]: r.slots || [] }));
      setPopSlot(null);
    } catch (e) { setSlotErr(m => ({ ...m, [teacherId]: (e as Error).message || 'Could not unbook' })); }
    finally { setSavingSlot(null); }
  };
  const patchLocal = (teacherId: string, slotId: string, next: Partial<Slot>) =>
    setSlots(m => ({ ...m, [teacherId]: (m[teacherId] || []).map(x => x.id === slotId ? { ...x, ...next } : x) }));

  const book = async (teacherId: string, slot: Slot) => {
    if (!pStudent.trim()) { setPErr('Student name is required.'); studentRef.current?.focus(); return; }
    setSavingSlot(slot.id); setPErr('');
    try {
      const u = await api.teacherSetSlotStatus(slot.id, 'booked', { student: pStudent.trim(), note: pNote.trim(), session_type: pType });
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
  const setUnavailable = async (teacherId: string, slot: Slot) => {
    if (slot.status === 'booked' && slot.booked_student && slot.booked_student.trim() && !window.confirm(`This slot is booked for ${slot.booked_student}. Making it unavailable removes that booking. Continue?`)) return;
    setSavingSlot(slot.id);
    try {
      await api.teacherSetSlotStatus(slot.id, 'unavailable');
      patchLocal(teacherId, slot.id, { status: 'unavailable', booked_student: null, booked_note: null, booked_by: null });
      setPopSlot(null);
    } catch (e) { setSlotErr(m => ({ ...m, [teacherId]: (e as Error).message || 'Could not update slot' })); }
    finally { setSavingSlot(null); }
  };
  const deleteSlot = async (teacherId: string, slot: Slot) => {
    if (!window.confirm(`Delete this slot (${slot.day_of_week} ${slot.start_time}\u2013${slot.end_time})? This cannot be undone.`)) return;
    setSavingSlot(slot.id);
    try {
      await api.teacherDeleteSlot(slot.id);
      setSlots(m => ({ ...m, [teacherId]: (m[teacherId] || []).filter(x => x.id !== slot.id) }));
      setPopSlot(null);
    } catch (e) { setSlotErr(m => ({ ...m, [teacherId]: (e as Error).message || 'Could not delete slot' })); }
    finally { setSavingSlot(null); }
  };

  // Per-request slot selection (toggle which accepted slots to book; the rest are declined).
  const pickFor = (reqId: string, mineIds: string[]) => reqPick[reqId] ?? new Set(mineIds);
  const toggleReqSlot = (reqId: string, sid: string, mineIds: string[]) => setReqPick(prev => {
    const cur = prev[reqId] ? new Set(prev[reqId]) : new Set(mineIds);
    if (cur.has(sid)) cur.delete(sid); else cur.add(sid);
    return { ...prev, [reqId]: cur };
  });
  const setAllReqSlots = (reqId: string, mineIds: string[], on: boolean) => setReqPick(prev => ({ ...prev, [reqId]: on ? new Set(mineIds) : new Set<string>() }));

  // Admin books the selected slots the teacher accepted (child name comes from the request).
  const bookReq = async (teacherId: string, reqId: string, selectedIds?: string[], total?: number) => {
    setActingReq(reqId);
    const partial = !!(selectedIds && total && selectedIds.length < total);
    try { await api.teacherApproveRequest(reqId, partial ? selectedIds : undefined); const r = await api.teacherSlots(teacherId); setSlots(s => ({ ...s, [teacherId]: r.slots || [] })); loadReqs(); }
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
  // Profile photo when the teacher uploaded one (ta_teachers.photo_url), else the gradient initials avatar.
  const avatar = (t: TeacherRow, size: number, fontSize: number, gradIdx: number) => {
    const p = (t.photo_url || '').trim();
    if (p) return <img src={p} alt={t.name} title={t.name} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flex: 'none', background: '#e6ecf5' }} />;
    return <span className={'cm-av ' + GRADS[gradIdx % GRADS.length]} style={{ width: size, height: size, borderRadius: '50%', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize, flex: 'none' }}>{initials(t.name)}</span>;
  };
  const inp = { padding: '7px 9px', border: '1px solid var(--line,#d7dce8)', borderRadius: 8, background: 'var(--card2,#f7f9fc)', color: 'inherit', width: '100%' } as React.CSSProperties;

  const slotById = (id: string, sid: string) => (slots[id] || []).find(x => x.id === sid) || null;
  const renderPopover = (id: string) => {
    if (!popSlot) return null;
    const s = slotById(id, popSlot);
    if (!s) return null;
    const hasStudent = s.status === 'booked' && !!(s.booked_student && s.booked_student.trim());
    const isAvail = s.status === 'available';
    const slotBtn: React.CSSProperties = { flex: '1 1 40%', fontWeight: 800, padding: '7px', borderRadius: 8, border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'inherit', cursor: 'pointer' };
    return (
      <>
        <button aria-label="Close" onClick={() => setPopSlot(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(12,22,40,.28)', border: 0, zIndex: 40, cursor: 'default' }} />
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 50, width: 300, maxWidth: '92vw', background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, boxShadow: '0 20px 50px rgba(10,28,56,.32)', padding: 14, display: 'grid', gap: 8 }}>
          <button aria-label="Close" onClick={() => setPopSlot(null)} style={{ position: 'absolute', top: 10, right: 10, width: 26, height: 26, borderRadius: '50%', border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'var(--muted,#5c7080)', cursor: 'pointer', fontWeight: 800, lineHeight: 1 }}>✕</button>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint,#93a6b3)', paddingRight: 26 }}>{DAY_ABBR[s.day_of_week] || s.day_of_week} · {s.start_time}–{s.end_time} · {s.subject}</div>
          {hasStudent && <div style={{ fontSize: 13 }}>Booked for <b>{s.booked_student}</b>{stBadge(s.session_type)}{s.is_custom ? <span style={{ marginLeft: 6, display: 'inline-block', padding: '1px 8px', borderRadius: 999, background: '#f3e8ff', color: '#6b21a8', border: '1px solid #d8b4fe', fontSize: 10.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', verticalAlign: 'middle' }}>✎ Custom</span> : null}{s.booked_by ? <span className="muted"> · by {s.booked_by}</span> : null}</div>}
          {hasStudent && s.booked_note && <div className="muted" style={{ fontSize: 12 }}>📝 {s.booked_note}</div>}
          {hasStudent && (s.session_type || 'recurring') === 'recurring' && (() => {
            const segBtn = (on: boolean): React.CSSProperties => ({ flex: 1, border: 0, padding: '9px 8px', fontWeight: 800, fontSize: 12.5, cursor: 'pointer', background: on ? 'var(--navy,#122a52)' : 'var(--card,#fff)', color: on ? '#fff' : 'var(--muted,#44546f)' });
            return <div style={{ border: '1px solid var(--line,#e6e6ef)', borderRadius: 10, padding: 10, display: 'grid', gap: 9, background: 'var(--card2,#f7f9fc)' }}>
              <div style={{ fontSize: 10.5, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--faint,#93a6b3)' }}>Unbook scope</div>
              <div style={{ display: 'flex', border: '1.5px solid var(--line,#d7dce8)', borderRadius: 9, overflow: 'hidden' }}>
                <button onClick={() => setUbScope('slot')} style={segBtn(ubScope === 'slot')}>This slot</button>
                <button onClick={() => setUbScope('child')} style={segBtn(ubScope === 'child')}>All of {s.booked_student}'s slots</button>
              </div>
              <button onClick={() => setUbEnd(!ubEnd)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: '1px solid var(--line,#e6e6ef)', borderRadius: 9, padding: '9px 11px', fontSize: 12.5, fontWeight: 700, color: 'var(--muted,#44546f)', background: ubEnd ? '#eef7f3' : 'var(--card,#fff)', cursor: 'pointer' }}>
                <span>End the series instead of now</span>
                <span style={{ width: 38, height: 22, borderRadius: 999, background: ubEnd ? 'var(--teal,#0f766e)' : '#cbd5e6', position: 'relative', flex: 'none' }}><span style={{ position: 'absolute', top: 2, left: ubEnd ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: '.15s' }} /></span>
              </button>
              {ubEnd && <div style={{ display: 'grid', gap: 7 }}>
                <div style={{ display: 'flex', gap: 14, fontSize: 12.5, fontWeight: 700 }}>
                  <label style={{ display: 'inline-flex', gap: 6, cursor: 'pointer' }}><input type="radio" checked={ubEndMode === 'date'} onChange={() => setUbEndMode('date')} />On date</label>
                  <label style={{ display: 'inline-flex', gap: 6, cursor: 'pointer' }}><input type="radio" checked={ubEndMode === 'count'} onChange={() => setUbEndMode('count')} />After total occurrences</label>
                </div>
                {ubEndMode === 'date'
                  ? <select value={ubDate} onChange={e => setUbDate(e.target.value)} style={inp}>{occDates.map(d => <option key={d} value={d}>{d}</option>)}</select>
                  : <input type="number" min={1} value={ubCount} onChange={e => setUbCount(e.target.value)} placeholder="Enter number" style={inp} />}
              </div>}
            </div>;
          })()}
          {isAvail && <>
            <input ref={studentRef} value={pStudent} onChange={e => setPStudent(e.target.value)} placeholder="Student name" autoComplete="off" style={inp}
              onKeyDown={e => { if (e.key === 'Enter') book(id, s); if (e.key === 'Escape') setPopSlot(null); }} />
            <input value={pNote} onChange={e => setPNote(e.target.value)} placeholder="Note (optional)" style={inp}
              onKeyDown={e => { if (e.key === 'Enter') book(id, s); if (e.key === 'Escape') setPopSlot(null); }} />
            <select value={pType} onChange={e => setPType(e.target.value as 'demo' | 'recurring' | 'makeup')} style={inp}>
              <option value="recurring">Recurring</option><option value="makeup">Make-Up / On Demand</option><option value="demo">Demo</option>
            </select>
            {pErr && <div style={{ color: 'var(--coral,#c0392b)', fontSize: 12 }}>{pErr}</div>}
          </>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {isAvail && <button onClick={() => book(id, s)} disabled={savingSlot === s.id} style={{ flex: '1 1 100%', fontWeight: 800, padding: '7px', borderRadius: 8, border: 0, background: 'var(--teal,#0f766e)', color: '#fff', cursor: 'pointer', opacity: savingSlot === s.id ? .6 : 1 }}>{savingSlot === s.id ? 'Booking…' : 'Book'}</button>}
            {!isAvail && <button onClick={() => (hasStudent ? doUnbook(id, s) : unbook(id, s))} disabled={savingSlot === s.id} style={{ ...slotBtn, flex: '1 1 100%', background: hasStudent ? 'var(--teal,#0f766e)' : 'var(--card,#fff)', color: hasStudent ? '#fff' : 'inherit', border: hasStudent ? 0 : '1px solid var(--line,#d7dce8)', opacity: savingSlot === s.id ? .6 : 1 }}>{savingSlot === s.id ? 'Working…' : (hasStudent ? (ubEnd ? 'End series' : 'Unbook') : 'Make available')}</button>}
            {s.status !== 'unavailable' && <button onClick={() => setUnavailable(id, s)} disabled={savingSlot === s.id} style={{ ...slotBtn, color: 'var(--amber,#b45309)', opacity: savingSlot === s.id ? .6 : 1 }}>Make unavailable</button>}
            <button onClick={() => deleteSlot(id, s)} disabled={savingSlot === s.id} style={{ ...slotBtn, color: 'var(--coral,#c0392b)', opacity: savingSlot === s.id ? .6 : 1 }}>Delete</button>
          </div>
        </div>
      </>
    );
  };
  const renderCreate = () => {
    if (!createCell) return null;
    return (
      <>
        <button aria-label="Close" onClick={() => setCreateCell(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(12,22,40,.28)', border: 0, zIndex: 40, cursor: 'default' }} />
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 50, width: 320, maxWidth: '92vw', background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, boxShadow: '0 20px 50px rgba(10,28,56,.32)', padding: 14, display: 'grid', gap: 8 }}>
          <button aria-label="Close" onClick={() => setCreateCell(null)} style={{ position: 'absolute', top: 10, right: 10, width: 26, height: 26, borderRadius: '50%', border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'var(--muted,#5c7080)', cursor: 'pointer', fontWeight: 800, lineHeight: 1 }}>✕</button>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint,#93a6b3)', paddingRight: 26 }}>New slot · {DAY_ABBR[createCell.day] || createCell.day} · {createCell.start}–{createCell.end}</div>
          {cStatus === 'booked' && <div style={{ fontSize: 11.5, color: 'var(--muted,#64748b)' }}>Subject &amp; grade follow the teacher's profile.</div>}
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setCStatus('available')} style={{ flex: 1, fontWeight: 800, padding: '7px', borderRadius: 8, border: '1px solid var(--line,#d7dce8)', background: cStatus === 'available' ? '#e6f7f2' : 'var(--card,#fff)', color: cStatus === 'available' ? '#0f766e' : 'inherit', cursor: 'pointer' }}>Available</button>
            <button onClick={() => setCStatus('booked')} style={{ flex: 1, fontWeight: 800, padding: '7px', borderRadius: 8, border: '1px solid var(--line,#d7dce8)', background: cStatus === 'booked' ? '#fbeeda' : 'var(--card,#fff)', color: cStatus === 'booked' ? '#b45309' : 'inherit', cursor: 'pointer' }}>Booked</button>
          </div>
          {cStatus === 'booked' && <>
            <input value={cStudent} onChange={e => setCStudent(e.target.value)} placeholder="Student name" style={inp} />
            <input value={cNote} onChange={e => setCNote(e.target.value)} placeholder="Note (optional)" style={inp} />
            <select value={cType} onChange={e => setCType(e.target.value as 'demo' | 'recurring' | 'makeup')} style={inp}><option value="recurring">Recurring</option><option value="makeup">Make-Up / On Demand</option><option value="demo">Demo</option></select>
          </>}
          {cErr && <div style={{ color: 'var(--coral,#c0392b)', fontSize: 12 }}>{cErr}</div>}
          <button onClick={doCreate} disabled={cSaving} style={{ fontWeight: 800, padding: '8px', borderRadius: 8, border: 0, background: 'var(--teal,#0f766e)', color: '#fff', cursor: 'pointer', opacity: cSaving ? .6 : 1 }}>{cSaving ? 'Creating\u2026' : 'Create slot'}</button>
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
        <div className="cm-wg-wrap cm-wg-desk">
          <table className="cm-wg">
            <thead><tr><th></th>{WEEK_FULL.map(d => <th key={d}>{DAY_ABBR[d]}</th>)}</tr></thead>
            <tbody>
              {rowKeys.map(rk => (
                <tr key={rk}>
                  <td className="cm-wg-tl">{rowMap.get(rk)!.label}{tz ? <span className="cm-wg-tz"> {tzLabel(tz)}</span> : null}</td>
                  {WEEK_FULL.map(d => {
                    const s = cell[d + '|' + rk];
                    if (!s) return <td key={d}><div className="cm-wg-empty" onClick={canManage ? () => openCreate(id, d, rk) : undefined} title={canManage ? 'Add a slot here' : undefined} style={{ cursor: canManage ? 'pointer' : 'default' }}>{canManage ? '+' : '·'}</div></td>;
                    const hasStudent = s.status === 'booked' && !!(s.booked_student && s.booked_student.trim());
                    const cls = hasStudent ? ('bk bk-' + (s.session_type === 'makeup' ? 'mku' : s.session_type === 'demo' ? 'dem' : 'rec')) : s.status === 'available' ? 'av' : 'un';
                    const lab = hasStudent ? 'Booked' : s.status === 'available' ? 'Available' : 'Unavailable';
                    return (
                      <td key={d}>
                        <div className={'cm-wg-cell ' + cls} onClick={canManage ? () => openPopover(s.id) : undefined} title={s.subject + (gradeShort(s) ? ' · ' + gradeShort(s) : '') + (s.is_custom ? ' · Custom time' : '')} style={{ cursor: canManage ? 'pointer' : 'default', position: 'relative' }}>
                          {s.is_custom && hasStudent && <span title="Custom time" style={{ position: 'absolute', top: 2, right: 4, fontSize: 9, fontWeight: 800, color: '#6b21a8' }}>✎</span>}
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
        <div className="cm-wg-stack">
          {WEEK_FULL.map(d => {
            const daySlots = rowKeys.map(rk => cell[d + '|' + rk]).filter(Boolean) as Slot[];
            if (daySlots.length === 0) return null;
            return (
              <details key={d} className="cm-wg-day" open={WEEK_FULL.filter(dd => rowKeys.some(rk => cell[dd + '|' + rk])).indexOf(d) === 0}>
                <summary><span>{d}</span><span className="cm-wg-daycnt">{daySlots.length} slot{daySlots.length > 1 ? 's' : ''} ›</span></summary>
                {daySlots.map(s2 => {
                  const hasStudent = s2.status === 'booked' && !!(s2.booked_student && s2.booked_student.trim());
                  const cls = hasStudent ? ('bk bk-' + (s2.session_type === 'makeup' ? 'mku' : s2.session_type === 'demo' ? 'dem' : 'rec')) : s2.status === 'available' ? 'av' : 'un';
                  const lab = hasStudent ? 'Booked' : s2.status === 'available' ? 'Available' : 'Unavailable';
                  return (
                    <button key={s2.id} className="cm-wg-srow" onClick={canManage ? () => openPopover(s2.id) : undefined} style={{ cursor: canManage ? 'pointer' : 'default' }}>
                      <span className="cm-wg-stime">{s2.start_time}–{s2.end_time}</span>
                      <span className={'cm-wg-chip ' + cls}>{lab}{hasStudent ? ' · ' + s2.booked_student : ''}</span>
                    </button>
                  );
                })}
              </details>
            );
          })}
        </div>
        <div className="cm-wg-legend"><span className="cm-wg-sw av" /> Available<span className="cm-wg-sw bk-rec" /> Recurring<span className="cm-wg-sw bk-dem" /> Demo<span className="cm-wg-sw bk-mku" /> Make-Up / On Demand<span className="cm-wg-sw un" /> Unavailable<span style={{ flex: 1 }} />{tz ? 'Times in ' + tzLabel(tz) : ''}</div>
        {renderPopover(id)}
        {renderCreate()}
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
          const canAct = !terminal && canManage && r.teacher_status !== 'declined';
          const mine = (r.slots || []).filter(s => s.teacher_id === id);
          const mineIds = mine.map(s => s.slot_id);
          const picked = pickFor(r.id, mineIds);
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
                {mine.map(s => { const on = picked.has(s.slot_id); return canAct
                  ? <button key={s.slot_id} onClick={() => toggleReqSlot(r.id, s.slot_id, mineIds)} style={{ fontSize: 11, fontWeight: 800, borderRadius: 8, padding: '4px 9px', cursor: 'pointer', border: '1px solid ' + (on ? 'var(--good,#0f9d6b)' : 'var(--coral,#c0392b)'), background: on ? 'var(--good-soft,#dcf5ea)' : 'var(--coral-soft,#fdecea)', color: on ? 'var(--good,#0f766e)' : 'var(--coral,#c0392b)', textDecoration: on ? 'none' : 'line-through' }}>{on ? '✓ ' : '✕ '}{DAY_ABBR[s.day_of_week] || s.day_of_week} {s.start_time}–{s.end_time}</button>
                  : <span key={s.slot_id} style={{ fontSize: 11, fontWeight: 700, background: 'var(--card2,#f2f5fa)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 8, padding: '3px 8px' }}>{DAY_ABBR[s.day_of_week] || s.day_of_week} {s.start_time}–{s.end_time}{s.outcome && s.outcome !== 'pending' ? ' · ' + s.outcome : ''}</span>;
                })}
              </div>
              {canAct && <div style={{ display: 'flex', gap: 12, marginTop: 6 }}><button onClick={() => setAllReqSlots(r.id, mineIds, true)} style={miniLink}>Select all</button><button onClick={() => rejectReq(r.id)} style={{ ...miniLink, color: 'var(--coral,#c0392b)' }}>Reject all</button></div>}
              {r.notes && <div className="muted" style={{ fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap' }}>{r.notes}</div>}
              {canManage && !terminal && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  {canAct ? <>
                    <span className="muted" style={{ fontSize: 12, marginRight: 'auto' }}><b style={{ color: 'var(--good,#0f9d6b)' }}>{picked.size}</b> accepted · <b style={{ color: 'var(--coral,#c0392b)' }}>{mineIds.length - picked.size}</b> rejected</span>
                    {picked.size > 0
                      ? <button onClick={() => bookReq(id, r.id, [...picked], mineIds.length)} disabled={actingReq === r.id} style={{ fontWeight: 800, fontSize: 12.5, borderRadius: 8, padding: '7px 14px', border: 0, background: 'var(--teal,#0f766e)', color: '#fff', cursor: 'pointer', opacity: actingReq === r.id ? .6 : 1 }}>{actingReq === r.id ? 'Booking…' : `Book ${picked.size === mineIds.length ? 'slots' : picked.size + ' slot(s)'}`}</button>
                      : <button onClick={() => rejectReq(r.id)} disabled={actingReq === r.id} style={{ fontWeight: 800, fontSize: 12.5, borderRadius: 8, padding: '7px 14px', border: 0, background: 'var(--coral,#c0392b)', color: '#fff', cursor: 'pointer', opacity: actingReq === r.id ? .6 : 1 }}>Reject request</button>}
                  </> : <>
                    <span className="muted" style={{ fontSize: 12, marginRight: 'auto' }}>Teacher declined this request.</span>
                    <button onClick={() => rejectReq(r.id)} disabled={actingReq === r.id} style={{ fontWeight: 700, fontSize: 12.5, borderRadius: 8, padding: '7px 12px', border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'var(--coral,#c0392b)', cursor: 'pointer' }}>Close request</button>
                  </>}
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
  const renderDetail = (d: TeacherRow) => (
    <div style={{ display: 'grid', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  {avatar(d, 44, 15, filteredRows.findIndex(t => t.id === d.id))}
                  <div><div style={{ fontWeight: 800, fontSize: 17 }}>{d.name}</div><div className="muted" style={{ fontSize: 12 }}>{d.email}</div></div>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {reqBadge(d.id) > 0 && <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--amber,#b45309)' }}>{reqBadge(d.id)} ready to book</span>}
                    {d.banned_at && <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--coral,#c0392b)', background: 'var(--coral-soft,#fdece9)', borderRadius: 999, padding: '2px 10px' }}>Banned</span>}
                    {d.profile_approved === false && <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--amber,#b45309)', background: 'var(--amber-soft,#fbeeda)', borderRadius: 999, padding: '2px 10px' }}>Unapproved</span>}
                    {canManage && <button onClick={() => openEditProfile(d)} disabled={acting} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--brand,#2563eb)', background: 'var(--card,#fff)', cursor: 'pointer', fontWeight: 700, fontSize: 12.5, color: 'var(--brand,#2563eb)', opacity: acting ? 0.6 : 1 }}>✎ Edit profile</button>}
                    {canManage && <button onClick={() => setApproval(d, d.profile_approved === false)} disabled={acting} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', cursor: 'pointer', fontWeight: 700, fontSize: 12.5, color: 'var(--amber,#b45309)', opacity: acting ? 0.6 : 1 }}>{d.profile_approved === false ? 'Approve' : 'Unapprove'}</button>}
                    {canManage && <button onClick={() => banTeacher(d, !d.banned_at)} disabled={acting} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', cursor: 'pointer', fontWeight: 700, fontSize: 12.5, color: 'var(--amber,#b45309)', opacity: acting ? 0.6 : 1 }}>{d.banned_at ? 'Unban' : 'Ban'}</button>}
                    {canManage && <button onClick={() => deleteTeacher(d)} disabled={acting} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', cursor: 'pointer', fontWeight: 700, fontSize: 12.5, color: 'var(--coral,#c0392b)', opacity: acting ? 0.6 : 1 }}>Delete</button>}
                  </div>
                </div>

                <div>
                  <h4 style={{ margin: '0 0 8px', fontSize: 12, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#64748b)' }}>Teaches</h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {groupSubjects(d.subjects).map(g => { const c = comboColor(g.subject, 'all'); const inactive = (d.inactive_subjects || []).includes(g.subject); return (
                      <span key={g.subject} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 700, padding: '3px 4px 3px 10px', borderRadius: 8, background: c.bg, color: c.tx, border: '1px solid ' + c.bd, opacity: inactive ? 0.55 : 1 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.tx }} />{g.subject}{g.grades.length ? <span style={{ fontWeight: 800 }}>{' · ' + compressGrades(g.grades)}</span> : null}
                        {canManage && <button onClick={() => toggleCapability(d, g.subject, inactive)} title={inactive ? 'Activate' : 'Deactivate'} style={{ fontSize: 10, fontWeight: 800, borderRadius: 999, padding: '2px 8px', cursor: 'pointer', border: '1px solid ' + (inactive ? '#f3c9c4' : '#bfe8d4'), background: inactive ? '#fdecea' : '#eafbf1', color: inactive ? '#c0392b' : '#0e7a52' }}>{inactive ? 'Inactive' : 'Active ✓'}</button>}
                      </span>
                    ); })}
                    {groupSubjects(d.subjects).length === 0 && <span className="muted" style={{ fontSize: 12 }}>No subjects listed.</span>}
                  </div>
                </div>

                <div>
                  <h4 style={{ margin: '0 0 6px', fontSize: 12, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#64748b)' }}>Booking link</h4>
                  {teacherLink ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'var(--card2,#f2f5fa)', border: '1px solid var(--line,#e6e9f0)', borderRadius: 8, padding: '6px 8px' }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: teacherLink.url ? 'inherit' : 'var(--muted,#8a93a3)' }}>{teacherLink.url || ('/b/' + teacherLink.token)}</span>
                      <button onClick={() => copyLink(teacherLink.url || ('/b/' + teacherLink.token))} title="Copy link" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', borderRadius: 6, padding: '4px 8px', color: copied ? 'var(--good,#0f9d6b)' : 'inherit', fontWeight: 700, fontSize: 12 }}>{copied ? 'Copied' : 'Copy'}</button>
                    </div>
                  ) : (
                    <div>
                      <button onClick={() => selected && createTeacherLink(selected)} disabled={creatingLink || !canManage} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: creatingLink || !canManage ? 'default' : 'pointer', border: '1px solid var(--teal,#0f766e)', background: 'var(--teal,#0f766e)', color: '#fff', borderRadius: 8, padding: '7px 12px', fontWeight: 800, fontSize: 12.5, opacity: creatingLink || !canManage ? .6 : 1 }}>{creatingLink ? 'Creating…' : '+ Create booking link'}</button>
                      <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>No active booking link. Creates a never-expiring link for this teacher.</div>
                      {linkErr && <div style={{ color: 'var(--coral,#c0392b)', fontSize: 12, marginTop: 5 }}>{linkErr}</div>}
                    </div>
                  )}
                </div>

                <div>
                  <h4 style={{ margin: '0 0 4px', fontSize: 12, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#64748b)' }}>Availability</h4>
                  {renderSlots(d.id)}
                </div>

                <div>
                  <h4 style={{ margin: '0 0 8px', fontSize: 12, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#64748b)' }}>Parent requests {reqBadge(d.id) > 0 && <span style={{ ...countBadge, background: 'var(--amber,#b45309)' }}>{reqBadge(d.id)}</span>}</h4>
                  {renderRequests(d.id)}
                </div>    </div>
  );


  const renderEditModal = () => {
    if (!editId) return null;
    const GR = [1,2,3,4,5,6,7,8,9,10,11,12];
    return (
      <>
        <button aria-label="Close" onClick={() => setEditId(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(12,22,40,.32)', border: 0, zIndex: 60, cursor: 'default' }} />
        <div role="dialog" aria-modal="true" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 70, width: 500, maxWidth: '94vw', maxHeight: '92vh', overflow: 'auto', background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 14, boxShadow: '0 24px 60px rgba(10,28,56,.4)', padding: 18, display: 'grid', gap: 15 }}>
          <button aria-label="Close" onClick={() => setEditId(null)} style={{ position: 'absolute', top: 12, right: 12, width: 26, height: 26, borderRadius: '50%', border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'var(--muted,#5c7080)', cursor: 'pointer', fontWeight: 800, lineHeight: 1 }}>✕</button>
          <div style={{ fontWeight: 800, fontSize: 15, paddingRight: 26 }}>Edit teacher profile</div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#64748b)', display: 'block', marginBottom: 5 }}>Full name</label>
            <input value={epName} onChange={e => setEpName(e.target.value)} maxLength={120} style={inp} />
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#64748b)', display: 'block', marginBottom: 5 }}>Subjects &amp; grades</label>
            <div style={{ border: '1px solid var(--line,#e6e9f0)', borderRadius: 10, padding: 10, display: 'grid', gap: 10 }}>
              {epSubs.map((row, si) => (
                <div key={si} style={{ borderBottom: si < epSubs.length - 1 ? '1px dashed #eef1f6' : 'none', paddingBottom: si < epSubs.length - 1 ? 9 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontWeight: 800, fontSize: 13 }}>{row.subject}</span>
                    <button onClick={() => epRemoveSub(si)} title="Remove subject" style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, border: '1px solid #f3c9c4', background: '#fdecea', color: '#c0392b', borderRadius: 7, padding: '2px 8px', cursor: 'pointer' }}>Remove</button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {GR.map(g => { const on = row.grades.includes(g); return (
                      <button key={g} onClick={() => epToggleGrade(si, g)} style={{ fontSize: 11, fontWeight: 700, borderRadius: 7, padding: '3px 9px', cursor: 'pointer', border: '1px solid ' + (on ? '#1d4ed8' : 'var(--line,#d7dce8)'), background: on ? '#1d4ed8' : 'var(--card,#fff)', color: on ? '#fff' : '#374151' }}>G{g}</button>
                    ); })}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted,#8a93a3)', marginTop: 4 }}>{row.grades.length ? '' : 'No grade selected — saved as all grades.'}</div>
                </div>
              ))}
              {epSubs.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No subjects yet.</div>}
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={epNewSub} onChange={e => setEpNewSub(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); epAddSub(); } }} placeholder="Add subject (e.g. Math)" style={{ ...inp, flex: 1 }} />
                <button onClick={epAddSub} style={{ fontWeight: 800, fontSize: 12.5, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', cursor: 'pointer' }}>+ Add</button>
              </div>
            </div>
          </div>

          <div style={{ border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 800, fontSize: 12.5, color: '#92400e', marginBottom: 7 }}>Reset password</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input value={epPw} onChange={e => setEpPw(e.target.value)} type="text" placeholder="New temporary password (leave blank to keep)" style={{ ...inp, flex: 1, minWidth: 180 }} />
            </div>
            <div style={{ fontSize: 10.5, color: '#9a7b2e', marginTop: 5 }}>Min 8 characters. The teacher can change it later from TeacherHub.</div>
          </div>

          {epErr && <div style={{ color: 'var(--coral,#c0392b)', fontSize: 12.5 }}>{epErr}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
            <button onClick={() => setEditId(null)} style={{ fontWeight: 800, fontSize: 13, padding: '9px 16px', borderRadius: 9, border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', cursor: 'pointer' }}>Cancel</button>
            <button onClick={saveEditProfile} disabled={epSaving} style={{ fontWeight: 800, fontSize: 13, padding: '9px 18px', borderRadius: 9, border: 0, background: 'var(--brand,#2563eb)', color: '#fff', cursor: 'pointer', opacity: epSaving ? .6 : 1 }}>{epSaving ? 'Saving…' : 'Save changes'}</button>
          </div>
        </div>
      </>
    );
  };

  return (
    <div>
      {renderEditModal()}
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
        .cm-wg-cell.av{border-color:#059669;background:#d1fae5;color:#065f46}
        .cm-wg-cell.bk{border-color:#b45309;color:#b45309;background:repeating-linear-gradient(45deg,#fbeeda,#fbeeda 6px,#fff6e9 6px,#fff6e9 12px)}
        .cm-wg-cell.bk-rec{border-color:#1d4ed8;color:#1d4ed8;background:repeating-linear-gradient(45deg,#dbeafe,#dbeafe 6px,#eff6ff 6px,#eff6ff 12px)}
        .cm-wg-cell.bk-dem{border-color:#6d28d9;color:#6d28d9;background:repeating-linear-gradient(45deg,#ede9fe,#ede9fe 6px,#f5f3ff 6px,#f5f3ff 12px)}
        .cm-wg-cell.bk-mku{border-color:#92400e;color:#92400e;background:repeating-linear-gradient(45deg,#fef3c7,#fef3c7 6px,#fffbeb 6px,#fffbeb 12px)}
        .cm-wg-cell.un{border-color:#cbd0d9;color:#4b5563;background:repeating-linear-gradient(45deg,#e5e7eb,#e5e7eb 6px,#f3f4f6 6px,#f3f4f6 12px)}
        .cm-wg-who{font-size:10px;font-weight:700}
        .cm-wg-empty{border:1.5px dashed var(--line,#e6e6ef);border-radius:10px;color:#c3ccda;text-align:center;padding:8px 6px;min-height:44px;display:flex;align-items:center;justify-content:center}
        .cm-wg-legend{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted,#64748b);margin-top:8px;flex-wrap:wrap}
        .cm-wg-sw{width:12px;height:12px;border-radius:3px;border:1.5px solid;display:inline-block}
        .cm-wg-sw.av{border-color:#059669;background:#d1fae5}
        .cm-wg-sw.bk{border-color:#b45309;background:#fbeeda}
        .cm-wg-sw.bk-rec{border-color:#1d4ed8;background:#bfdbfe}
        .cm-wg-sw.bk-dem{border-color:#6d28d9;background:#ede9fe}
        .cm-wg-sw.bk-mku{border-color:#92400e;background:#fef3c7}
        .cm-wg-sw.un{border-color:#cbd0d9;background:#e5e7eb}
        .cm-wg-stack{display:none}
        .cm-wg-day{border:1px solid var(--line,#e6e6ef);border-radius:12px;background:var(--card,#fff);margin-bottom:8px;overflow:hidden}
        .cm-wg-day>summary{list-style:none;cursor:pointer;padding:12px 13px;display:flex;justify-content:space-between;align-items:center;font-weight:800;font-size:14px}
        .cm-wg-day>summary::-webkit-details-marker{display:none}
        .cm-wg-daycnt{font-size:11.5px;color:var(--muted,#64748b);font-weight:700}
        .cm-wg-srow{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 13px;border:0;border-top:1px solid var(--line,#e6e6ef);background:transparent}
        .cm-wg-stime{font-size:13px;font-weight:700;color:var(--ink,#1a1a2e)}
        .cm-wg-chip{font-size:11px;font-weight:800;border-radius:999px;padding:4px 10px;border:1.5px solid;white-space:nowrap}
        .cm-wg-chip.av{border-color:#059669;background:#d1fae5;color:#065f46}
        .cm-wg-chip.bk{border-color:#b45309;background:#fbeeda;color:#b45309}
        .cm-wg-chip.bk-rec{border-color:#1d4ed8;background:#bfdbfe;color:#1d4ed8}
        .cm-wg-chip.bk-dem{border-color:#6d28d9;background:#ede9fe;color:#6d28d9}
        .cm-wg-chip.bk-mku{border-color:#92400e;background:#fef3c7;color:#92400e}
        .cm-wg-chip.un{border-color:#cbd0d9;background:#e5e7eb;color:#4b5563}
        @media(max-width:640px){ .cm-wg-desk{display:none} .cm-wg-stack{display:block} }
        @media(max-width:640px){ .cm-inline,.cm-inline *{min-width:0;max-width:100%} .cm-inline{overflow:hidden} }
        @media(max-width:920px){
          .cm-md{grid-template-columns:minmax(0,1fr);min-width:0}
          .cm-roster{min-width:0}
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
          <div className="cm-roster" style={{ display: 'grid', gap: 10 }}>
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
                  <div key={t.id} className="cm-teacher">
                  <button onClick={() => { if (isMobile) { if (selected === t.id) { setSelected(null); setPopSlot(null); } else selectTeacher(t.id); } else selectTeacher(t.id); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', width: '100%', padding: 10, borderRadius: (isMobile && on) ? '12px 12px 0 0' : 12, cursor: 'pointer',
                      border: '1px solid ' + (on ? 'var(--brand,#2f6fd0)' : 'var(--line,#e6e6ef)'), background: on ? 'var(--brand-soft,#e7f0fc)' : 'var(--card,#fff)', color: 'inherit' }}>
                    {avatar(t, 38, 13, i)}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 800, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                      <span className="muted" style={{ fontSize: 11.5 }}>{t.slots} slots · {t.open_slots} open{t.banned_at ? <span style={{ color: 'var(--coral,#c0392b)', fontWeight: 700 }}> · Banned</span> : ''}</span>
                    </span>
                    {badge > 0 && <span style={{ ...countBadge, background: 'var(--amber,#b45309)' }}>{badge}</span>}
                    {isMobile && <span aria-hidden style={{ marginLeft: 4, color: on ? 'var(--brand,#2f6fd0)' : 'var(--muted,#8a93a3)', fontSize: 12, flex: '0 0 auto' }}>{on ? '▲' : '▼'}</span>}
                  </button>
                  {isMobile && on && sel && <div className="cm-inline">{renderDetail(sel)}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* RIGHT: detail (desktop two-column). On mobile the detail renders inline under the tapped row. */}
          {!isMobile && (
            <div className="cm-detail" style={{ border: '1px solid var(--line,#e6e6ef)', borderRadius: 14, background: 'var(--card,#fff)', padding: 16, minHeight: 200 }}>
              {!sel ? <div className="muted" style={{ padding: 20, textAlign: 'center' }}>Select a teacher.</div> : renderDetail(sel)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
