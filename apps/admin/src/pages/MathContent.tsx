import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { SetEditor } from '../components/SetEditor';
import { BulkSets, PER_SET_CEILING, loadDefaultPerSet, saveDefaultPerSet } from '../components/BulkSets';

// Math Olympiad — admin-managed content, styled to the Content-Page-Admin mockup: a tabs + GRADE card,
// a FOLDERS tree (left), and a sets table (SET · QUESTIONS · STATUS · UPDATED · ACTIONS) for the chosen
// folder. Three TRACKS (Curriculum / Tests / Quiz Arena). Everything is program='math', site_id='math'.
type Track = 'curriculum' | 'test' | 'quiz';
const TRACKS: { k: Track; label: string; icon: string }[] = [
  { k: 'curriculum', label: 'Curriculum', icon: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5' },
  { k: 'test', label: 'Tests', icon: 'M8 3h8v3H8zM6 6h12v15H6zM9 11h6M9 15h4' },
  { k: 'quiz', label: 'Quiz Arena', icon: 'M12 3l2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.8z' },
];
const BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  published: { bg: '#E6F4EC', fg: '#1E7A4C', label: 'Published' },
  approved:  { bg: '#EAF1FB', fg: '#1A5EAB', label: 'In review' },
  scheduled: { bg: '#EAF1FB', fg: '#1A5EAB', label: 'Scheduled' },
  draft:     { bg: '#F1F4FA', fg: '#64718A', label: 'Draft' },
  retired:   { bg: '#FDF0E6', fg: '#B2460B', label: 'Retired' },
};
const badgeStyle = (state: string): React.CSSProperties => {
  const b = BADGE[state] || BADGE.draft;
  return { background: b.bg, color: b.fg, fontWeight: 700, fontSize: 11.5, padding: '6px 11px', borderRadius: 999, display: 'inline-block', whiteSpace: 'nowrap' };
};
const COLS = 'minmax(150px,1.3fr) 150px 120px 100px minmax(250px,1.15fr)';
// SWR cache for the Math tree, keyed by `track:gradeId`. Survives tab/grade switches so revisiting a
// grade paints instantly from cache while a fresh copy loads in the background. Invalidated on mutations.
const treeCache = new Map<string, any[]>();

// Per-set exam time limit editor (Tests track only): number input + ±5 steppers, persists via patchSet.
function TimeLimitCell({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  const clamp = (n: number) => Math.max(1, Math.min(180, Math.round(n || 1)));
  const commit = (raw: number) => { const c = clamp(raw); setV(String(c)); if (c !== value) onCommit(c); };
  const cur = Number(v) || value;
  const stepBtn: React.CSSProperties = { border: '1px solid var(--line,#D7DEEA)', background: 'var(--card,#fff)', cursor: 'pointer', width: 26, height: 17, lineHeight: '13px', fontSize: 9, color: '#44506A', padding: 0 };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input value={v} inputMode="numeric" pattern="[0-9]*"
        onChange={e => setV(e.target.value.replace(/\D/g, ''))}
        onBlur={() => commit(Number(v) || value)}
        onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
        style={{ width: 54, height: 36, textAlign: 'center', border: '1px solid var(--line,#D7DEEA)', borderRadius: 8, fontWeight: 700, fontSize: 14, background: 'var(--card,#fff)', color: 'var(--ink,#15233D)' }} />
      <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
        <button type="button" aria-label="Increase time limit" style={{ ...stepBtn, borderRadius: '6px 6px 0 0', borderBottom: 0 }} onClick={() => commit(cur + 5)}>▲</button>
        <button type="button" aria-label="Decrease time limit" style={{ ...stepBtn, borderRadius: '0 0 6px 6px' }} onClick={() => commit(cur - 5)}>▼</button>
      </span>
    </span>
  );
}

export function MathContent() {
  const [grades, setGrades] = useState<any[]>([]);
  const [gradeId, setGradeId] = useState('');
  const [track, setTrack] = useState<Track>('curriculum');
  const [folders, setFolders] = useState<any[]>([]);
  const [folderId, setFolderId] = useState<string>(''); // '' = all folders
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState('');
  const [tax, setTax] = useState<any>(null);
  const [editId, setEditId] = useState<string>('');
  const [newSet, setNewSet] = useState(false);
  const [addFolder, setAddFolder] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [defPerSet, setDefPerSet] = useState<number>(loadDefaultPerSet);
  const setDefault = (n: number) => { const v = Math.min(PER_SET_CEILING, Math.max(1, Math.round(n || 1))); setDefPerSet(v); saveDefaultPerSet(v); };

  const [gradeOpen, setGradeOpen] = useState(false);
  const gradeBtnRef = useRef<HTMLButtonElement>(null);
  const [gradePos, setGradePos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const openGrade = () => {
    const r = gradeBtnRef.current?.getBoundingClientRect();
    if (r) setGradePos({ top: Math.round(r.bottom + 6), right: Math.round(window.innerWidth - r.right) });
    setGradeOpen(o => !o);
  };

  useEffect(() => {
    api.mathGrades().then(r => { setGrades(r.grades || []); if (r.grades?.length) setGradeId(g => g || r.grades[0].id); })
      .catch(e => setErr((e as Error).message));
    api.taxonomy('math').then(setTax).catch(() => {});
  }, []);

  const abortRef = useRef<AbortController | null>(null);
  const applyTree = (fs: any[]) => {
    setFolders(fs);
    setFolderId(cur => (cur && fs.some((f: any) => f.id === cur)) ? cur : (fs[0]?.id || ''));
  };
  const loadTree = useCallback((silent = false) => {
    if (!gradeId) return;
    const key = `${track}:${gradeId}`;
    const cached = treeCache.get(key);
    if (cached) applyTree(cached);              // instant paint from cache, no spinner
    if (!cached && !silent) setLoading(true);
    setErr('');
    abortRef.current?.abort();                  // cancel any in-flight tree fetch (C)
    const ac = new AbortController();
    abortRef.current = ac;
    api.mathTree(track, gradeId, ac.signal).then(r => {
      const fs = r.folders || [];
      treeCache.set(key, fs);
      if (abortRef.current === ac) applyTree(fs); // only apply if still the current request
    }).catch(e => {
      if ((e as any)?.name === 'AbortError') return;
      setErr((e as Error).message);
    }).finally(() => { if (abortRef.current === ac && !cached && !silent) setLoading(false); });
  }, [track, gradeId]);
  useEffect(() => { loadTree(); }, [loadTree]);
  useEffect(() => () => abortRef.current?.abort(), []); // abort on unmount
  // After a mutation, drop the cached copy for this view so the reload shows fresh data.
  const reloadFresh = useCallback(() => { treeCache.delete(`${track}:${gradeId}`); loadTree(true); }, [track, gradeId, loadTree]);

  const gradeLabel = (g: any) => g?.name || (g ? `Grade ${g.grade_number}` : '');
  const curGrade = grades.find(g => g.id === gradeId);
  const curFolder = folders.find(f => f.id === folderId);

  // Rows for the chosen folder (or all folders when none selected).
  const rows = useMemo(() => {
    const out: any[] = [];
    const list = folderId ? folders.filter(f => f.id === folderId) : folders;
    for (const f of list) {
      const subName: Record<string, string> = {};
      for (const sf of (f.subfolders || [])) subName[sf.id] = sf.name;
      for (const s of (f.sets || [])) out.push({ ...s, folder: f.name, subfolder: s.subcategory_id ? subName[s.subcategory_id] : null });
    }
    return out;
  }, [folders, folderId]);

  const act = async (fn: () => Promise<any>, id: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusyId(id); setErr('');
    try { await fn(); treeCache.delete(`${track}:${gradeId}`); loadTree(true); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusyId(''); }
  };

  const card: React.CSSProperties = { background: 'var(--card,#fff)', border: '1px solid var(--line,#E6EAF2)', borderRadius: 16 };
  const muted = 'var(--muted,#64718A)';
  const trackLabel = TRACKS.find(t => t.k === track)?.label;
  const showFolders = track === 'curriculum';
  const crumbChild = track === 'curriculum' ? (curFolder ? curFolder.name : 'All folders') : (track === 'test' ? 'All test papers' : 'All quizzes');
  const isTest = track === 'test';
  const cols = isTest ? 'minmax(150px,1.3fr) 150px 120px 100px 150px minmax(220px,1.1fr)' : COLS;
  const tableMinWidth = isTest ? 920 : 760;
  // Persist a per-set time limit optimistically (update folders + SWR cache, then PATCH).
  const commitDuration = (svId: string, n: number) => {
    const patch = (d: number | null) => {
      const upd = (fs: any[]) => fs.map(f => ({ ...f, sets: (f.sets || []).map((s: any) => s.set_version_id === svId ? { ...s, duration_minutes: d } : s) }));
      setFolders(upd);
      const key = `${track}:${gradeId}`; const cached = treeCache.get(key); if (cached) treeCache.set(key, upd(cached));
    };
    let prev: number | null = null;
    for (const f of folders) for (const s of (f.sets || [])) if (s.set_version_id === svId) prev = s.duration_minutes ?? null;
    patch(n);
    api.patchSet(svId, { duration_minutes: n }).catch(e => { patch(prev); setErr((e as Error).message); });
  };

  const actBtn = (label: string, onClick: () => void, variant: 'default' | 'primary' | 'warn' | 'danger', disabled = false): React.ReactNode => {
    const styles: Record<string, React.CSSProperties> = {
      default: { border: '1px solid var(--line,#D7DEEA)', background: 'var(--card,#fff)', color: 'var(--ink,#15233D)' },
      primary: { border: 0, background: '#1A5EAB', color: '#fff' },
      warn: { border: '1px solid #F0D3AE', background: '#FFF6E8', color: '#B4540C' },
      danger: { border: 0, background: '#B4231B', color: '#fff' },
    };
    return (
      <button key={label} disabled={disabled} onClick={onClick}
        style={{ height: 32, padding: '0 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? .5 : 1, ...styles[variant] }}>
        {label}
      </button>
    );
  };

  return (
    <div style={{ padding: '2px' }}>
      {/* Tabs + Grade card */}
      <div style={{ ...card, padding: '0 0 0 6px', marginBottom: 20, display: 'flex', alignItems: 'stretch', gap: 10, overflow: 'visible' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', gap: 18, overflowX: 'auto', padding: '0 10px' }}>
          {TRACKS.map(t => {
            const on = t.k === track;
            return (
              <button key={t.k} onClick={() => setTrack(t.k)}
                style={{ display: 'flex', alignItems: 'center', gap: 9, height: 56, padding: '0 4px', border: 0, borderBottom: on ? '3px solid #E8A020' : '3px solid transparent', background: 'transparent', cursor: 'pointer', color: on ? 'var(--ink,#15233D)' : muted, fontWeight: on ? 800 : 500, fontSize: 14.5, whiteSpace: 'nowrap' }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={on ? 'var(--primary,#1A5EAB)' : '#8E99AE'} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', borderLeft: '1px solid var(--line,#EEF1F7)', padding: '10px 14px', background: 'var(--card2,#FAFBFE)', position: 'relative' }}>
          <button ref={gradeBtnRef} onClick={openGrade} aria-haspopup="listbox" aria-expanded={gradeOpen}
            style={{ display: 'flex', alignItems: 'center', gap: 12, height: 44, padding: '0 20px', border: '1px solid var(--line,#E6EAF2)', borderRadius: 999, background: 'var(--card,#fff)', cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: '0 1px 2px rgba(15,27,51,.05)' }}>
            <span style={{ fontSize: 15.5, fontWeight: 800, color: 'var(--ink,#15233D)' }}>{gradeLabel(curGrade) || 'Select grade'}</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {gradeOpen && (
            <>
              <button onClick={() => setGradeOpen(false)} aria-label="Close" style={{ position: 'fixed', inset: 0, background: 'transparent', border: 0, zIndex: 39, cursor: 'default' }} />
              <div role="listbox" style={{ position: 'fixed', top: gradePos.top, right: gradePos.right, zIndex: 40, width: 220, maxHeight: 'min(60vh, 360px)', overflowY: 'auto', background: 'var(--card,#fff)', border: '1px solid var(--line,#E6EAF2)', borderRadius: 12, boxShadow: '0 18px 44px rgba(15,27,51,.18)', padding: 8 }}>
                {grades.map(g => (
                  <button key={g.id} onClick={() => { setGradeId(g.id); setGradeOpen(false); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 14px', border: 0, borderRadius: 8, background: g.id === gradeId ? 'var(--card2,#F1F3F7)' : 'transparent', color: 'var(--ink,#15233D)', fontWeight: g.id === gradeId ? 800 : 500, fontSize: 15, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    {gradeLabel(g)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Folders (left, Curriculum only) + sets (right) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
        {showFolders && (
        <div style={{ ...card, flex: '1 1 260px', minWidth: 240, maxWidth: 300, padding: 12, maxHeight: 'calc(100vh - 230px)', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px 10px 12px' }}>
            <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '1px', color: '#98A2B6' }}>FOLDERS</span>
            <button onClick={() => setAddFolder(true)} title="Add folder" aria-label="Add folder"
              style={{ width: 28, height: 28, flex: 'none', border: '1px solid var(--line,#E6EAF2)', borderRadius: 8, background: 'var(--card,#fff)', color: 'var(--primary,#1A5EAB)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>
          {folders.length === 0 && <div className="muted" style={{ padding: '6px 12px', fontSize: 13 }}>No folders yet.</div>}
          {folders.length > 0 && (
            <button onClick={() => setFolderId('')}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '11px 12px', marginBottom: 3, border: 0, borderRadius: 10, cursor: 'pointer', fontSize: 14, background: folderId === '' ? '#1A5EAB' : 'transparent', color: folderId === '' ? '#fff' : '#44506A', fontWeight: folderId === '' ? 800 : 500 }}>
              <span style={{ flex: 1 }}>All folders</span>
              <span style={{ fontSize: 12.5, color: folderId === '' ? '#CFE0F5' : '#98A2B6' }}>{folders.reduce((n, f) => n + (f.sets?.length || 0), 0)} sets</span>
            </button>
          )}
          {folders.map(f => {
            const on = f.id === folderId;
            return (
              <button key={f.id} onClick={() => setFolderId(f.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '11px 12px', marginBottom: 3, border: 0, borderRadius: 10, cursor: 'pointer', fontSize: 14, background: on ? '#1A5EAB' : 'transparent', color: on ? '#fff' : '#44506A', fontWeight: on ? 800 : 500 }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="M3 7l4-3h5l2 2h7v14H3z" /></svg>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <span style={{ flex: 'none', fontSize: 12.5, color: on ? '#CFE0F5' : '#98A2B6' }}>{(f.sets?.length || 0)} sets</span>
              </button>
            );
          })}
        </div>
        )}

        <div style={{ flex: '999 1 560px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={{ flex: 1, minWidth: 200, fontSize: 15, color: muted }}>
              {trackLabel} <span style={{ color: '#C8D0DE' }}>→</span> <span style={{ color: 'var(--ink,#15233D)', fontWeight: 800 }}>{crumbChild}</span>
            </div>
            <span title="Remembered default — pre-fills Questions per set in Bulk add sets" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none', background: 'var(--card2,#F7F9FD)', border: '1px solid var(--line,#E6EAF2)', borderRadius: 12, padding: '5px 10px' }}>
              <span className="muted" style={{ fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', fontWeight: 700 }}>Default per set</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', border: '1.5px solid var(--line,#E6EAF2)', borderRadius: 9, overflow: 'hidden', background: 'var(--card,#fff)' }}>
                <button type="button" className="btn ghost sm" style={{ border: 0, borderRadius: 0, width: 30 }} disabled={defPerSet <= 1} onClick={() => setDefault(defPerSet - 5)}>−</button>
                <input type="text" inputMode="numeric" pattern="[0-9]*" value={defPerSet} onChange={e => setDefault(Number(e.target.value.replace(/\D/g, '')))}
                  style={{ width: 56, textAlign: 'center', border: 0, borderLeft: '1px solid var(--line,#E6EAF2)', borderRight: '1px solid var(--line,#E6EAF2)', borderRadius: 0, fontWeight: 700, fontSize: 14 }} />
                <button type="button" className="btn ghost sm" style={{ border: 0, borderRadius: 0, width: 30 }} disabled={defPerSet >= PER_SET_CEILING} onClick={() => setDefault(defPerSet + 5)}>+</button>
              </span>
            </span>
            <button onClick={() => { if (folderId && tax) setBulk(true); }} disabled={!folderId || !tax} title={!folderId ? 'Select a folder first' : undefined} style={{ height: 40, padding: '0 18px', flex: 'none', border: '1px solid var(--line,#D7DEEA)', borderRadius: 999, background: 'var(--card,#fff)', fontSize: 13.5, fontWeight: 700, color: (!folderId || !tax) ? '#98A2B6' : 'var(--ink,#15233D)', cursor: (!folderId || !tax) ? 'not-allowed' : 'pointer', opacity: (!folderId || !tax) ? .6 : 1 }}>⤓ Bulk add sets</button>
            <button onClick={() => { if (!folders.length) { setAddFolder(true); return; } setNewSet(true); }} style={{ height: 40, padding: '0 20px', flex: 'none', border: 0, borderRadius: 10, background: '#1A5EAB', color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>Upload set</button>
          </div>
          {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}
          <div style={{ ...card, overflowX: 'auto' }}>
            <div style={{ minWidth: tableMinWidth, display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '13px 20px', background: 'var(--card2,#F4F7FC)', fontSize: 12, fontWeight: 800, letterSpacing: '.5px', color: muted }}>
              <span>SET</span><span>QUESTIONS</span><span>STATUS</span><span>UPDATED</span>{isTest && <span>TIME LIMIT (MIN)</span>}<span style={{ textAlign: 'right' }}>ACTIONS</span>
            </div>
            {loading ? (
              <div className="muted" style={{ padding: 22 }}>Loading…</div>
            ) : rows.length === 0 ? (
              <div className="muted" style={{ padding: 28, textAlign: 'center' }}>No sets yet for {trackLabel} · {gradeLabel(curGrade)}{showFolders && curFolder ? ` · ${curFolder.name}` : ''}. {showFolders ? 'Add a folder, then upload a set.' : 'Use Bulk add sets or Upload set to get started.'}</div>
            ) : rows.map((s, i) => {
              const q = s.question_count ?? 0;
              const pct = Math.max(2, Math.min(100, q)) + '%';
              const published = s.state === 'published';
              const busy = busyId === s.set_version_id;
              return (
                <div key={s.set_version_id} style={{ minWidth: tableMinWidth, display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '15px 20px', borderBottom: '1px solid var(--line,#F3F5FA)', alignItems: 'center', background: i % 2 ? 'var(--card2,#FBFCFE)' : 'var(--card,#fff)' }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 800, color: '#1A5EAB', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                    </span>
                    <span style={{ display: 'block', fontSize: 12, color: '#98A2B6', marginTop: 3 }}>{s.folder}{s.subfolder ? ` · ${s.subfolder}` : ''}</span>
                  </span>
                  <span>
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: '#D4620E' }}>{q} / 100</span>
                    <span style={{ display: 'block', height: 6, borderRadius: 999, background: '#E3E8F0', marginTop: 6, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: pct, borderRadius: 999, background: '#E8A020' }} /></span>
                  </span>
                  <span><span style={badgeStyle(s.state)}>{(BADGE[s.state] || BADGE.draft).label}</span></span>
                  <span style={{ fontSize: 13.5, color: muted }}>{s.updated_at ? new Date(s.updated_at).toLocaleDateString() : '—'}</span>
                  {isTest && (
                    <span><TimeLimitCell value={s.duration_minutes ?? 30} onCommit={(n) => commitDuration(s.set_version_id, n)} /></span>
                  )}
                  <span style={{ display: 'flex', gap: 7, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                    {actBtn('Edit', () => setEditId(s.set_version_id), 'default', busy || !tax)}
                    {actBtn(published ? 'Retire' : 'Publish',
                      () => act(() => published ? api.retireSet(s.set_version_id) : api.publishSet(s.set_version_id), s.set_version_id),
                      published ? 'warn' : 'primary', busy)}
                    {actBtn('Delete', () => act(() => api.deleteSet(s.set_version_id), s.set_version_id), 'danger', busy)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {editId && tax && <SetEditor taxonomy={tax} setId={editId} onClose={() => setEditId('')} onSaved={() => { setEditId(''); reloadFresh(); }} />}
      {bulk && tax && curFolder && (() => {
        const med = (tax.difficulties || []).find((d: any) => d.key === 'medium') || (tax.difficulties || [])[0];
        const taxCat = (tax.categories || []).find((c: any) => c.id === folderId);
        if (!curGrade || !med || !taxCat) return null;
        return (
          <BulkSets
            ctx={{
              gradeId: curGrade.id, catId: folderId, subId: '', diffId: med.id, qType: 'math',
              gradeNumber: curGrade.grade_number, categoryName: taxCat.name, subcategoryName: 'All sets',
              difficultyLabel: med.name || 'Medium', diffKey: med.key || 'medium', maxPerSet: PER_SET_CEILING,
            }}
            existingSets={rows} taxonomy={tax}
            onClose={() => { setBulk(false); reloadFresh(); }} onDone={reloadFresh}
          />
        );
      })()}
      {addFolder && <AddFolderModal track={track} gradeId={gradeId} onClose={() => setAddFolder(false)} onDone={() => { setAddFolder(false); reloadFresh(); }} />}
      {newSet && <NewSetModal track={track} gradeId={gradeId} folders={folders} onClose={() => setNewSet(false)} onDone={() => { setNewSet(false); reloadFresh(); }} onNeedFolder={() => { setNewSet(false); setAddFolder(true); }} />}
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
