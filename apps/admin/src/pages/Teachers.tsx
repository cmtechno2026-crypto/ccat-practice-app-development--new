import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAsync, Loading, ErrorBox, Modal, useToast, StatusPill } from '../components/ui';

// Teachers — restricted admin accounts that can VIEW their assigned students (including Battery Practice
// & Exam Progress) but cannot edit students, change membership, reset PINs, delete or ban. Scope is
// enforced server-side (assertStudentVisible + the student-list filter); this page just manages the
// accounts and their assignments. Creating a teacher requires Super-Admin (enforced by the gateway).
export function Teachers() {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api.teachers(), []);
  const teachers = data?.teachers ?? [];
  const [create, setCreate] = useState(false);
  // Click a teacher row → open an inline "Add students" panel below the table (no modal).
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);

  const toggle = async (t: any) => {
    try { await api.setTeacherStatus(t.id, t.status === 'active' ? 'disabled' : 'active'); toast('Teacher updated.'); reload(); }
    catch (e) { toast((e as Error).message); }
  };
  const pick = (t: any) => setSelected(prev => prev?.id === t.id ? null : { id: t.id, name: t.display_name });

  return (
    <>
      <div className="toolbar"><h2>Teachers</h2>
        <div className="rowactions"><button className="btn" onClick={() => setCreate(true)}>+ Add teacher</button></div>
      </div>
      <div className="aihint" style={{ background: 'var(--tint, #E6F0FD)', color: '#1C4D8C' }}>
        Teachers get <b>read-only</b> access to their assigned students — including Battery Practice &amp; Exam Progress.
        They can’t edit students, change membership, reset PINs, delete or ban. Click a teacher to add students.
      </div>

      {loading ? <Loading /> : error ? <ErrorBox e={error} /> : (
        <div className="panel" style={{ padding: 0, marginTop: 12 }}>
          <div className="tablewrap"><table>
            <thead><tr><th>Teacher</th><th>Login</th><th>Students</th><th>Access</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {teachers.length === 0 ? (
                <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>No teachers yet — add one to give read-only student access.</td></tr>
              ) : teachers.map((t: any) => {
                const on = selected?.id === t.id;
                return (
                <tr key={t.id} onClick={() => pick(t)} style={{ cursor: 'pointer', ...(on ? { background: '#e8f0fb', boxShadow: 'inset 4px 0 0 var(--primary, #1f4fd6)' } : {}) }}>
                  <td><b>{t.display_name}</b>{on && <span className="tag" style={{ marginLeft: 8 }}>selected</span>}</td>
                  <td className="muted">{t.email}</td>
                  <td className="tabnum">{t.student_count}</td>
                  <td><span className="tag">View only</span></td>
                  <td><StatusPill status={t.status} /></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                    <button className="btn ghost sm" onClick={() => toggle(t)}>{t.status === 'active' ? 'Disable' : 'Enable'}</button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table></div>
        </div>
      )}

      {selected && <AddStudentsPanel key={selected.id} teacher={selected} onClose={() => setSelected(null)} onSaved={() => reload()} toast={toast} />}

      {create && <CreateTeacherModal onClose={() => setCreate(false)} onCreated={() => { setCreate(false); reload(); }} toast={toast} />}
    </>
  );
}

function CreateTeacherModal({ onClose, onCreated, toast }: { onClose: () => void; onCreated: () => void; toast: (m: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState<{ temp_password: string } | null>(null);

  const submit = async () => {
    if (!name.trim() || !email.trim()) { setErr('Name and login email are required.'); return; }
    if (pw.trim() && pw.trim().length < 6) { setErr('Temporary password must be at least 6 characters — or leave it blank to auto-generate one.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.createTeacher({ display_name: name.trim(), email: email.trim(), temp_password: pw.trim() || undefined });
      setCreated({ temp_password: r.temp_password });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (created) {
    return (
      <Modal title="Teacher created" onClose={onCreated}
        footer={<button className="btn grow" onClick={onCreated}>Done</button>}>
        <div className="aihint" style={{ background: 'var(--tint, #E6F0FD)', color: '#1C4D8C' }}>
          The teacher signs in at the admin login with <b>{email}</b> and this password — shown once:
        </div>
        <div style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 16, fontWeight: 700, background: 'var(--card-2,#f2f5fa)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px', margin: '8px 0', userSelect: 'all' }}>{created.temp_password}</div>
        <div className="muted" style={{ fontSize: 12 }}>Copy it now — it won’t be shown again. Then use “Manage students” to assign this teacher’s students.</div>
      </Modal>
    );
  }

  return (
    <Modal title="Add teacher" onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create teacher'}</button></>}>
      <div className="aihint" style={{ background: 'var(--tint, #E6F0FD)', color: '#1C4D8C' }}>
        Creates a restricted admin account: <b>view students only</b>. No edit, membership, PIN reset, deletion or ban.
      </div>
      <label>Full name</label>
      <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya Sharma" />
      <label>Login email</label>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teacher@conceptmastery.ca" />
      <label>Temporary password <span className="muted" style={{ fontWeight: 400 }}>(optional — leave blank to auto-generate)</span></label>
      <input value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 6 characters" />
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

// Right slide-over drawer for the picked teacher. Ticks are the teacher's full assigned set —
// pre-loaded and saved with setTeacherStudents (tick = has access, untick = removed). Already-assigned
// students are pinned to the top of the list, above all other students, regardless of the search filter.
function AddStudentsPanel({ teacher, onClose, onSaved, toast }: { teacher: { id: string; name: string }; onClose: () => void; onSaved: () => void; toast: (m: string) => void }) {
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [shown, setShown] = useState(false);

  // Slide-in on mount + lock background scroll while open.
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 10);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { clearTimeout(t); document.body.style.overflow = prev; };
  }, []);

  // Current assignments (ids) — pre-tick these.
  const assignedAsync = useAsync(() => api.teacherStudents(teacher.id), [teacher.id]);
  useEffect(() => { if (assignedAsync.data) setAssigned(new Set(assignedAsync.data.student_ids)); }, [assignedAsync.data]);

  // Full student roster (loaded once) so assigned students always resolve + pin to the top,
  // even when they fall outside the current search. Student directory is small; one page covers it.
  const listAsync = useAsync(() => api.students({ limit: 500 }), []);
  const all: any[] = listAsync.data?.items ?? [];

  const toggle = (id: string) => setAssigned((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const matches = (s: any) => {
    const t = q.trim().toLowerCase(); if (!t) return true;
    return [s.display_name, s.username, s.guardian_name, s.guardian_email].filter(Boolean).some((v: string) => String(v).toLowerCase().includes(t));
  };
  const byName = (a: any, b: any) => String(a.display_name || '').localeCompare(String(b.display_name || ''));
  const assignedStudents = all.filter((s) => assigned.has(s.id)).filter(matches).sort(byName);
  const otherStudents = all.filter((s) => !assigned.has(s.id)).filter(matches).sort(byName);

  const save = async () => {
    setBusy(true); setErr('');
    try { await api.setTeacherStudents(teacher.id, Array.from(assigned)); toast(`Saved — ${assigned.size} student(s) assigned to ${teacher.name}.`); onSaved(); onClose(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const Row = (s: any) => (
    <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)', cursor: 'pointer', fontSize: 13.5, background: assigned.has(s.id) ? '#f3f8ff' : undefined }}>
      <input type="checkbox" style={{ width: 16, height: 16 }} checked={assigned.has(s.id)} onChange={() => toggle(s.id)} />
      <b>{s.display_name}</b>
      <span className="muted">@{s.username}{s.grade_number != null ? ` \u00b7 Grade ${s.grade_number}` : ''}</span>
    </label>
  );

  const loading = assignedAsync.loading || listAsync.loading;

  return (
    <>
      {/* backdrop */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,38,67,.34)', opacity: shown ? 1 : 0, transition: 'opacity .2s ease', zIndex: 1000 }} />
      {/* drawer */}
      <aside role="dialog" aria-label={`Add students to ${teacher.name}`} style={{ position: 'fixed', top: 0, right: 0, height: '100vh', width: 440, maxWidth: '92vw', background: '#fff', boxShadow: '-18px 0 50px rgba(15,38,67,.18)', display: 'flex', flexDirection: 'column', transform: shown ? 'translateX(0)' : 'translateX(100%)', transition: 'transform .22s ease', zIndex: 1001 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--primary, #1A5EAB)', letterSpacing: .4 }}>ADD STUDENTS →</span>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{teacher.name}</span>
          <span className="muted" style={{ fontSize: 12 }}>{assigned.size} assigned</span>
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>✕ Close</button>
        </div>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search students by name, username, or guardian…" style={{ width: '100%' }} />
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? <Loading /> : listAsync.error ? <ErrorBox e={listAsync.error} /> : (
            <>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: .5, color: 'var(--primary, #1A5EAB)', textTransform: 'uppercase', padding: '10px 16px 6px', position: 'sticky', top: 0, background: '#fff' }}>★ Assigned ({assignedStudents.length})</div>
              {assignedStudents.length ? assignedStudents.map(Row) : <div className="muted" style={{ padding: '8px 16px', fontSize: 12.5 }}>None yet — tick students below.</div>}
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: .5, color: '#90a0b5', textTransform: 'uppercase', padding: '12px 16px 6px', position: 'sticky', top: 0, background: '#fff' }}>All students</div>
              {otherStudents.length ? otherStudents.map(Row) : <div className="muted" style={{ padding: '8px 16px', fontSize: 12.5 }}>No students match.</div>}
            </>
          )}
        </div>
        {err && <div className="err" style={{ margin: '8px 16px 0' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--line)', background: '#fafcff' }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : `Save (${assigned.size})`}</button>
        </div>
      </aside>
    </>
  );
}
