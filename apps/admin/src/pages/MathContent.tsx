import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { SetEditor } from '../components/SetEditor';
import { BulkSets, PER_SET_CEILING, loadDefaultPerSet, saveDefaultPerSet } from '../components/BulkSets';

// Math Olympiad — admin content, restructured to the Content-Page mockup. Curriculum chapters are the
// organizing unit: each chapter owns Study Material + Tests + Quiz Arena. Four top tabs:
//   Curriculum  — chapters (folders) + per-chapter sub-tabs (Study Material / Tests / Quiz Arena),
//                 full management, everything created here is filed to that chapter.
//   Study Material — flat list of every material across chapters (file into a chapter via a dropdown).
//   Tests / Quiz Arena — flat list of every set across chapters (file into a chapter via a dropdown).
// Study Material is view-only + hard-blocked: the gateway rasterizes server-side and serves per-page
// watermarked images (originals never reach the browser). Everything here is program='math', site='math'.
type SetTrack = 'test' | 'quiz';
type TopTab = 'curriculum' | 'study' | 'test' | 'quiz';
type SubTab = 'study' | 'test' | 'quiz';
const TOP_TABS: { k: TopTab; label: string; icon: string }[] = [
  { k: 'curriculum', label: 'Curriculum', icon: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5' },
  { k: 'study', label: 'Study Material', icon: 'M3 7l4-3h5l2 2h7v14H3z' },
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
// SWR cache for the Math set trees (test/quiz/curriculum), keyed `track:gradeId`.
const treeCache = new Map<string, any[]>();
const muted = 'var(--muted,#64718A)';
const card: React.CSSProperties = { background: 'var(--card,#fff)', border: '1px solid var(--line,#E6EAF2)', borderRadius: 16 };
const inputS: React.CSSProperties = { height: 42, borderRadius: 10, border: '1px solid var(--line,#e6eaf2)', padding: '0 12px', fontSize: 14, width: '100%' };
const NO_FOLDER = '— No folder —';

function flattenSets(folders: any[]): any[] {
  const out: any[] = [];
  for (const f of folders || []) {
    const subName: Record<string, string> = {};
    for (const sf of (f.subfolders || [])) subName[sf.id] = sf.name;
    for (const s of (f.sets || [])) out.push({ ...s, folder: f.name, subfolder: s.subcategory_id ? subName[s.subcategory_id] : null });
  }
  return out;
}
function fmtSize(bytes?: number | null): string {
  const b = Number(bytes || 0);
  if (!b) return '—';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}
function fmtDate(d?: string | null): string { return d ? new Date(d).toLocaleDateString() : '—'; }

// Chapter picker <select> used in set/material rows and upload modals.
function ChapterSelect({ value, chapters, onChange, disabled }: { value: string; chapters: any[]; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}
      style={{ ...inputS, height: 36, maxWidth: 220, background: 'var(--card,#fff)', color: 'var(--ink,#15233D)', opacity: disabled ? .6 : 1 }}>
      <option value="">{NO_FOLDER}</option>
      {chapters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

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

function actBtn(label: string, onClick: () => void, variant: 'default' | 'primary' | 'warn' | 'danger', disabled = false): React.ReactNode {
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
}

export function MathContent() {
  const [grades, setGrades] = useState<any[]>([]);
  const [gradeId, setGradeId] = useState('');
  const [topTab, setTopTab] = useState<TopTab>('curriculum');
  const [subTab, setSubTab] = useState<SubTab>('study');
  const [chapters, setChapters] = useState<any[]>([]);      // curriculum folders = chapters
  const [chapterId, setChapterId] = useState<string>('');   // selected chapter (Curriculum tab)
  const [sets, setSets] = useState<any[]>([]);               // flattened sets for the active set track
  const [materials, setMaterials] = useState<any[]>([]);     // study materials for the active scope
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState('');
  const [tax, setTax] = useState<any>(null);
  const [editId, setEditId] = useState('');
  const [newSet, setNewSet] = useState(false);
  const [addFolder, setAddFolder] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [addMaterial, setAddMaterial] = useState(false);
  const [preview, setPreview] = useState<{ id: string; title: string; pages: number } | null>(null);
  const [defPerSet, setDefPerSet] = useState<number>(loadDefaultPerSet);
  const setDefault = (n: number) => { const v = Math.min(PER_SET_CEILING, Math.max(1, Math.round(n || 1))); setDefPerSet(v); saveDefaultPerSet(v); };

  // The active SET track: Tests/Quiz top tabs, or the chapter sub-tab inside Curriculum.
  const setTrack: SetTrack | null =
    topTab === 'test' ? 'test' : topTab === 'quiz' ? 'quiz'
    : (topTab === 'curriculum' && (subTab === 'test' || subTab === 'quiz')) ? subTab : null;
  const showingStudy = topTab === 'study' || (topTab === 'curriculum' && subTab === 'study');
  // When inside a chapter, everything is filed to that chapter; flat tabs file to none.
  const fileChapter = topTab === 'curriculum' ? (chapterId || null) : null;

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

  // Chapters (curriculum folders) — needed for the folder panel and every chapter dropdown.
  const loadChapters = useCallback((silent = false) => {
    if (!gradeId) return;
    const key = `curriculum:${gradeId}`;
    const cached = treeCache.get(key);
    if (cached) { setChapters(cached); setChapterId(c => (c && cached.some(f => f.id === c)) ? c : (cached[0]?.id || '')); }
    api.mathTree('curriculum', gradeId).then(r => {
      const fs = r.folders || []; treeCache.set(key, fs); setChapters(fs);
      setChapterId(c => (c && fs.some((f: any) => f.id === c)) ? c : (fs[0]?.id || ''));
    }).catch(e => { if (!silent) setErr((e as Error).message); });
  }, [gradeId]);
  useEffect(() => { loadChapters(); }, [loadChapters]);

  // Sets for the active set track.
  const setsAbort = useRef<AbortController | null>(null);
  const loadSets = useCallback((silent = false) => {
    if (!gradeId || !setTrack) { setSets([]); return; }
    const key = `${setTrack}:${gradeId}`;
    const cached = treeCache.get(key);
    if (cached) setSets(flattenSets(cached));
    if (!cached && !silent) setLoading(true);
    setsAbort.current?.abort();
    const ac = new AbortController(); setsAbort.current = ac;
    api.mathTree(setTrack, gradeId, ac.signal).then(r => {
      const fs = r.folders || []; treeCache.set(key, fs);
      if (setsAbort.current === ac) setSets(flattenSets(fs));
    }).catch(e => { if ((e as any)?.name === 'AbortError') return; if (!silent) setErr((e as Error).message); })
      .finally(() => { if (setsAbort.current === ac && !cached && !silent) setLoading(false); });
  }, [gradeId, setTrack]);

  // Study materials for the active scope (chapter or all).
  const loadMaterials = useCallback((silent = false) => {
    if (!gradeId || !showingStudy) return;
    const filter = topTab === 'curriculum' ? (chapterId || undefined) : undefined;
    if (!silent) setLoading(true);
    api.mathStudyList(gradeId, filter).then(r => setMaterials(r.materials || []))
      .catch(e => { if (!silent) setErr((e as Error).message); })
      .finally(() => { if (!silent) setLoading(false); });
  }, [gradeId, showingStudy, topTab, chapterId]);

  useEffect(() => { setErr(''); if (setTrack) loadSets(); }, [loadSets, setTrack]);
  useEffect(() => { setErr(''); if (showingStudy) loadMaterials(); }, [loadMaterials, showingStudy]);
  useEffect(() => () => setsAbort.current?.abort(), []);

  // Auto-poll while any material is still rendering, so Processing → Ready updates without a manual refresh.
  useEffect(() => {
    if (!showingStudy) return;
    if (!materials.some(m => m.render_state === 'processing')) return;
    const t = setTimeout(() => loadMaterials(true), 4000);
    return () => clearTimeout(t);
  }, [materials, showingStudy, loadMaterials]);

  const gradeLabel = (g: any) => g?.name || (g ? `Grade ${g.grade_number}` : '');
  const curGrade = grades.find(g => g.id === gradeId);
  const curChapter = chapters.find(c => c.id === chapterId);

  const reloadSetsFresh = useCallback(() => { if (setTrack) { treeCache.delete(`${setTrack}:${gradeId}`); loadSets(true); } }, [setTrack, gradeId, loadSets]);
  const reloadChaptersFresh = useCallback(() => { treeCache.delete(`curriculum:${gradeId}`); loadChapters(true); }, [gradeId, loadChapters]);

  const actSet = async (fn: () => Promise<any>, id: string) => {
    setBusyId(id); setErr('');
    try { await fn(); reloadSetsFresh(); } catch (e) { setErr((e as Error).message); } finally { setBusyId(''); }
  };
  const actMaterial = async (fn: () => Promise<any>, id: string) => {
    setBusyId(id); setErr('');
    try { await fn(); loadMaterials(true); } catch (e) { setErr((e as Error).message); } finally { setBusyId(''); }
  };

  // Rows shown in a set table: filtered to the chapter when inside Curriculum.
  const setRows = useMemo(() => {
    if (!setTrack) return [];
    if (topTab === 'curriculum') return sets.filter(s => s.chapter_id === chapterId);
    return sets;
  }, [sets, setTrack, topTab, chapterId]);
  const materialRows = materials; // already scoped by the query

  const isTest = setTrack === 'test';
  // The flat default category for this set track (bulk/upload target). Flat tracks auto-create one.
  const defaultCatId = useMemo(() => {
    if (!setTrack) return '';
    const fs = treeCache.get(`${setTrack}:${gradeId}`) || [];
    return fs[0]?.id || '';
  }, [setTrack, gradeId, sets]);

  const commitDuration = (svId: string, n: number) => {
    const patch = (d: number | null) => setSets(ss => ss.map(s => s.set_version_id === svId ? { ...s, duration_minutes: d } : s));
    let prev: number | null = null;
    for (const s of sets) if (s.set_version_id === svId) prev = s.duration_minutes ?? null;
    patch(n);
    api.patchSet(svId, { duration_minutes: n }).catch(e => { patch(prev); setErr((e as Error).message); });
  };

  const fileSet = (setDbId: string, chId: string) => {
    setSets(ss => ss.map(s => s.set_id === setDbId ? { ...s, chapter_id: chId || null } : s));
    api.mathSetChapter(setDbId, chId || null).then(() => { if (topTab === 'curriculum') reloadSetsFresh(); })
      .catch(e => { setErr((e as Error).message); reloadSetsFresh(); });
  };
  const fileMaterial = (id: string, chId: string) => {
    setMaterials(ms => ms.map(m => m.id === id ? { ...m, chapter_id: chId || null } : m));
    api.mathStudyPatch(id, { chapter_id: chId || null }).then(() => { if (topTab === 'curriculum') loadMaterials(true); })
      .catch(e => { setErr((e as Error).message); loadMaterials(true); });
  };

  // ---------- set table ----------
  const setCols = isTest ? '160px 150px 120px 100px 150px 200px minmax(230px,1fr)' : '160px 150px 120px 100px 200px minmax(230px,1fr)';
  const setMinWidth = isTest ? 1020 : 880;
  const renderSetTable = () => (
    <div style={{ ...card, overflowX: 'auto' }}>
      <div style={{ minWidth: setMinWidth, display: 'grid', gridTemplateColumns: setCols, gap: 12, padding: '13px 20px', background: 'var(--card2,#F4F7FC)', fontSize: 12, fontWeight: 800, letterSpacing: '.5px', color: muted }}>
        <span>SET</span><span>QUESTIONS</span><span>STATUS</span><span>UPDATED</span>{isTest && <span>TIME LIMIT (MIN)</span>}<span>FOLDER</span><span style={{ textAlign: 'right' }}>ACTIONS</span>
      </div>
      {loading ? <div className="muted" style={{ padding: 22 }}>Loading…</div>
        : setRows.length === 0 ? <div className="muted" style={{ padding: 28, textAlign: 'center' }}>No {setTrack === 'test' ? 'test papers' : 'quizzes'} yet{topTab === 'curriculum' && curChapter ? ` in ${curChapter.name}` : ''}. Use Bulk add sets or Upload set.</div>
        : setRows.map((s, i) => {
          const q = s.question_count ?? 0; const pct = Math.max(2, Math.min(100, q)) + '%';
          const published = s.state === 'published'; const busy = busyId === s.set_version_id;
          return (
            <div key={s.set_version_id} style={{ minWidth: setMinWidth, display: 'grid', gridTemplateColumns: setCols, gap: 12, padding: '15px 20px', borderBottom: '1px solid var(--line,#F3F5FA)', alignItems: 'center', background: i % 2 ? 'var(--card2,#FBFCFE)' : 'var(--card,#fff)' }}>
              <span style={{ minWidth: 0 }}>
                <span onClick={() => { if (tax) setEditId(s.set_version_id); }} title="Open to view / edit" style={{ display: 'block', fontSize: 15, fontWeight: 800, color: '#1A5EAB', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: tax ? 'pointer' : 'default' }}>{s.name}</span>
                <span style={{ display: 'block', fontSize: 12, color: '#98A2B6', marginTop: 3 }}>{s.folder}{s.subfolder ? ` · ${s.subfolder}` : ''}</span>
              </span>
              <span>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: '#D4620E' }}>{q} / 100</span>
                <span style={{ display: 'block', height: 6, borderRadius: 999, background: '#E3E8F0', marginTop: 6, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: pct, borderRadius: 999, background: '#E8A020' }} /></span>
              </span>
              <span><span style={badgeStyle(s.state)}>{(BADGE[s.state] || BADGE.draft).label}</span></span>
              <span style={{ fontSize: 13.5, color: muted }}>{fmtDate(s.updated_at)}</span>
              {isTest && <span><TimeLimitCell value={s.duration_minutes ?? 30} onCommit={(n) => commitDuration(s.set_version_id, n)} /></span>}
              <span><ChapterSelect value={s.chapter_id || ''} chapters={chapters} onChange={(v) => fileSet(s.set_id, v)} disabled={busy} /></span>
              <span style={{ display: 'flex', gap: 7, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {actBtn('Edit', () => setEditId(s.set_version_id), 'default', busy || !tax)}
                {actBtn(published ? 'Retire' : 'Publish', () => actSet(() => published ? api.retireSet(s.set_version_id) : api.publishSet(s.set_version_id), s.set_version_id), published ? 'warn' : 'primary', busy)}
                {actBtn('Delete', () => actSet(() => api.deleteSet(s.set_version_id), s.set_version_id), 'danger', busy)}
              </span>
            </div>
          );
        })}
    </div>
  );

  // ---------- material table ----------
  const matCols = '300px 90px 100px 100px 200px minmax(230px,1fr)';
  const matMinWidth = 1020;
  const renderMaterialTable = () => (
    <div style={{ ...card, overflowX: 'auto' }}>
      <div style={{ minWidth: matMinWidth, display: 'grid', gridTemplateColumns: matCols, gap: 12, padding: '13px 20px', background: 'var(--card2,#F4F7FC)', fontSize: 12, fontWeight: 800, letterSpacing: '.5px', color: muted }}>
        <span>MATERIAL</span><span>TYPE</span><span>SIZE</span><span>UPDATED</span><span>FOLDER</span><span style={{ textAlign: 'right' }}>ACTIONS</span>
      </div>
      {loading ? <div className="muted" style={{ padding: 22 }}>Loading…</div>
        : materialRows.length === 0 ? <div className="muted" style={{ padding: 28, textAlign: 'center' }}>No study material yet{topTab === 'curriculum' && curChapter ? ` in ${curChapter.name}` : ''}. Use + Add material to upload a PDF or PPT.</div>
        : materialRows.map((m, i) => {
          const isPdf = (m.source_kind || 'pdf') === 'pdf';
          const busy = busyId === m.id; const ready = m.render_state === 'ready'; const published = m.state === 'published';
          return (
            <div key={m.id} style={{ minWidth: matMinWidth, display: 'grid', gridTemplateColumns: matCols, gap: 12, padding: '15px 20px', borderBottom: '1px solid var(--line,#F3F5FA)', alignItems: 'center', background: i % 2 ? 'var(--card2,#FBFCFE)' : 'var(--card,#fff)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                <span style={{ flex: 'none', width: 38, height: 38, borderRadius: 9, background: isPdf ? '#C62828' : '#E07A1A', color: '#fff', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isPdf ? 'PDF' : 'PPT'}</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 14.5, fontWeight: 800, color: 'var(--ink,#15233D)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</span>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 3 }}>
                    <span style={{ fontSize: 12, color: '#98A2B6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 170 }}>{m.description || m.file_name}</span>
                    {m.render_state === 'processing' && <span style={{ fontSize: 11, fontWeight: 700, color: '#B4540C' }}>⏳ Processing…</span>}
                    {m.render_state === 'failed' && <span title={m.render_error || ''} style={{ fontSize: 11, fontWeight: 700, color: '#B4231B' }}>⚠ Failed</span>}
                    {ready && <span style={badgeStyle(m.state)}>{(BADGE[m.state] || BADGE.draft).label}</span>}
                  </span>
                </span>
              </span>
              <span><span style={{ fontSize: 11.5, fontWeight: 800, padding: '5px 10px', borderRadius: 999, background: isPdf ? '#EAF1FB' : '#FDF0E6', color: isPdf ? '#1A5EAB' : '#B2460B' }}>{isPdf ? 'PDF' : 'PPT'}</span></span>
              <span style={{ fontSize: 13.5, color: muted }}>{fmtSize(m.byte_size)}{ready && m.page_count ? ` · ${m.page_count}p` : ''}</span>
              <span style={{ fontSize: 13.5, color: muted }}>{fmtDate(m.updated_at || m.created_at)}</span>
              <span><ChapterSelect value={m.chapter_id || ''} chapters={chapters} onChange={(v) => fileMaterial(m.id, v)} disabled={busy} /></span>
              <span style={{ display: 'flex', gap: 7, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {actBtn('Preview', () => setPreview({ id: m.id, title: m.title, pages: m.page_count || 0 }), 'default', busy || !ready)}
                {!ready
                  ? actBtn('Reprocess', () => actMaterial(() => api.mathStudyReprocess(m.id), m.id), 'default', busy)
                  : actBtn(published ? 'Retire' : 'Publish', () => actMaterial(() => published ? api.mathStudyRetire(m.id) : api.mathStudyPublish(m.id), m.id), published ? 'warn' : 'primary', busy)}
                {actBtn('Delete', () => actMaterial(() => api.mathStudyDelete(m.id), m.id), 'danger', busy)}
              </span>
            </div>
          );
        })}
    </div>
  );

  // Toolbar above a set/material table (bulk/upload or add material).
  const crumb = (root: string, child: string) => (
    <div style={{ flex: 1, minWidth: 200, fontSize: 15, color: muted }}>
      {root} <span style={{ color: '#C8D0DE' }}>→</span> <span style={{ color: 'var(--ink,#15233D)', fontWeight: 800 }}>{child}</span>
    </div>
  );
  const perSetControl = (
    <span title="Remembered default — pre-fills Questions per set in Bulk add sets" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none', background: 'var(--card2,#F7F9FD)', border: '1px solid var(--line,#E6EAF2)', borderRadius: 12, padding: '5px 10px' }}>
      <span className="muted" style={{ fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', fontWeight: 700 }}>Default per set</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', border: '1.5px solid var(--line,#E6EAF2)', borderRadius: 9, overflow: 'hidden', background: 'var(--card,#fff)' }}>
        <button type="button" className="btn ghost sm" style={{ border: 0, borderRadius: 0, width: 30 }} disabled={defPerSet <= 1} onClick={() => setDefault(defPerSet - 5)}>−</button>
        <input type="text" inputMode="numeric" pattern="[0-9]*" value={defPerSet} onChange={e => setDefault(Number(e.target.value.replace(/\D/g, '')))}
          style={{ width: 56, textAlign: 'center', border: 0, borderLeft: '1px solid var(--line,#E6EAF2)', borderRight: '1px solid var(--line,#E6EAF2)', borderRadius: 0, fontWeight: 700, fontSize: 14 }} />
        <button type="button" className="btn ghost sm" style={{ border: 0, borderRadius: 0, width: 30 }} disabled={defPerSet >= PER_SET_CEILING} onClick={() => setDefault(defPerSet + 5)}>+</button>
      </span>
    </span>
  );
  const setToolbar = (rootLabel: string) => {
    const canBulk = !!defaultCatId && !!tax;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {crumb(rootLabel, topTab === 'curriculum' ? (curChapter?.name || '—') + ` · ${setTrack === 'test' ? 'Tests' : 'Quiz Arena'}` : (setTrack === 'test' ? 'All test papers' : 'All quizzes'))}
        {perSetControl}
        {actBtn('⤓ Bulk add sets', () => { if (canBulk) setBulk(true); }, 'default', !canBulk)}
        <button onClick={() => setNewSet(true)} disabled={!defaultCatId} style={{ height: 40, padding: '0 20px', flex: 'none', border: 0, borderRadius: 10, background: defaultCatId ? '#1A5EAB' : '#9FB2CC', color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: defaultCatId ? 'pointer' : 'not-allowed' }}>Upload set</button>
      </div>
    );
  };
  const studyToolbar = (rootLabel: string, child: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
      {crumb(rootLabel, child)}
      <button onClick={() => loadMaterials(false)} style={{ height: 40, padding: '0 14px', flex: 'none', border: '1px solid var(--line,#D7DEEA)', borderRadius: 999, background: 'var(--card,#fff)', fontSize: 13, fontWeight: 700, cursor: 'pointer', color: 'var(--ink,#15233D)' }}>↻ Refresh</button>
      <button onClick={() => setAddMaterial(true)} style={{ height: 40, padding: '0 20px', flex: 'none', border: 0, borderRadius: 10, background: '#1A5EAB', color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>+ Add material</button>
    </div>
  );

  // ---------- render ----------
  return (
    <div style={{ padding: '2px' }}>
      {/* Tabs + Grade card */}
      <div style={{ ...card, padding: '0 0 0 6px', marginBottom: 20, display: 'flex', alignItems: 'stretch', gap: 10, overflow: 'visible' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', gap: 18, overflowX: 'auto', padding: '0 10px' }}>
          {TOP_TABS.map(t => {
            const on = t.k === topTab;
            return (
              <button key={t.k} onClick={() => setTopTab(t.k)}
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

      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      {topTab === 'curriculum' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
          {/* Chapters (folders) panel */}
          <div style={{ ...card, flex: '1 1 260px', minWidth: 240, maxWidth: 300, padding: 12, maxHeight: 'calc(100vh - 230px)', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px 10px 12px' }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '1px', color: '#98A2B6' }}>FOLDERS</span>
              <button onClick={() => setAddFolder(true)} title="Add chapter" aria-label="Add chapter"
                style={{ width: 28, height: 28, flex: 'none', border: '1px solid var(--line,#E6EAF2)', borderRadius: 8, background: 'var(--card,#fff)', color: 'var(--primary,#1A5EAB)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
              </button>
            </div>
            {chapters.length === 0 && <div className="muted" style={{ padding: '6px 12px', fontSize: 13 }}>No chapters yet. Add one to start.</div>}
            {chapters.map(c => {
              const on = c.id === chapterId;
              return (
                <button key={c.id} onClick={() => setChapterId(c.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '11px 12px', marginBottom: 3, border: 0, borderRadius: 10, cursor: 'pointer', fontSize: 14, background: on ? '#1A5EAB' : 'transparent', color: on ? '#fff' : '#44506A', fontWeight: on ? 800 : 500 }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="M3 7l4-3h5l2 2h7v14H3z" /></svg>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                </button>
              );
            })}
          </div>

          {/* Chapter content: sub-tabs + table */}
          <div style={{ flex: '999 1 560px', minWidth: 0 }}>
            {!chapterId ? (
              <div style={{ ...card, padding: 28 }} className="muted">Select a chapter on the left, or add one, to manage its Study Material, Tests and Quiz Arena.</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                  {(['study', 'test', 'quiz'] as SubTab[]).map(st => {
                    const on = st === subTab; const label = st === 'study' ? 'Study Material' : st === 'test' ? 'Tests' : 'Quiz Arena';
                    return (
                      <button key={st} onClick={() => setSubTab(st)}
                        style={{ height: 40, padding: '0 20px', border: on ? 0 : '1px solid var(--line,#D7DEEA)', borderRadius: 999, background: on ? '#1A5EAB' : 'var(--card,#fff)', color: on ? '#fff' : 'var(--ink,#15233D)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}>
                        {label}
                      </button>
                    );
                  })}
                </div>
                {subTab === 'study'
                  ? (<>{studyToolbar('Curriculum', `${curChapter?.name || '—'} · Study Material`)}{renderMaterialTable()}</>)
                  : (<>{setToolbar('Curriculum')}{renderSetTable()}</>)}
              </>
            )}
          </div>
        </div>
      ) : topTab === 'study' ? (
        <div>{studyToolbar('Study Material', 'All materials')}{renderMaterialTable()}</div>
      ) : (
        <div>{setToolbar(topTab === 'test' ? 'Tests' : 'Quiz Arena')}{renderSetTable()}</div>
      )}

      {/* Modals */}
      {editId && tax && <SetEditor taxonomy={tax} setId={editId} onClose={() => setEditId('')} onSaved={() => { setEditId(''); reloadSetsFresh(); }} />}
      {bulk && tax && defaultCatId && setTrack && (() => {
        const med = (tax.difficulties || []).find((d: any) => d.key === 'medium') || (tax.difficulties || [])[0];
        const taxCat = (tax.categories || []).find((c: any) => c.id === defaultCatId);
        if (!curGrade || !med) return null;
        return (
          <BulkSets
            ctx={{
              gradeId: curGrade.id, catId: defaultCatId, subId: '', diffId: med.id, qType: 'math',
              gradeNumber: curGrade.grade_number, categoryName: taxCat?.name || (setTrack === 'test' ? 'All test papers' : 'All quizzes'),
              subcategoryName: 'All sets', difficultyLabel: med.name || 'Medium', diffKey: med.key || 'medium',
              maxPerSet: PER_SET_CEILING, chapterId: fileChapter,
            }}
            existingSets={setRows} taxonomy={tax} exam={setTrack === 'test'}
            onClose={() => { setBulk(false); reloadSetsFresh(); }} onDone={reloadSetsFresh}
          />
        );
      })()}
      {addFolder && <AddFolderModal gradeId={gradeId} onClose={() => setAddFolder(false)} onDone={() => { setAddFolder(false); reloadChaptersFresh(); }} />}
      {newSet && setTrack && (
        <NewSetModal track={setTrack} gradeId={gradeId} categoryId={defaultCatId} chapterId={fileChapter}
          onClose={() => setNewSet(false)} onDone={() => { setNewSet(false); reloadSetsFresh(); }} />
      )}
      {addMaterial && (
        <AddMaterialModal gradeId={gradeId} chapters={chapters} defaultChapterId={fileChapter}
          onClose={() => setAddMaterial(false)} onDone={() => { setAddMaterial(false); loadMaterials(false); }} />
      )}
      {preview && <PreviewModal materialId={preview.id} title={preview.title} pages={preview.pages} onClose={() => setPreview(null)} />}
    </div>
  );
}

function Modal({ title, children, footer, onClose, wide }: { title: string; children: React.ReactNode; footer: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,27,51,.35)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: wide ? 'min(900px,100%)' : 'min(460px,100%)', background: 'var(--card,#fff)', borderRadius: 16, boxShadow: '0 24px 60px rgba(0,0,0,.25)', overflow: 'hidden', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line,#eef1f6)', fontWeight: 800, fontSize: 16 }}>{title}</div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>{children}</div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--line,#eef1f6)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>{footer}</div>
      </div>
    </div>
  );
}

function AddFolderModal({ gradeId, onClose, onDone }: { gradeId: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => { if (!name.trim()) return; setBusy(true); setErr('');
    try { await api.mathCreateFolder({ track: 'curriculum', grade_id: gradeId, name: name.trim() }); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); } };
  return (
    <Modal title="Add chapter" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Adding…' : 'Add chapter'}</button></>}>
      <label style={{ fontWeight: 700, fontSize: 13 }}>Chapter name</label>
      <input autoFocus style={inputS} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Number System" onKeyDown={e => { if (e.key === 'Enter') save(); }} />
      {err && <div className="err">{err}</div>}
    </Modal>
  );
}

function NewSetModal({ track, gradeId, categoryId, chapterId, onClose, onDone }: { track: SetTrack; gradeId: string; categoryId: string; chapterId: string | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => {
    if (!name.trim() || !categoryId) return; setBusy(true); setErr('');
    try { await api.mathCreateSet({ track, grade_id: gradeId, category_id: categoryId, chapter_id: chapterId, name: name.trim() }); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title={`Upload ${track === 'test' ? 'test paper' : 'quiz'}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !name.trim() || !categoryId} onClick={save}>{busy ? 'Creating…' : 'Create set'}</button></>}>
      <label style={{ fontWeight: 700, fontSize: 13 }}>Set name</label>
      <input autoFocus style={inputS} value={name} onChange={e => setName(e.target.value)} placeholder={track === 'test' ? 'e.g. Test Paper 1' : 'e.g. Quiz 1'} onKeyDown={e => { if (e.key === 'Enter') save(); }} />
      {!categoryId && <div className="err">No default folder yet for this grade. Switch to this tab once to create it, then retry.</div>}
      {err && <div className="err">{err}</div>}
    </Modal>
  );
}

function AddMaterialModal({ gradeId, chapters, defaultChapterId, onClose, onDone }: { gradeId: string; chapters: any[]; defaultChapterId: string | null; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [chapter, setChapter] = useState<string>(defaultChapterId || '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const pick = (f: File | null) => { setFile(f); if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, '')); };
  const save = async () => {
    if (!file || !title.trim()) return; setBusy(true); setErr('');
    try {
      await api.mathStudyUpload(file, { grade_id: gradeId, chapter_id: chapter || null, title: title.trim(), description: desc.trim() || null });
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="Add material" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !file || !title.trim()} onClick={save}>{busy ? 'Uploading…' : 'Upload'}</button></>}>
      <label style={{ fontWeight: 700, fontSize: 13 }}>File (PDF, PPT or PPTX)</label>
      <input type="file" accept=".pdf,.ppt,.pptx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        onChange={e => pick(e.target.files?.[0] || null)} style={{ fontSize: 13 }} />
      <label style={{ fontWeight: 700, fontSize: 13 }}>Title</label>
      <input style={inputS} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Chapter 1 — Concept Notes" />
      <label style={{ fontWeight: 700, fontSize: 13 }}>Description <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
      <input style={inputS} value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. Teaching notes · 18 pages" />
      <label style={{ fontWeight: 700, fontSize: 13 }}>Folder (chapter)</label>
      <select style={inputS} value={chapter} onChange={e => setChapter(e.target.value)}>
        <option value="">{NO_FOLDER}</option>
        {chapters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <div className="muted" style={{ fontSize: 12 }}>View-only for students. The file is converted to watermarked page images on our server — the original is never downloadable. Large files upload directly and may take a moment to finish processing.</div>
      {err && <div className="err">{err}</div>}
    </Modal>
  );
}

function PreviewModal({ materialId, title, pages, onClose }: { materialId: string; title: string; pages: number; onClose: () => void }) {
  const [n, setN] = useState(1);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  useEffect(() => {
    let revoked = false; let objUrl = '';
    setLoading(true); setErr('');
    api.mathStudyPageUrl(materialId, n).then(u => { if (revoked) { URL.revokeObjectURL(u); return; } objUrl = u; setUrl(u); })
      .catch(e => setErr((e as Error).message)).finally(() => setLoading(false));
    return () => { revoked = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [materialId, n]);
  const total = Math.max(1, pages || 1);
  return (
    <Modal title={`${title} — page ${n} / ${total}`} onClose={onClose} wide
      footer={<>
        <button className="btn ghost" disabled={n <= 1} onClick={() => setN(x => Math.max(1, x - 1))}>← Prev</button>
        <button className="btn ghost" disabled={n >= total} onClick={() => setN(x => Math.min(total, x + 1))}>Next →</button>
        <button className="btn" onClick={onClose}>Close</button>
      </>}>
      <div style={{ minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--card2,#F4F7FC)', borderRadius: 12, padding: 12 }}>
        {loading ? <span className="muted">Loading page…</span>
          : err ? <span className="err">{err}</span>
          : url ? <img src={url} alt={`Page ${n}`} style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 6, boxShadow: '0 2px 10px rgba(15,27,51,.12)' }} />
          : null}
      </div>
    </Modal>
  );
}
