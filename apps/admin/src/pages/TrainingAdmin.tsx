import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { parseTrainingText, moduleToTxt, TXT_TEMPLATE, DEFAULT_QPM, type ParsedModule } from '../lib/trainingImport';

// TeacherHub admin — Learning modules (simplified). Content (title/minutes/description/body) is authored
// in a .txt the admin downloads, fills and uploads; the icon is a prebuilt-symbol picker; questions are
// added in the panel. List rows open the editor on click; drag to reorder.
interface Quiz { q: string; opts: string[]; answer: number }
interface Module {
  id: number; title: string; icon: string | null; duration_mins: number | null;
  description: string | null; body_html: string | null; quiz: Quiz[] | null;
  questions_per_module?: number; sort_order: number; active: boolean; question_count?: number;
}
type Draft = { id?: number; title: string; icon: string; duration_mins: number; description: string; body_html: string; quiz: Quiz[]; active: boolean };

const navy = 'var(--brand,#1c3f6e)';
const inp: React.CSSProperties = { padding: '9px 11px', border: '1px solid var(--line,#d7dce8)', borderRadius: 9, background: 'var(--card2,#f7f9fc)', color: 'inherit', font: 'inherit' };
const btnP: React.CSSProperties = { ...inp, cursor: 'pointer', fontWeight: 800, background: 'var(--brand,#2f6fd0)', color: '#fff', border: 'none' };
const btnG: React.CSSProperties = { ...inp, cursor: 'pointer', fontWeight: 700 };
const ICONS = ['🎓', '📘', '📗', '📋', '🖥️', '💬', '📝', '🗂️', '🧭', '⭐', '✅', '📅', '🧑‍🏫', '🔔', '🎯', '🛡️'];
const blankQ = (): Quiz => ({ q: '', opts: ['', ''], answer: 0 });
const padQuiz = (q: Quiz[], n: number): Quiz[] => { const out = q.slice(); while (out.length < n) out.push(blankQ()); return out; };
const newDraft = (qpm: number = DEFAULT_QPM): Draft => ({ title: '', icon: '🎓', duration_mins: 5, description: '', body_html: '', quiz: padQuiz([], qpm), active: true });

function Crumb({ leaf }: { leaf?: string }) {
  // Render the breadcrumb tail into the top bar, right after the "Training" title.
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => { setNode(document.getElementById('th-crumb')); }, []);
  const linkS: React.CSSProperties = { color: 'var(--brand,#2f6fd0)', textDecoration: 'none', fontWeight: 700 };
  const tail = (
    <span style={{ fontSize: 13, color: 'var(--muted,#647089)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
      <span style={{ margin: '0 6px', opacity: .7 }}>/</span>
      {leaf ? <Link to="/teacherhub/training/modules" style={linkS}>Learning modules</Link> : <b style={{ color: 'var(--ink,inherit)' }}>Learning modules</b>}
      {leaf && <><span style={{ margin: '0 6px', opacity: .7 }}>/</span><b style={{ color: 'var(--ink,inherit)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>{leaf}</b></>}
    </span>
  );
  if (node) return createPortal(tail, node);
  return (
    <div style={{ fontSize: 12.5, color: 'var(--muted,#647089)', marginBottom: 6 }}>
      <Link to="/teacherhub/training" style={linkS}>Training</Link>{tail}
    </div>
  );
}

export function TrainingAdmin() {
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'list' | 'edit'>('list');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [importMode, setImportMode] = useState<'txt' | 'pptx'>('txt');
  const [pageQpm, setPageQpm] = useState<number>(() => { try { const v = Number(localStorage.getItem('th_qpm_default')); return Number.isFinite(v) && v > 0 ? Math.min(50, v) : DEFAULT_QPM; } catch { return DEFAULT_QPM; } });
  const setPageQpmClamped = (n: number) => { const v = Math.max(1, Math.min(50, n)); setPageQpm(v); try { localStorage.setItem('th_qpm_default', String(v)); } catch { /* ignore */ } };
  const [bulkStep, setBulkStep] = useState<'paste' | 'preview'>('paste');
  const [bulkPreview, setBulkPreview] = useState<Array<ParsedModule & { icon: string }>>([]);
  const [iconOpen, setIconOpen] = useState<number | null>(null);
  const [qMode, setQMode] = useState<'page' | 'file'>(() => { try { return localStorage.getItem('th_q_mode') === 'file' ? 'file' : 'page'; } catch { return 'page'; } });
  const setQModeP = (mo: 'page' | 'file') => { setQMode(mo); try { localStorage.setItem('th_q_mode', mo); } catch { /* ignore */ } };
  const effQpm = (m: ParsedModule): number => (qMode === 'file' ? (m.questions_per_module ?? ((m.quiz || []).length || pageQpm)) : pageQpm);
  const [pasteText, setPasteText] = useState('');
  const [showFormat, setShowFormat] = useState(false);
  const [copied2, setCopied2] = useState(false);
  const [parseChk, setParseChk] = useState<any>(null);
  const [pptxBusy2, setPptxBusy2] = useState(false);
  const [contentMsg, setContentMsg] = useState('');
  const [pptxBusy, setPptxBusy] = useState(false);
  const [pptxMsg, setPptxMsg] = useState('');
  const [dragIx, setDragIx] = useState<number | null>(null);

  const load = () => { setLoading(true); api.trainingModules().then(r => setModules(r.modules as Module[])).catch(e => setErr(e.message)).finally(() => setLoading(false)); };
  useEffect(load, []);
  // Browser Back closes the editor instead of leaving the page.
  useEffect(() => {
    const onPop = () => { setView('list'); setEditing(null); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const openEditor = (m: Module | null) => {
    if (!canManage) return;
    setEditing(m ? { id: m.id, title: m.title, icon: m.icon || '🎓', duration_mins: m.duration_mins ?? 0, description: m.description || '', body_html: m.body_html || '', quiz: padQuiz((m.quiz || []) as Quiz[], Math.max(m.questions_per_module ?? (m.quiz?.length || 0), m.quiz?.length || 0) || DEFAULT_QPM), active: m.active }
      : newDraft(pageQpm));
    setView('edit'); setBulkOpen(false);
    try { window.history.pushState({ te: 1 }, ''); } catch { /* ignore */ }
    window.scrollTo(0, 0);
  };
  const closeEditor = () => { try { window.history.back(); } catch { setView('list'); setEditing(null); } };

  const parsed = useMemo(() => (bulkText.trim() ? parseTrainingText(bulkText) : null), [bulkText]);

  const save = async () => {
    if (!editing) return;
    if (!editing.title.trim()) { setErr('This module has no title — upload a .txt with a >> TITLE line first.'); return; }
    const quiz = editing.quiz.filter(q => q.q.trim()).map(q => ({ q: q.q.trim(), opts: q.opts.map(o => o.trim()).filter(Boolean), answer: q.answer }));
    for (const q of quiz) { if (q.opts.length < 2) { setErr('Every question needs at least 2 options.'); return; } if (q.answer >= q.opts.length) { setErr('Pick a correct answer for every question.'); return; } }
    setBusy(true); setErr('');
    const body = { title: editing.title.trim(), icon: editing.icon, duration_mins: editing.duration_mins, description: editing.description, body_html: editing.body_html, quiz, questions_per_module: editing.quiz.length, active: editing.active };
    try { if (editing.id) await api.trainingUpdateModule(editing.id, body); else await api.trainingCreateModule(body); load(); closeEditor(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async (m: Module) => {
    if (!window.confirm(`Delete "${m.title}"? Teachers' progress on it is also removed. This cannot be undone.`)) return;
    setBusy(true); setErr('');
    try { await api.trainingDeleteModule(m.id); load(); if (editing?.id === m.id) closeEditor(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const toggleActive = async (m: Module) => { setBusy(true); try { await api.trainingUpdateModule(m.id, { active: !m.active }); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };

  const doReorder = async (from: number, to: number) => {
    if (from === to) return;
    const next = modules.slice(); const [it] = next.splice(from, 1); next.splice(to, 0, it); setModules(next);
    try { await api.trainingReorder(next.map(m => m.id)); } catch (e: any) { setErr(e.message); load(); }
  };

  const startPreview = () => {
    if (!parsed || !parsed.ok) return;
    setBulkPreview(parsed.modules.map(m => ({ ...m, icon: '🎓' })));
    setIconOpen(null); setBulkStep('preview');
  };
  const createBulk = async () => {
    setBusy(true); setErr('');
    try { const r = await api.trainingBulkCreate(bulkPreview.map(m => ({ ...m, questions_per_module: effQpm(m) })) as unknown as ParsedModule[]); setBulkText(''); setBulkPreview([]); setBulkStep('paste'); setBulkOpen(false); load(); setErr(`Imported ${r.created} module(s).`); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const readFile = (f: File | undefined, into: (t: string) => void) => { if (!f) return; const rd = new FileReader(); rd.onload = () => into(String(rd.result || '')); rd.readAsText(f); };
  const download = (name: string, text: string) => { const b = new Blob([text], { type: 'text/plain' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u); };
  // ---- PowerPoint import → deterministic interactive course + questions ----
  const readPptx = async (f?: File) => {
    if (!f) return;
    if (!/\.pptx$/i.test(f.name)) { setErr('Please choose a .pptx file.'); return; }
    setPptxBusy(true); setPptxMsg('Reading slides…'); setErr('');
    try {
      const b64 = await new Promise<string>((res, rej) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result || '').split(',')[1] || ''); rd.onerror = () => rej(new Error('Could not read the file.')); rd.readAsDataURL(f); });
      setPptxMsg('Processing PowerPoint — building interactions and questions…');
      const r = await api.trainingCreateFromPptx(f.name, b64) as { module: Module; slideCount: number; sectionCount: number; questionCount: number; warnings?: string[] };
      setPptxBusy(false); setPptxMsg(''); setBulkOpen(false); load();
      setErr(`Imported “${r.module.title}” — ${r.slideCount} slides → ${r.sectionCount} sections, ${r.questionCount} questions.${(r.warnings && r.warnings.length) ? ' Note: ' + r.warnings.join(' ') : ''}`);
      openEditor(r.module);
    } catch (e) { setPptxBusy(false); setPptxMsg(''); setErr((e as Error).message || 'Could not process the PowerPoint.'); }
  };

  // ---- content .txt upload → fill draft ----
  const applyTxt = (text: string) => {
    const r = parseTrainingText(text);
    if (!r.ok) { setErr('Content file: ' + r.errors.slice(0, 3).join(' · ')); return; }
    const m = r.modules[0]; if (!m || !editing) return;
    setErr('');
    setEditing({ ...editing, title: m.title, duration_mins: m.duration_mins ?? 0, description: m.description || '', body_html: m.body_html || '',
      quiz: m.quiz.length ? padQuiz(m.quiz as Quiz[], m.questions_per_module) : padQuiz(editing.quiz.filter(q => q.q.trim()), m.questions_per_module) });
  };
  const copyFormat = () => { try { navigator.clipboard.writeText(TXT_TEMPLATE); setCopied2(true); setTimeout(() => setCopied2(false), 1500); } catch { /* ignore */ } };
  const parseCheck = () => { setContentMsg(''); setParseChk(pasteText.trim() ? parseTrainingText(pasteText) : null); };
  const applyPaste = () => { applyTxt(pasteText); setParseChk(null); setPasteText(''); setContentMsg('✓ Applied to this module. Review and Save.'); };
  const replaceFromPptx = async (f: File) => {
    if (!editing?.id) { setErr('Save the module first, then upload a PowerPoint to replace its content.'); return; }
    setPptxBusy2(true); setContentMsg(''); setErr('');
    try {
      const b64 = await new Promise<string>((res, rej) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result || '').split(',')[1] || ''); rd.onerror = () => rej(new Error('Could not read the file.')); rd.readAsDataURL(f); });
      const r = await api.trainingReplaceFromPptx(editing.id, f.name, b64) as { module: Module; slideCount: number; sectionCount: number; questionCount: number; warnings?: string[] };
      setPptxBusy2(false); openEditor(r.module); load();
      setContentMsg(`✓ Replaced from “${f.name}” — ${r.slideCount} slides → ${r.sectionCount} sections, ${r.questionCount} questions.${(r.warnings && r.warnings.length) ? ' Note: ' + r.warnings.join(' ') : ''}`);
    } catch (e) { setPptxBusy2(false); setErr((e as Error).message || 'Could not process the PowerPoint.'); }
  };
  const chooseContentFile = (f?: File) => {
    if (!f) return;
    if (/\.pptx?$/i.test(f.name)) { replaceFromPptx(f); return; }
    readFile(f, t => { setPasteText(t); setParseChk(parseTrainingText(t)); setContentMsg(''); });
  };

  // ---- quiz builder ----
  const setQ = (i: number, patch: Partial<Quiz>) => setEditing(e => e ? { ...e, quiz: e.quiz.map((q, x) => x === i ? { ...q, ...patch } : q) } : e);
  const setQpm = (delta: number) => setEditing(e => { if (!e) return e; const n = Math.max(0, Math.min(50, e.quiz.length + delta)); let quiz = e.quiz.slice(); if (n > quiz.length) quiz = padQuiz(quiz, n); else quiz = quiz.slice(0, n); return { ...e, quiz }; });
  const setOpt = (i: number, oi: number, v: string) => setQ(i, { opts: editing!.quiz[i].opts.map((o, x) => x === oi ? v : o) });
  const addOpt = (i: number) => { const q = editing!.quiz[i]; if (q.opts.length < 6) setQ(i, { opts: [...q.opts, ''] }); };
  const rmOpt = (i: number, oi: number) => { const q = editing!.quiz[i]; if (q.opts.length <= 2) return; const opts = q.opts.filter((_, x) => x !== oi); setQ(i, { opts, answer: Math.min(q.answer, opts.length - 1) }); };

  const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted,#647089)', padding: '10px 14px', borderBottom: '1px solid var(--line,#e6e6ef)', background: 'var(--card2,#f7f9fc)' };

  // ---------- EDITOR ----------
  if (view === 'edit' && editing) {
    return (
      <div style={{ display: 'grid', gap: 14 }}>
        <Crumb leaf={editing.title || 'New module'} />
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ marginRight: 'auto' }}>
            <h2 style={{ margin: '0 0 2px', fontSize: 21, fontWeight: 900, letterSpacing: '-.02em', color: navy }}>{editing.id ? 'Edit module' : 'New module'}</h2>
            <div className="muted" style={{ fontSize: 13 }}>Set the module name, pick a symbol, add content and questions.</div>
          </div>
          <button style={btnG} onClick={closeEditor}>← Back</button>
        </div>
        {err && <div className="empty" style={{ padding: 10, color: err.startsWith('Imported') ? 'var(--good,#0f9d6b)' : 'var(--coral,#c0392b)' }}>{err}</div>}

        {/* module name */}
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--muted,#647089)', marginBottom: 6, fontWeight: 700 }}>Module name</label>
          <input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} placeholder="e.g. Session Conduct & Professionalism" style={{ ...inp, width: '100%', fontWeight: 700, fontSize: 15 }} />
        </section>

        {/* symbol + questions count + active */}
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16, display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 5 }}>Symbol</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', maxWidth: 380 }}>
              {ICONS.map(ic => <button key={ic} onClick={() => setEditing({ ...editing, icon: ic })} style={{ width: 42, height: 42, borderRadius: 10, cursor: 'pointer', fontSize: 20, background: editing.icon === ic ? 'var(--brand-soft,#e7f0fc)' : '#fff', border: '1px solid ' + (editing.icon === ic ? 'var(--brand,#2f6fd0)' : 'var(--line,#e6e6ef)') }}>{ic}</button>)}
            </div>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 22 }}>
            <input type="checkbox" checked={editing.active} onChange={e => setEditing({ ...editing, active: e.target.checked })} /> Visible to teachers
          </label>
        </section>

        {/* content: bulk-add style (.txt / .md / .pptx) */}
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <div style={{ fontWeight: 800, color: navy, fontSize: 14, marginBottom: 4 }}>Lesson content</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>Paste the module content or choose a file. Title, minutes, description, lesson body and questions are read from it. A <b>.pptx</b> replaces this module with an auto-built interactive lesson + questions.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button style={btnG} onClick={() => download('module_template.txt', editing.title ? moduleToTxt({ ...editing, questions_per_module: editing.quiz.length, quiz: editing.quiz.filter(q => q.q.trim()) }) : TXT_TEMPLATE)}>⬇ Download sample</button>
            <button style={btnG} onClick={copyFormat}>⧉ {copied2 ? 'Copied' : 'Copy format'}</button>
            <button style={btnG} onClick={() => setShowFormat(v => !v)}>👁 {showFormat ? 'Hide format' : 'View format'}</button>
            <label style={{ ...btnG, display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>📄 Choose file… (.txt / .md / .pptx)<input type="file" accept=".txt,.md,.pptx,text/plain,application/vnd.openxmlformats-officedocument.presentationml.presentation" style={{ display: 'none' }} onChange={e => chooseContentFile(e.target.files?.[0])} /></label>
            <button style={{ ...btnP, marginLeft: 'auto' }} onClick={parseCheck}>Parse &amp; check</button>
          </div>
          {showFormat && <pre style={{ ...inp, marginTop: 10, background: '#fff', maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{TXT_TEMPLATE}</pre>}
          {pptxBusy2 && <div style={{ marginTop: 12, color: navy, fontWeight: 700, fontSize: 13 }}>⏳ Processing PowerPoint — replacing this module’s content…</div>}
          <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="Paste the module content here (or choose a file above)…" spellCheck={false} style={{ ...inp, width: '100%', minHeight: 150, marginTop: 12, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }} />
          {parseChk && (parseChk.ok
            ? <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={chip}>Title: {parseChk.modules[0]?.title || '—'}</span>
                  {parseChk.modules[0]?.duration_mins ? <span style={chip}>{parseChk.modules[0].duration_mins} min</span> : null}
                  {parseChk.modules[0]?.description ? <span style={chip}>Description ✓</span> : null}
                  {parseChk.modules[0]?.body_html ? <span style={chip}>Body ✓</span> : <span style={{ ...chip, background: '#fbf0d5', color: 'var(--amber,#b8860b)' }}>No body</span>}
                  <span style={chip}>{(parseChk.modules[0]?.quiz || []).length} questions</span>
                </div>
                <button style={{ ...btnP, marginTop: 10, background: 'var(--teal,#0f766e)' }} onClick={applyPaste}>Apply to this module</button>
              </div>
            : <div style={{ marginTop: 10, border: '1px solid #f4cfc8', background: 'var(--coral-soft,#fdece9)', borderRadius: 8, padding: '8px 10px', fontSize: 12.5 }}><b style={{ color: 'var(--coral,#c0392b)' }}>{parseChk.errors.length} problem(s):</b> {parseChk.errors.slice(0, 5).join(' · ')}</div>)}
          {contentMsg && <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 700, color: contentMsg.startsWith('✓') ? 'var(--good,#0f9d6b)' : 'var(--coral,#c0392b)' }}>{contentMsg}</div>}
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {editing.title ? <>
              <span style={chip}>Current: {editing.title}</span>
              {editing.duration_mins ? <span style={chip}>{editing.duration_mins} min</span> : null}
              {editing.body_html ? <span style={chip}>Body ✓</span> : null}
              {(editing as any).course_json ? <span style={{ ...chip, background: 'var(--teal-soft,#e6f7f2)', color: 'var(--teal,#0f766e)' }}>Interactive (PPTX)</span> : null}
            </> : <span className="muted" style={{ fontSize: 12.5 }}>No content yet.</span>}
          </div>
          {editing.body_html && <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--brand,#2f6fd0)', fontWeight: 700 }}>Preview lesson body</summary>
            <div style={{ ...inp, marginTop: 6, background: '#fff', maxHeight: 240, overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: editing.body_html }} /></details>}
        </section>

        {/* questions */}
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'linear-gradient(135deg,#1c3f6e,#2f6fd0)', color: '#fff', borderRadius: 12, padding: '12px 16px', marginBottom: 12 }}>
            <span style={{ fontSize: 20 }}>📋</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>Knowledge check</div>
              <div style={{ fontSize: 12, opacity: .85 }}>One correct answer per question · teachers pass at ≥ 2 of 3 · blank questions are ignored on save</div>
            </div>
            <button style={{ ...btnG, background: 'rgba(255,255,255,.16)', color: '#fff', border: '1px solid rgba(255,255,255,.32)', padding: '7px 12px', flex: '0 0 auto' }} onClick={() => setQpm(1)}>＋ Add question</button>
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {editing.quiz.map((q, qi) => (
              <div key={qi} style={{ border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 14, background: 'var(--card,#fff)', boxShadow: '0 1px 2px rgba(35,42,61,.05)' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{ flex: '0 0 auto', width: 26, height: 26, borderRadius: 8, background: 'var(--tint,#eaf1fb)', color: 'var(--brand,#2f6fd0)', fontWeight: 800, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 3 }}>{qi + 1}</span>
                  <input value={q.q} onChange={e => setQ(qi, { q: e.target.value })} style={{ ...inp, flex: 1, fontWeight: 700, fontSize: 14.5 }} placeholder="Question text (leave blank to skip)" />
                  <button style={{ ...btnG, color: 'var(--coral,#c0392b)', padding: '7px 11px', flex: '0 0 auto' }} onClick={() => setQpm(-1)}>Remove</button>
                </div>
                <div className="muted" style={{ fontSize: 11.5, margin: '12px 0 8px', paddingLeft: 36 }}>Select the correct answer</div>
                <div style={{ display: 'grid', gap: 8, paddingLeft: 36 }}>
                  {q.opts.map((o, oi) => {
                    const correct = q.answer === oi;
                    return (
                    <div key={oi} style={{ display: 'flex', gap: 10, alignItems: 'center', border: '1px solid ' + (correct ? 'var(--teal,#0f766e)' : 'var(--line,#e6e6ef)'), background: correct ? 'var(--teal-soft,#e6f7f2)' : 'var(--card,#fff)', borderRadius: 10, padding: '8px 10px' }}>
                      <button type="button" onClick={() => setQ(qi, { answer: oi })} title="Mark as the correct answer" aria-pressed={correct} style={{ flex: '0 0 auto', width: 20, height: 20, borderRadius: '50%', border: '2px solid ' + (correct ? 'var(--teal,#0f766e)' : '#c7ccd6'), background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                        {correct && <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--teal,#0f766e)' }} />}
                      </button>
                      <input value={o} onChange={e => setOpt(qi, oi, e.target.value)} style={{ ...inp, flex: 1, border: 'none', background: 'transparent', padding: '4px 2px' }} placeholder={`Option ${String.fromCharCode(65 + oi)}`} />
                      {correct && <span style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--teal,#0f766e)', textTransform: 'uppercase', letterSpacing: '.03em', flex: '0 0 auto' }}>Correct</span>}
                      {q.opts.length > 2 && <button style={{ border: 'none', background: 'transparent', color: 'var(--coral,#c0392b)', cursor: 'pointer', fontWeight: 800, fontSize: 14, flex: '0 0 auto', padding: '2px 6px' }} onClick={() => rmOpt(qi, oi)} title="Remove option">✕</button>}
                    </div>
                    );
                  })}
                </div>
                {q.opts.length < 6 && <button style={{ ...btnG, marginTop: 10, marginLeft: 36, padding: '6px 12px' }} onClick={() => addOpt(qi)}>＋ Add option</button>}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button style={btnP} disabled={busy} onClick={save}>{busy ? 'Saving…' : editing.id ? 'Save module' : 'Create module'}</button>
            {editing.id && <button style={{ ...btnG, color: 'var(--coral,#c0392b)' }} disabled={busy} onClick={() => del(modules.find(m => m.id === editing.id) as Module)}>Delete module</button>}
          </div>
        </section>
      </div>
    );
  }

  // ---------- LIST ----------
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Crumb />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ marginRight: 'auto' }}>
          <h2 style={{ margin: '0 0 2px', fontSize: 21, fontWeight: 900, letterSpacing: '-.02em', color: navy }}>Learning modules</h2>
          <div className="muted" style={{ fontSize: 13 }}>Click a module to open it. Drag a row to reorder.</div>
        </div>
        {canManage && (
          <div>
            <div className="muted" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 4 }}>Questions / module</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ display: 'inline-flex', border: '1px solid var(--line,#d7dce8)', borderRadius: 10, overflow: 'hidden' }}>
                <button onClick={() => setQModeP('page')} style={{ border: 'none', background: qMode === 'page' ? 'var(--brand,#2f6fd0)' : 'var(--card2,#f7f9fc)', color: qMode === 'page' ? '#fff' : 'var(--muted,#647089)', fontWeight: 800, fontSize: 12.5, padding: '9px 12px', cursor: 'pointer' }}>Page default</button>
                <button onClick={() => setQModeP('file')} style={{ border: 'none', background: qMode === 'file' ? 'var(--brand,#2f6fd0)' : 'var(--card2,#f7f9fc)', color: qMode === 'file' ? '#fff' : 'var(--muted,#647089)', fontWeight: 800, fontSize: 12.5, padding: '9px 12px', cursor: 'pointer' }}>From .txt file</button>
              </div>
              {qMode === 'page' && (
                <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--line,#d7dce8)', borderRadius: 10, overflow: 'hidden' }}>
                  <button onClick={() => setPageQpmClamped(pageQpm - 1)} style={{ border: 'none', background: 'var(--card2,#f7f9fc)', width: 34, height: 38, fontSize: 17, fontWeight: 800, cursor: 'pointer', color: 'var(--muted,#647089)' }}>−</button>
                  <span style={{ width: 44, textAlign: 'center', fontWeight: 800, fontSize: 15 }}>{pageQpm}</span>
                  <button onClick={() => setPageQpmClamped(pageQpm + 1)} style={{ border: 'none', background: 'var(--card2,#f7f9fc)', width: 34, height: 38, fontSize: 17, fontWeight: 800, cursor: 'pointer', color: 'var(--muted,#647089)' }}>＋</button>
                </div>
              )}
            </div>
          </div>
        )}
        {canManage && <button style={btnG} onClick={() => { setBulkStep('paste'); setBulkOpen(o => !o); }}>⬆ Add Bulk Module</button>}
        {canManage && <button style={btnP} onClick={() => openEditor(null)}>＋ New module</button>}
      </div>

      {err && <div className="empty" style={{ padding: 10, color: err.startsWith('Imported') ? 'var(--good,#0f9d6b)' : 'var(--coral,#c0392b)' }}>{err}</div>}

      {bulkOpen && canManage && (
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <div style={{ fontWeight: 800, color: navy, fontSize: 14, marginBottom: 8 }}>Add Bulk Module</div>
          <div style={{ display: 'inline-flex', background: 'var(--card2,#eef2f7)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 9, padding: 3, gap: 3, marginBottom: 12 }}>
            <button onClick={() => setImportMode('txt')} style={{ border: 0, background: importMode === 'txt' ? 'var(--card,#fff)' : 'transparent', color: importMode === 'txt' ? navy : 'var(--muted,#647089)', fontWeight: 800, fontSize: 12.5, padding: '7px 13px', borderRadius: 7, cursor: 'pointer', boxShadow: importMode === 'txt' ? '0 1px 3px rgba(0,0,0,.1)' : 'none' }}>📄 .txt file</button>
            <button onClick={() => setImportMode('pptx')} style={{ border: 0, background: importMode === 'pptx' ? 'var(--card,#fff)' : 'transparent', color: importMode === 'pptx' ? 'var(--amber,#b45309)' : 'var(--muted,#647089)', fontWeight: 800, fontSize: 12.5, padding: '7px 13px', borderRadius: 7, cursor: 'pointer', boxShadow: importMode === 'pptx' ? '0 1px 3px rgba(0,0,0,.1)' : 'none' }}>📊 PowerPoint</button>
          </div>
          {importMode === 'txt' ? (bulkStep === 'paste' ? (<>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6, fontWeight: 700, color: navy }}>Bulk import (.txt)</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>One block per module, separated by a line of <code>---</code>. All-or-nothing.</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ ...btnG, display: 'inline-flex', alignItems: 'center' }}>Choose .txt<input type="file" accept=".txt,.md,text/plain" style={{ display: 'none' }} onChange={e => readFile(e.target.files?.[0], setBulkText)} /></label>
            <button style={btnG} onClick={() => download('modules_template.txt', TXT_TEMPLATE)}>⬇ Template</button>
          </div>
          <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} placeholder="…or paste blocks here" spellCheck={false} style={{ ...inp, width: '100%', minHeight: 130, marginTop: 10, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }} />
          {parsed && !parsed.ok && <div style={{ marginTop: 10, border: '1px solid #f4cfc8', background: 'var(--coral-soft,#fdece9)', borderRadius: 8, padding: '8px 10px' }}><div style={{ fontWeight: 800, color: 'var(--coral,#c0392b)', fontSize: 12.5, marginBottom: 4 }}>{parsed.errors.length} problem(s):</div><ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>{parsed.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
          {parsed && parsed.ok && <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><span style={{ fontSize: 13, fontWeight: 700, color: 'var(--good,#0f9d6b)' }}>✓ {parsed.modules.length} module(s) parsed</span><button style={{ ...btnP, marginLeft: 'auto' }} onClick={startPreview}>Preview {parsed.modules.length} module(s) →</button></div>}
          </>) : (
            <div>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>{bulkPreview.length} module(s) ready — edit each name and pick an icon. Nothing is saved until you press Create.</div>
              <div style={{ maxHeight: 360, overflow: 'auto', display: 'grid', gap: 8 }}>
                {bulkPreview.map((m, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--line,#e6e6ef)', borderRadius: 10, padding: '9px 11px', background: 'var(--card2,#f7f9fc)' }}>
                    <div style={{ position: 'relative', flex: '0 0 auto' }}>
                      <button onClick={() => setIconOpen(iconOpen === i ? null : i)} style={{ width: 42, height: 42, borderRadius: 10, border: '1px solid var(--line,#e6e6ef)', background: '#fff', fontSize: 20, cursor: 'pointer' }}>{m.icon}</button>
                      {iconOpen === i && <div style={{ position: 'absolute', top: 46, left: 0, zIndex: 6, background: '#fff', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 8, display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 4, boxShadow: '0 12px 32px rgba(0,0,0,.18)', width: 244 }}>
                        {ICONS.map(ic => <button key={ic} onClick={() => { setBulkPreview(bp => bp.map((x, xi) => xi === i ? { ...x, icon: ic } : x)); setIconOpen(null); }} style={{ width: 34, height: 34, borderRadius: 8, border: '1px solid transparent', background: m.icon === ic ? 'var(--brand-soft,#e7f0fc)' : 'transparent', fontSize: 18, cursor: 'pointer' }}>{ic}</button>)}
                      </div>}
                    </div>
                    <input value={m.title} onChange={e => setBulkPreview(bp => bp.map((x, xi) => xi === i ? { ...x, title: e.target.value } : x))} placeholder={`Module ${i + 1}`} style={{ ...inp, flex: 1, fontWeight: 700 }} />
                    <span className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap', flex: '0 0 auto' }}>{m.duration_mins ?? 0} min</span>
                    <span style={{ fontWeight: 800, color: 'var(--good,#0f9d6b)', fontSize: 13, whiteSpace: 'nowrap', flex: '0 0 auto' }}>{effQpm(m)} Q</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button style={btnG} onClick={() => setBulkStep('paste')}>← Back</button>
                <button style={{ ...btnP, marginLeft: 'auto', background: 'var(--good,#0f9d6b)' }} disabled={busy} onClick={createBulk}>{busy ? 'Creating…' : `Create ${bulkPreview.length} module(s)`}</button>
              </div>
            </div>
          )) : (
            <>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>Drop a <b>.pptx</b> — its slides become interactive cards, steps, tabs and accordions, plus source-based questions. You review the result before it goes live; questions can still come from a .txt afterward.</div>
              <label style={{ ...btnP, display: 'inline-flex', alignItems: 'center', background: 'var(--teal,#0f766e)', opacity: pptxBusy ? 0.6 : 1, pointerEvents: pptxBusy ? 'none' : 'auto' }}>📊 Choose PowerPoint (.pptx)<input type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" style={{ display: 'none' }} onChange={e => readPptx(e.target.files?.[0])} /></label>
              {pptxBusy && <div style={{ marginTop: 14, color: navy, fontWeight: 700, fontSize: 13 }}>⏳ {pptxMsg || 'Processing…'}</div>}
            </>
          )}
        </section>
      )}

      {loading ? <div className="muted" style={{ padding: 12 }}>Loading…</div>
        : modules.length === 0 ? <div className="muted" style={{ padding: 12 }}>No modules yet. Create one or bulk-import a .txt.</div>
        : (
          <div style={{ border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, background: 'var(--card,#fff)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', ...th, gap: 14 }}>
              <span style={{ flex: 1 }}>Module</span><span style={{ width: 70 }}>Duration</span><span style={{ width: 70 }}>Questions</span><span style={{ width: 70 }}>Active</span><span style={{ width: 70 }}></span>
            </div>
            {modules.map((m, i) => (
              <div key={m.id}
                draggable={canManage}
                onDragStart={() => setDragIx(i)}
                onDragOver={e => { e.preventDefault(); }}
                onDrop={() => { if (dragIx != null) doReorder(dragIx, i); setDragIx(null); }}
                onClick={() => openEditor(m)}
                style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '13px 14px', borderTop: i ? '1px solid var(--line,#eef1f6)' : 'none', cursor: 'pointer', background: dragIx === i ? 'var(--brand-soft,#e7f0fc)' : '#fff' }}>
                {canManage && <span title="Drag to reorder" style={{ cursor: 'grab', color: '#c3ccd8', fontSize: 16 }}>⠿</span>}
                <span style={{ width: 40, height: 40, borderRadius: 10, display: 'grid', placeItems: 'center', fontSize: 20, background: 'var(--brand-soft,#e7f0fc)', flex: 'none' }}>{m.icon || '📘'}</span>
                <span style={{ flex: 1, minWidth: 0 }}><span style={{ fontWeight: 800, display: 'block' }}>{m.title}</span>{m.description && <span className="muted" style={{ fontSize: 12.5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.description}</span>}</span>
                <span className="muted" style={{ width: 70, fontSize: 12.5 }}>{m.duration_mins ? `${m.duration_mins} min` : '—'}</span>
                <span className="muted" style={{ width: 70, fontSize: 12.5 }}>{m.question_count ?? (m.quiz?.length ?? 0)}</span>
                <span style={{ width: 70 }}>
                  <button onClick={e => { e.stopPropagation(); canManage && toggleActive(m); }} disabled={!canManage || busy}
                    style={{ cursor: canManage ? 'pointer' : 'default', border: 'none', borderRadius: 999, padding: '3px 10px', fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', background: m.active ? 'var(--good-soft,#dcf5ea)' : '#eceff2', color: m.active ? 'var(--good,#0f9d6b)' : '#6b7280' }}>{m.active ? 'Active' : 'Hidden'}</button>
                </span>
                <span style={{ width: 70, textAlign: 'right' }}>{canManage && <button onClick={e => { e.stopPropagation(); del(m); }} style={{ ...btnG, padding: '5px 10px', color: 'var(--coral,#c0392b)' }}>Delete</button>}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

const chip: React.CSSProperties = { display: 'inline-flex', gap: 6, alignItems: 'center', background: 'var(--good-soft,#dcf5ea)', color: 'var(--good,#0f9d6b)', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700 };
