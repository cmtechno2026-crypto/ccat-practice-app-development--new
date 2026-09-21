import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Teacher Hub directory. Read-only. Click a teacher to expand and see that teacher's availability
// slots (day, time, subject/grade, status) pulled live from the Teacher Hub backend.
interface TeacherRow { id: string; name: string; email: string; subjects: string[]; slots: number; open_slots: number; created_at: string; }
interface Slot { id: string; subject: string; grade: number | null; day_of_week: string; start_time: string; end_time: string; mode: string; status: string; timezone: string; notes: string; }

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
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');

  // Book / unbook a slot from the admin. Writes to the Teacher Hub DB; the teacher app sees it (same
  // table). Updates the cached slot in place on success.
  const setSlotStatus = async (teacherId: string, slot: Slot) => {
    const next = slot.status === 'open' ? 'booked' : 'open';
    setSavingSlot(slot.id);
    try {
      await api.teacherSetSlotStatus(slot.id, next);
      setSlots(m => ({ ...m, [teacherId]: (m[teacherId] || []).map(x => x.id === slot.id ? { ...x, status: next } : x) }));
    } catch (e) { setSlotErr(m => ({ ...m, [teacherId]: (e as Error).message || 'Could not update slot' })); }
    finally { setSavingSlot(null); }
  };

  const load = (q: string) => { setErr(''); api.teacherTeachers(q).then(r => setRows(r.teachers || [])).catch(e => setErr(e.message || 'Failed to load')); };
  useEffect(() => { load(''); }, []);

  const toggle = async (id: string) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (!slots[id]) {
      setLoadingId(id);
      try { const r = await api.teacherSlots(id); setSlots(s => ({ ...s, [id]: r.slots || [] })); }
      catch (e) { setSlotErr(m => ({ ...m, [id]: (e as Error).message || 'Failed to load slots' })); }
      finally { setLoadingId(null); }
    }
  };

  const statusPill = (status: string) => {
    const open = status === 'open';
    return <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', padding: '2px 8px', borderRadius: 999, background: open ? 'var(--good-soft,#dcf5ea)' : 'var(--coral-soft,#fdece9)', color: open ? 'var(--good,#0f9d6b)' : 'var(--coral,#c0392b)' }}>{status}</span>;
  };

  const renderSlots = (id: string) => {
    if (loadingId === id && !slots[id]) return <div className="muted" style={{ padding: '10px 14px' }}>Loading slots…</div>;
    if (slotErr[id]) return <div className="empty" style={{ padding: '10px 14px' }}>{slotErr[id]}</div>;
    const list = slots[id] || [];
    if (list.length === 0) return <div className="muted" style={{ padding: '10px 14px' }}>No slots for this teacher.</div>;
    return (
      <div style={{ display: 'grid', gap: 6, padding: '10px 14px' }}>
        {list.map(s => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 10px', background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 8 }}>
            <span style={{ fontWeight: 800, minWidth: 34 }}>{DAY_ABBR[s.day_of_week] || s.day_of_week}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{s.start_time} – {s.end_time}</span>
            <span className="muted" style={{ fontSize: 12 }}>{s.timezone}</span>
            <span style={{ fontWeight: 700 }}>{s.subject}{s.grade != null ? (' · G' + s.grade) : ''}</span>
            <span className="muted" style={{ fontSize: 12 }}>{s.mode}</span>
            <span style={{ marginLeft: 'auto' }}>{statusPill(s.status)}</span>
            {canManage && (
              <button onClick={() => setSlotStatus(id, s)} disabled={savingSlot === s.id}
                style={{ fontSize: 12, fontWeight: 700, padding: '4px 9px', borderRadius: 7, cursor: savingSlot === s.id ? 'default' : 'pointer', border: '1px solid var(--line,#d7dce8)', background: 'var(--card,#fff)', color: 'inherit', opacity: savingSlot === s.id ? .6 : 1 }}>
                {savingSlot === s.id ? '…' : (s.status === 'open' ? 'Mark booked' : 'Mark open')}
              </button>
            )}
          </div>
        ))}
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
