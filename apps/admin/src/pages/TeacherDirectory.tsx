import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

// Teacher Hub directory. Read-only first slice — lists teachers with slot counts. Editing
// (create/suspend) lands behind teacher.manage in a later pass.
interface TeacherRow { id: string; name: string; email: string; subjects: string[]; slots: number; open_slots: number; created_at: string; }

export function TeacherDirectory() {
  const [rows, setRows] = useState<TeacherRow[] | null>(null);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const load = (q: string) => { setErr(''); api.teacherTeachers(q).then(r => setRows(r.teachers || [])).catch(e => setErr(e.message || 'Failed to load')); };
  useEffect(() => { load(''); }, []);

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
        <div style={{ overflowX: 'auto', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', background: 'var(--card2,#f7f9fc)' }}>
                <th style={{ padding: '10px 12px' }}>Name</th>
                <th style={{ padding: '10px 12px' }}>Email</th>
                <th style={{ padding: '10px 12px' }}>Subjects</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Slots</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(t => (
                <tr key={t.id} style={{ borderTop: '1px solid var(--line,#eee)' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 700 }}>{t.name}</td>
                  <td style={{ padding: '10px 12px' }} className="muted">{t.email}</td>
                  <td style={{ padding: '10px 12px' }}>{(t.subjects || []).join(', ') || '—'}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{t.slots}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{t.open_slots}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
