import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api';

// Math Olympiad — admin-managed content, styled to match the Content mockup: a tabs+grade card, stat
// cards, and a sets table (SET · GRADE · ITEMS · UPDATED · STATE). Three TRACKS (Curriculum / Quiz /
// Test); pick a GRADE; build FOLDERS (categories) + SETS. Everything is program='math', site_id='math'.
type Track = 'curriculum' | 'quiz' | 'test';
const TRACKS: { k: Track; label: string; icon: string }[] = [
  { k: 'curriculum', label: 'Curriculum', icon: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' },
  { k: 'quiz', label: 'Quiz', icon: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z' },
  { k: 'test', label: 'Test', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4' },
];
const BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  published: { bg: '#E7F6EC', fg: '#1B8A4B', label: 'Published' },
  approved:  { bg: '#EAF2FF', fg: '#2F6FD0', label: 'In review' },
  scheduled: { bg: '#FFF3E0', fg: '#B7791F', label: 'Scheduled' },
  draft:     { bg: '#EEF1F6', fg: '#647089', label: 'Draft' },
  retired:   { bg: '#FDEAEA', fg: '#C0392B', label: 'Retired' },
};
const badgeStyle = (state: string): React.CSSProperties => {
  const b = BADGE[state] || BADGE.draft;
  return { background: b.bg, color: b.fg, fontWeight: 700, fontSize: 12, padding: '4px 11px', borderRadius: 999, display: 'inline-block' };
};

export function MathContent() {
  const [grades, setGrades] = useState<any[]>([]);
  const [gradeId, setGradeId] = useState('');
  const [track, setTrack] = useState<Track>('curriculum');
  const [folders, setFolders] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [gradeOpen, setGradeOpen] = useState(false);
  const [newSet, setNewSet] = useState(false);
  const [addFolder, setAddFolder] = useState(false);

  useEffect(() => {
    api.mathGrades().then(r => { setGrades(r.grades || []); if (r.grades?.length) setGradeId(g => g || r.grades[0].id); })
      .catch(e => setErr((e as Error).message));
  }, []);

  const loadTree = useCallback(() => {
    if (!gradeId) return;
    setLoading(true); setErr('');
    api.mathTree(track, gradeId).then(r => setFolders(r.folders || []))
      .catch(e => setErr((e as Error).message)).finally(() => setLoading(false));
  }, [track, gradeId]);
  useEffect(() => { loadTree(); }, [loadTree]);

  const gradeLabel = (g: any) => g?.name || (g ? `Grade ${g.grade_number}` : '');
  const curGrade = grades.find(g => g.id === gradeId);

  // Flatten folders → one sets list (folder/subfolder name shown as the set's topic subtitle).
  const sets = useMemo(() => {
    const out: any[] = [];
    for (const f of folders) {
      const subName: Record<string, string> = {};
      for (const sf of (f.subfolders || [])) subName[sf.id] = sf.name;
      for (const s of (f.sets || [])) {
        out.push({ ...s, folder: f.name, subfolder: s.subcategory_id ? subName[s.subcategory_id] : null });
      }
    }
    return out;
  }, [folders]);

  const stats = useMemo(() => {
    const total = sets.length;
    const published = sets.filter(s => s.state === 'published').length;
    const drafts = sets.filter(s => s.state === 'draft' || s.state === 'approved').length;
    return [
      { label: 'SETS', value: total, note: `${TRACKS.find(t => t.k === track)?.label} · ${gradeLabel(curGrade)}` },
      { label: 'PUBLISHED', value: published, note: 'Live for students' },
      { label: 'IN PROGRESS', value: drafts, note: 'Draft / in review' },
      { label: 'FOLDERS', value: folders.length, note: 'Topics in this grade' },
    ];
  }, [sets, folders, track, curGrade]);

  const card: React.CSSProperties = { background: 'var(--card,#fff)', border: '1px solid var(--line,#E6EAF2)', borderRadius: 16 };
  const muted = 'var(--muted,#64718A)';

  return (
    <div style={{ padding: '2px' }}>
      {/* Tabs + Grade card */}
      <div style={{ ...card, padding: '0 0 0 6px', marginBottom: 20, display: 'flex', alignItems: 'stretch', gap: 10, overflow: 'hidden' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', gap: 6, overflowX: 'auto', padding: '0 6px' }}>
          {TRACKS.map(t => {
            const on = t.k === track;
            return (
              <button key={t.k} onClick={() => setTrack(t.k)}
                style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '16px 16px', border: 0, borderBottom: on ? '3px solid var(--primary,#1A5EAB)' : '3px solid transparent', background: 'transparent', cursor: 'pointer', color: on ? 'var(--primary,#1A5EAB)' : muted, fontWeight: 800, fontSize: 14 }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={on ? 'var(--primary,#1A5EAB)' : muted} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', borderLeft: '1px solid var(--line,#EEF1F7)', padding: '10px 14px', background: 'var(--card2,#FAFBFE)', position: 'relative' }}>
          <button onClick={() => setGradeOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', gap: 12, height: 42, padding: '0 16px', border: '1px solid var(--line,#E6EAF2)', borderRadius: 999, background: 'var(--card,#fff)', cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: '0 1px 2px rgba(15,27,51,.05)' }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: 1, color: '#98A2B6' }}>GRADE</span>
            <span style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--ink,#15233D)' }}>{gradeLabel(curGrade) || '—'}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {gradeOpen && (
            <>
              <button onClick={() => setGradeOpen(false)} aria-label="Close" style={{ position: 'fixed', inset: 0, background: 'transparent', border: 0, zIndex: 39, cursor: 'default' }} />
              <div style={{ position: 'absolute', top: 58, right: 14, zIndex: 40, width: 190, maxHeight: 300, overflowY: 'auto', background: 'var(--card,#fff)', border: '1px solid var(--line,#E6EAF2)', borderRadius: 14, boxShadow: '0 18px 40px rgba(15,27,51,.16)', padding: 6 }}>
                {grades.map(g => (
                  <button key={g.id} onClick={() => { setGradeId(g.id); setGradeOpen(false); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 0, borderRadius: 9, background: g.id === gradeId ? 'var(--card2,#EEF2F7)' : 'transparent', color: 'var(--ink,#15233D)', fontWeight: g.id === gradeId ? 800 : 600, fontSize: 14, cursor: 'pointer' }}>
                    {gradeLabel(g)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 18, marginBottom: 20 }}>
        {stats.map(c => (
          <div key={c.label} style={{ ...card, padding: 20 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: '.6px', color: muted, marginBottom: 10 }}>{c.label}</div>
            <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-.8px', color: 'var(--ink,#15233D)' }}>{c.value}</div>
            <div style={{ fontSize: 13, color: muted, marginTop: 6 }}>{c.note}</div>
          </div>
        ))}
      </div>

      {/* Sets table */}
      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--line,#EEF1F7)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink,#15233D)' }}>{TRACKS.find(t => t.k === track)?.label} sets</div>
            <div style={{ fontSize: 13, color: muted, marginTop: 3 }}>{gradeLabel(curGrade)} · {sets.length} set{sets.length === 1 ? '' : 's'} across {folders.length} folder{folders.length === 1 ? '' : 's'}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setAddFolder(true)} style={{ height: 40, padding: '0 16px', border: '1px solid var(--line,#E6EAF2)', borderRadius: 10, background: 'var(--card,#fff)', color: 'var(--ink,#15233D)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>+ Add folder</button>
            <button onClick={() => { if (!folders.length) { setAddFolder(true); return; } setNewSet(true); }} style={{ height: 40, padding: '0 18px', border: 0, borderRadius: 10, background: '#1A5EAB', color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>Upload set</button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) 110px 110px 130px 110px', gap: 12, padding: '12px 22px', background: 'var(--card2,#F4F7FC)', fontSize: 12, fontWeight: 800, letterSpacing: '.5px', color: muted }}>
          <span>SET</span><span>GRADE</span><span>ITEMS</span><span>UPDATED</span><span style={{ textAlign: 'right' }}>STATE</span>
        </div>
        {err && <div className="err" style={{ padding: '10px 22px' }}>{err}</div>}
        {loading ? (
          <div className="muted" style={{ padding: 22 }}>Loading…</div>
        ) : sets.length === 0 ? (
          <div className="muted" style={{ padding: 28, textAlign: 'center' }}>No sets yet for {TRACKS.find(t => t.k === track)?.label} · {gradeLabel(curGrade)}. Add a folder, then upload a set.</div>
        ) : sets.map(s => (
          <div key={s.set_version_id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) 110px 110px 130px 110px', gap: 12, padding: '15px 22px', borderBottom: '1px solid var(--line,#F3F5FA)', fontSize: 14, alignItems: 'center' }}>
            <span style={{ fontWeight: 700, minWidth: 0, color: 'var(--ink,#15233D)' }}>{s.name}
              <div style={{ fontSize: 12, color: '#98A2B6', fontWeight: 400, marginTop: 2 }}>{s.folder}{s.subfolder ? ` · ${s.subfolder}` : ''}</div>
            </span>
            <span style={{ color: muted }}>{gradeLabel(curGrade)}</span>
            <span style={{ color: muted }}>{s.question_count ?? 0}</span>
            <span style={{ color: muted }}>{s.updated_at ? new Date(s.updated_at).toLocaleDateString() : '—'}</span>
            <span style={{ textAlign: 'right' }}><span style={badgeStyle(s.state)}>{(BADGE[s.state] || BADGE.draft).label}</span></span>
          </div>
        ))}
      </div>

      {addFolder && <AddFolderModal track={track} gradeId={gradeId} onClose={() => setAddFolder(false)} onDone={() => { setAddFolder(false); loadTree(); }} />}
      {newSet && <NewSetModal track={track} gradeId={gradeId} folders={folders} onClose={() => setNewSet(false)} onDone={() => { setNewSet(false); loadTree(); }} onNeedFolder={() => { setNewSet(false); setAddFolder(true); }} />}
    </div>
  );
}

function Modal({ title, children, footer, onClose }: { title: string; children: React.ReactNode; footer: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,51,.35)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(460px,100%)', background: 'var(--card,#fff)', borderRadius: 16, boxShadow: '0 24px 60px rgba(0,0,0,.25)', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line,#eef1f6)', fontWeight: 800, fontSize: 16 }}>{title}</div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--line,#eef1f6)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>{footer}</div>
      </div>
    </div>
  );
}
const inputS: React.CSSProperties = { height: 42, borderRadius: 10, border: '1px solid var(--line,#e6eaf2)', padding: '0 12px', fontSize: 14, width: '100%' };

function AddFolderModal({ track, gradeId, onClose, onDone }: { track: Track; gradeId: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => { if (!name.trim()) return; setBusy(true); setErr('');
    try { await api.mathCreateFolder({ track, grade_id: gradeId, name: name.trim() }); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); } };
  return (
    <Modal title="Add folder" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Adding…' : 'Add folder'}</button></>}>
      <label style={{ fontWeight: 700, fontSize: 13 }}>Folder name</label>
      <input autoFocus style={inputS} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Number Theory" onKeyDown={e => { if (e.key === 'Enter') save(); }} />
      {err && <div className="err">{err}</div>}
    </Modal>
  );
}

function NewSetModal({ track, gradeId, folders, onClose, onDone, onNeedFolder }: { track: Track; gradeId: string; folders: any[]; onClose: () => void; onDone: () => void; onNeedFolder: () => void }) {
  const [categoryId, setCategoryId] = useState(folders[0]?.id || '');
  const [subId, setSubId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const cat = folders.find(f => f.id === categoryId);
  const save = async () => {
    if (!name.trim() || !categoryId) return; setBusy(true); setErr('');
    try { await api.mathCreateSet({ track, grade_id: gradeId, category_id: categoryId, subcategory_id: subId || null, name: name.trim() }); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="Upload set" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !name.trim() || !categoryId} onClick={save}>{busy ? 'Creating…' : 'Create set'}</button></>}>
      <label style={{ fontWeight: 700, fontSize: 13 }}>Folder</label>
      <select style={inputS} value={categoryId} onChange={e => { setCategoryId(e.target.value); setSubId(''); }}>
        {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      <button onClick={onNeedFolder} style={{ alignSelf: 'flex-start', background: 'none', border: 0, color: 'var(--primary,#1A5EAB)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', padding: 0 }}>+ New folder</button>
      {cat && (cat.subfolders || []).length > 0 && (
        <>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Subfolder <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
          <select style={inputS} value={subId} onChange={e => setSubId(e.target.value)}>
            <option value="">— None —</option>
            {(cat.subfolders || []).map((sf: any) => <option key={sf.id} value={sf.id}>{sf.name}</option>)}
          </select>
        </>
      )}
      <label style={{ fontWeight: 700, fontSize: 13 }}>Set name</label>
      <input autoFocus style={inputS} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Number Theory · Set 1" onKeyDown={e => { if (e.key === 'Enter') save(); }} />
      {err && <div className="err">{err}</div>}
    </Modal>
  );
}
