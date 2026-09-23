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
                    <button className="btn ghost sm" onClick={() => pick(t)}>{on ? '▾ Open' : 'Add students ›'}</button>{' '}
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

// Inline panel (below the Teachers table) for the picked teacher. Ticks are the teacher's full assigned
// set — pre-loaded and saved with setTeacherStudents (tick = has access, untick = removed).
function AddStudentsPanel({ teacher, onClose, onSaved, toast }: { teacher: { id: string; name: string }; onClose: () => void; onSaved: () => void; toast: (m: string) => void }) {
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Current assignments (ids) — pre-tick these.
  const assignedAsync = useAsync(() => api.teacherStudents(teacher.id), [teacher.id]);
  useEffect(() => { if (assignedAsync.data) setAssigned(new Set(assignedAsync.data.student_ids)); }, [assignedAsync.data]);

  // Searchable student list (defaults to first 50; narrows as you type).
  const listAsync = useAsync(() => api.students({ q: q.trim() || undefined, limit: 50 }), [q]);
  const students: any[] = listAsync.data?.items ?? [];

  const toggle = (id: string) => setAssigned((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const save = async () => {
    setBusy(true); setErr('');
    try { await api.setTeacherStudents(teacher.id, Array.from(assigned)); toast(`Saved — ${assigned.size} student(s) assigned to ${teacher.name}.`); onSaved(); onClose(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px dashed var(--primary, #1A5EAB)', background: '#f7faff', borderRadius: 12, padding: '14px 16px', marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--primary, #1A5EAB)', letterSpacing: .3 }}>ADD STUDENTS → {teacher.name}</div>
        <span className="muted" style={{ fontSize: 12 }}>{assigned.size} assigned</span>
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>✕ Close</button>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search students by name, username, or guardian…" />
      <div style={{ maxHeight: 320, overflow: 'auto', marginTop: 10, border: '1px solid var(--line)', borderRadius: 10, background: '#fff' }}>
        {assignedAsync.loading || listAsync.loading ? <Loading /> : listAsync.error ? <ErrorBox e={listAsync.error} /> : students.length === 0 ? (
          <div className="muted" style={{ padding: 14 }}>No students match.</div>
        ) : students.map((s: any) => (
          <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--line)', cursor: 'pointer', fontSize: 13.5 }}>
            <input type="checkbox" style={{ width: 15, height: 15 }} checked={assigned.has(s.id)} onChange={() => toggle(s.id)} />
            <b>{s.display_name}</b>
            <span className="muted">@{s.username} · Grade {s.grade_number}</span>
          </label>
        ))}
      </div>
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : `Save (${assigned.size})`}</button>
      </div>
    </div>
  );
}
