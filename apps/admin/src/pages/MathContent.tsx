import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';

// Math Olympiad — admin-managed content. Three TRACKS (Curriculum / Quiz / Test); within each, pick a
// GRADE, then build FOLDERS (categories) + SUBFOLDERS (subcategories) + SETS. Everything is created as
// program='math', site_id='math' server-side, so it never touches CCAT/NGAT. Mirrors Content-Page mockup.
type Track = 'curriculum' | 'quiz' | 'test';
const TRACKS: { k: Track; label: string }[] = [
  { k: 'curriculum', label: 'Curriculum' },
  { k: 'quiz', label: 'Quiz' },
  { k: 'test', label: 'Test' },
];

const STATE_BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  published: { bg: '#e7f6ec', fg: '#1b8a4b', label: 'Published' },
  approved: { bg: '#eaf2ff', fg: '#2f6fd0', label: 'In review' },
  draft: { bg: '#eef1f6', fg: '#647089', label: 'Draft' },
  retired: { bg: '#fdeaea', fg: '#c0392b', label: 'Retired' },
};

export function MathContent() {
  const [grades, setGrades] = useState<any[]>([]);
  const [gradeId, setGradeId] = useState<string>('');
  const [track, setTrack] = useState<Track>('curriculum');
  const [folders, setFolders] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [newFolder, setNewFolder] = useState('');

  useEffect(() => {
    api.mathGrades().then(r => {
      setGrades(r.grades || []);
      if (r.grades?.length && !gradeId) setGradeId(r.grades[0].id);
    }).catch(e => setErr((e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTree = useCallback(() => {
    if (!gradeId) return;
    setLoading(true); setErr('');
    api.mathTree(track, gradeId)
      .then(r => setFolders(r.folders || []))
      .catch(e => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [track, gradeId]);
  useEffect(() => { loadTree(); }, [loadTree]);

  const addFolder = async () => {
    const name = newFolder.trim();
    if (!name || !gradeId) return;
    try { await api.mathCreateFolder({ track, grade_id: gradeId, name }); setNewFolder(''); loadTree(); }
    catch (e) { setErr((e as Error).message); }
  };
  const addSubfolder = async (categoryId: string) => {
    const name = window.prompt('New subfolder name')?.trim();
    if (!name) return;
    try { await api.mathCreateSubfolder(categoryId, name); loadTree(); }
    catch (e) { setErr((e as Error).message); }
  };
  const addSet = async (categoryId: string, subcategoryId: string | null) => {
    const name = window.prompt('New set name')?.trim();
    if (!name) return;
    try { await api.mathCreateSet({ track, grade_id: gradeId, category_id: categoryId, subcategory_id: subcategoryId, name }); loadTree(); }
    catch (e) { setErr((e as Error).message); }
  };
  const renameFolder = async (id: string, cur: string) => {
    const name = window.prompt('Rename folder', cur)?.trim();
    if (!name || name === cur) return;
    try { await api.mathRenameFolder(id, name); loadTree(); } catch (e) { setErr((e as Error).message); }
  };
  const delFolder = async (id: string) => {
    if (!window.confirm('Delete this empty folder?')) return;
    try { await api.mathDeleteFolder(id); loadTree(); } catch (e) { setErr((e as Error).message); }
  };

  const gradeLabel = (g: any) => g.name || `Grade ${g.grade_number}`;

  return (
    <div style={{ padding: '4px 2px' }}>
      {/* Track tabs */}
      <div role="tablist" aria-label="Track" style={{ display: 'inline-flex', background: 'var(--card2,#eef2f7)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 9, padding: 3, gap: 3, marginBottom: 16 }}>
        {TRACKS.map(t => {
          const on = t.k === track;
          return (
            <button key={t.k} role="tab" aria-selected={on} onClick={() => setTrack(t.k)}
              style={{ border: 0, background: on ? 'var(--card,#fff)' : 'transparent', color: on ? 'var(--primary,#1A5EAB)' : 'var(--muted,#647089)', fontWeight: 800, fontSize: 13, padding: '7px 16px', borderRadius: 7, cursor: 'pointer', boxShadow: on ? '0 1px 3px rgba(0,0,0,.10)' : 'none' }}>
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Grade selector + add folder */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
        <select value={gradeId} onChange={e => setGradeId(e.target.value)}
          style={{ height: 40, borderRadius: 10, border: '1px solid var(--line,#e6eaf2)', padding: '0 12px', minWidth: 160, background: 'var(--card,#fff)' }}>
          {grades.map(g => <option key={g.id} value={g.id}>{gradeLabel(g)}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <input value={newFolder} onChange={e => setNewFolder(e.target.value)} placeholder="New folder name"
          onKeyDown={e => { if (e.key === 'Enter') addFolder(); }}
          style={{ height: 40, borderRadius: 10, border: '1px solid var(--line,#e6eaf2)', padding: '0 12px', minWidth: 200 }} />
        <button className="btn" onClick={addFolder} disabled={!newFolder.trim() || !gradeId}>+ Add folder</button>
      </div>

      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}
      {loading && <div className="muted">Loading…</div>}
      {!loading && folders.length === 0 && (
        <div className="card" style={{ padding: 28, textAlign: 'center', color: 'var(--muted,#8a90a6)' }}>
          No folders yet for {TRACKS.find(t => t.k === track)?.label} · {grades.find(g => g.id === gradeId) ? gradeLabel(grades.find(g => g.id === gradeId)) : ''}. Add one above.
        </div>
      )}

      {/* Folder tree */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {folders.map(f => (
          <div key={f.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--line,#eef1f6)' }}>
              <span style={{ fontWeight: 800, fontSize: 15 }}>📁 {f.name}</span>
              <span className="muted" style={{ fontSize: 12 }}>{(f.sets?.length || 0)} set(s) · {(f.subfolders?.length || 0)} subfolder(s)</span>
              <div style={{ flex: 1 }} />
              <button className="btn ghost sm" onClick={() => addSet(f.id, null)}>+ Set</button>
              <button className="btn ghost sm" onClick={() => addSubfolder(f.id)}>+ Subfolder</button>
              <button className="btn ghost sm" onClick={() => renameFolder(f.id, f.name)} title="Rename">✎</button>
              <button className="btn ghost sm" onClick={() => delFolder(f.id)} title="Delete (if empty)">🗑</button>
            </div>
            <div style={{ padding: '6px 16px 12px' }}>
              <SetTable sets={(f.sets || []).filter((s: any) => !s.subcategory_id)} onAddSet={() => addSet(f.id, null)} />
              {(f.subfolders || []).map((sf: any) => (
                <div key={sf.id} style={{ marginTop: 8, paddingLeft: 10, borderLeft: '2px solid var(--line,#eef1f6)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                    <span style={{ fontWeight: 700, fontSize: 13.5 }}>📂 {sf.name}</span>
                    <div style={{ flex: 1 }} />
                    <button className="btn ghost sm" onClick={() => addSet(f.id, sf.id)}>+ Set</button>
                  </div>
                  <SetTable sets={(f.sets || []).filter((s: any) => s.subcategory_id === sf.id)} onAddSet={() => addSet(f.id, sf.id)} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SetTable({ sets, onAddSet }: { sets: any[]; onAddSet: () => void }) {
  if (!sets.length) return <div className="muted" style={{ fontSize: 12.5, padding: '4px 0' }}>No sets. <button className="linklike" onClick={onAddSet} style={{ background: 'none', border: 0, color: 'var(--primary,#1A5EAB)', cursor: 'pointer', fontWeight: 600 }}>Add one</button></div>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ color: 'var(--muted,#8a90a6)', textAlign: 'left', fontSize: 11, letterSpacing: '.04em' }}>
          <th style={{ padding: '6px 8px', fontWeight: 700 }}>SET</th>
          <th style={{ padding: '6px 8px', fontWeight: 700 }}>ITEMS</th>
          <th style={{ padding: '6px 8px', fontWeight: 700 }}>UPDATED</th>
          <th style={{ padding: '6px 8px', fontWeight: 700 }}>STATE</th>
        </tr>
      </thead>
      <tbody>
        {sets.map(s => {
          const b = STATE_BADGE[s.state] || STATE_BADGE.draft;
          return (
            <tr key={s.set_version_id} style={{ borderTop: '1px solid var(--line,#f1f3f8)' }}>
              <td style={{ padding: '8px', fontWeight: 600 }}>{s.name}</td>
              <td style={{ padding: '8px' }}>{s.question_count ?? 0}</td>
              <td style={{ padding: '8px', color: 'var(--muted,#8a90a6)' }}>{s.updated_at ? new Date(s.updated_at).toLocaleDateString() : '—'}</td>
              <td style={{ padding: '8px' }}><span style={{ background: b.bg, color: b.fg, fontWeight: 700, fontSize: 11.5, padding: '3px 9px', borderRadius: 999 }}>{b.label}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
