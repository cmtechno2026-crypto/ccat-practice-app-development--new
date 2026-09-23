import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Teacher Hub directory. Click a teacher to expand and see their availability slots. Admins with
// teacher.slots.manage can book an open slot via a quick popover (student name + note) — the write
// lands in the Teacher Hub DB and the teacher sees who it's booked for.
interface TeacherRow { id: string; name: string; email: string; subjects: string[]; slots: number; open_slots: number; created_at: string; }
interface Slot {
  id: string; subject: string; grade: number | null; grade_min?: number | null; grade_max?: number | null; day_of_week: string; start_time: string; end_time: string;
  mode: string; status: string; timezone: string; notes: string;
  booked_student?: string | null; booked_note?: string | null; booked_by?: string | null;
}

const DAY_ABBR: Record<string, string> = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };

export function TeacherDirectory() {
  const [rows, setRows] = useState<TeacherRow[] | null>(null);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [slots, setSlots] = useState<Record<string, Slot[]>>({});
  const [slotErr, setSlotErr] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [savingSlot, setSavingSlot] = useState<string | null>(null);
  const [popSlot, setPopSlot] = useState<string | null>(null);
  const [pStudent, setPStudent] = useState('');
  const [pNote, setPNote] = useState('');
  const [pErr, setPErr] = useState('');
  const studentRef = useRef<HTMLInputElement>(null);
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');

  const load = (q: string) => { setErr(''); api.teacherTeachers(q).then(r => setRows(r.teachers || [])).catch(e => setErr((e as Error).message || 'Failed to load')); };
  useEffect(() => { load(''); }, []);

  const toggle = async (id: string) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id); setPopSlot(null);
    if (!slots[id]) {
      setLoadingId(id);
      try { const r = await api.teacherSlots(id); setSlots(s => ({ ...s, [id]: r.slots || [] })); }
      catch (e) { setSlotErr(m => ({ ...m, [id]: (e as Error).message || 'Failed to load slots' })); }
      finally { setLoadingId(null); }
    }
  };

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


// Grade label: prefer the grade_min/grade_max range (new schema); fall back to the legacy single grade.
function gradeLabel(s: { grade: number | null; grade_min?: number | null; grade_max?: number | null }): string {
  const lo = s.grade_min, hi = s.grade_max;
  if (lo != null && hi != null) return lo === hi ? (' · G' + lo) : (' · G' + lo + '–' + hi);
  return s.grade != null ? (' · G' + s.grade) : '';
}

  const statusPill = (status: string) => {
    const open = status === 'available';
    return <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', padding: '2px 8px', borderRadius: 999, background: open ? 'var(--good-soft,#dcf5ea)' : 'var(--coral-soft,#fdece9)', color: open ? 'var(--good,#0f9d6b)' : 'var(--coral,#c0392b)' }}>{status}</span>;
  };
  const initials = (n: string) => (n || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const inp = { padding: '7px 9px', border: '1px solid var(--line,#d7dce8)', borderRadius: 8, background: 'var(--card2,#f7f9fc)', color: 'inherit', width: '100%' } as React.CSSProperties;

  const renderSlots = (id: string) => {
    if (loadingId === id && !slots[id]) return <div className="muted" style={{ padding: '10px 14px' }}>Loading slots…</div>;
    if (slotErr[id]) return <div className="empty" style={{ padding: '10px 14px' }}>{slotErr[id]}</div>;
    const list = slots[id] || [];
    if (list.length === 0) return <div className="muted" style={{ padding: '10px 14px' }}>No slots for this teacher.</div>;
    return (
      <div style={{ display: 'grid', gap: 6, padding: '10px 14px' }}>
        {list.map(s => {
          const booked = s.status === 'booked';
          return (
            <div key={s.id} style={{ position: 'relative', background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 8, padding: '7px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 800, minWidth: 34 }}>{DAY_ABBR[s.day_of_week] || s.day_of_week}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{s.start_time} – {s.end_time}</span>
                <span className="muted" style={{ fontSize: 12 }}>{s.timezone}</span>
                <span style={{ fontWeight: 700 }}>{s.subject}{gradeLabel(s)}</span>
                <span className="muted" style={{ fontSize: 12 }}>{s.mode}</span>
                <span style={{ marginLeft: 'auto' }}>{statusPill(s.status)}</span>
                {canManage && (booked
                  ? <button onClick={() => unbook(id, s)} disabled={savingSlot === s.id} style={{ fontSize: 12, fontWeight: 700, padding: '4px 9px', borderRadius: 7, border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'inherit', cursor: 'pointer', opacity: savingSlot === s.id ? .6 : 1 }}>Mark open</button>
                  : <button onClick={() => openPopover(s.id)} disabled={savingSlot === s.id} style={{ fontSize: 12, fontWeight: 800, padding: '4px 11px', borderRadius: 7, border: 0, background: 'var(--teal,#0f766e)', color: '#fff', cursor: 'pointer' }}>Book</button>)}
              </div>

              {booked && s.booked_student && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--teal-soft,#dbf1ee)', color: 'var(--teal-ink,#0b5a54)', borderRadius: 999, padding: '2px 9px 2px 3px', fontWeight: 700, fontSize: 12 }}>
                    <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--teal,#0f766e)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 800 }}>{initials(s.booked_student)}</span>
                    {s.booked_student}
                  </span>
                  {s.booked_note && <span className="muted" style={{ fontSize: 12 }}>📝 {s.booked_note}</span>}
                  {s.booked_by && <span className="muted" style={{ fontSize: 11 }}>· by {s.booked_by}</span>}
                </div>
              )}

              {popSlot === s.id && (
                <>
                  <button aria-label="Close" onClick={() => setPopSlot(null)} style={{ position: 'fixed', inset: 0, background: 'transparent', border: 0, zIndex: 20, cursor: 'default' }} />
                  <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 30, width: 250, maxWidth: '92vw', background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, boxShadow: '0 16px 40px rgba(10,28,56,.28)', padding: 10, display: 'grid', gap: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint,#93a6b3)' }}>Book · {DAY_ABBR[s.day_of_week] || s.day_of_week} {s.start_time}</div>
                    <input ref={studentRef} value={pStudent} onChange={e => setPStudent(e.target.value)} placeholder="Student name" autoComplete="off" style={inp}
                      onKeyDown={e => { if (e.key === 'Enter') book(id, s); if (e.key === 'Escape') setPopSlot(null); }} />
                    <input value={pNote} onChange={e => setPNote(e.target.value)} placeholder="Note (optional)" style={inp}
                      onKeyDown={e => { if (e.key === 'Enter') book(id, s); if (e.key === 'Escape') setPopSlot(null); }} />
                    {pErr && <div style={{ color: 'var(--coral,#c0392b)', fontSize: 12 }}>{pErr}</div>}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => book(id, s)} disabled={savingSlot === s.id} style={{ flex: 1, fontWeight: 800, padding: '7px', borderRadius: 8, border: 0, background: 'var(--teal,#0f766e)', color: '#fff', cursor: 'pointer', opacity: savingSlot === s.id ? .6 : 1 }}>{savingSlot === s.id ? 'Booking…' : 'Book'}</button>
                      <button onClick={() => setPopSlot(null)} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'var(--muted,#5c7080)', cursor: 'pointer' }}>Esc</button>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--faint,#93a6b3)' }}>Press Enter to book</div>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <form onSubmit={(e) => { e.preventDefault(); load(search); }} style={{ display: 'flex', gap: 8 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or email…"
          style={{ flex: 1, maxWidth: 320, padding: '8px 10px', border: '1px solid var(--line,#e6e6ef)', borderRadius: 8, background: 'var(--card,#fff)', color: 'inherit' }} />
        <button className="btn ghost sm" type="submit">Search</button>
      </form>
      {err && <div className="empty">{err}</div>}
      {!err && !rows && <div className="empty">Loading…</div>}
      {rows && rows.length === 0 && <div className="empty">No teachers found.</div>}
      {rows && rows.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          {rows.map(t => {
            const open = expanded === t.id;
            return (
              <div key={t.id} style={{ border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, overflow: 'hidden', background: 'var(--card,#fff)' }}>
                <button onClick={() => toggle(t.id)} aria-expanded={open}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', background: open ? 'var(--card2,#f7f9fc)' : 'transparent', border: 0, padding: '12px 14px', cursor: 'pointer', color: 'inherit' }}>
                  <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s', color: 'var(--muted,#64748b)', fontSize: 12 }}>▶</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 800, display: 'block' }}>{t.name}</span>
                    <span className="muted" style={{ fontSize: 12 }}>{t.email}{(t.subjects && t.subjects.length) ? (' · ' + t.subjects.join(', ')) : ''}</span>
                  </span>
                  <span style={{ textAlign: 'right', fontSize: 13 }}>
                    <span style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{t.slots}</span>
                    <span className="muted"> slots</span>
                    <span className="muted" style={{ display: 'block', fontSize: 12 }}>{t.open_slots} open</span>
                  </span>
                </button>
                {open && <div style={{ borderTop: '1px solid var(--line,#e6e6ef)', background: 'var(--card2,#f7f9fc)' }}>{renderSlots(t.id)}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
