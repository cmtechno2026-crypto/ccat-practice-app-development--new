import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
const newDraft = (): Draft => ({ title: '', icon: '🎓', duration_mins: 5, description: '', body_html: '', quiz: padQuiz([], DEFAULT_QPM), active: true });

function Crumb({ leaf }: { leaf?: string }) {
  return (
    <div style={{ fontSize: 12.5, color: 'var(--muted,#647089)', marginBottom: 6 }}>
      <Link to="/teacherhub/training" style={{ color: 'var(--brand,#2f6fd0)', textDecoration: 'none', fontWeight: 700 }}>Training</Link>
      {' / '}{leaf ? <Link to="/teacherhub/training/modules" style={{ color: 'var(--brand,#2f6fd0)', textDecoration: 'none', fontWeight: 700 }}>Learning modules</Link> : <b style={{ color: 'var(--ink,inherit)' }}>Learning modules</b>}
      {leaf && <> / <b style={{ color: 'var(--ink,inherit)' }}>{leaf}</b></>}
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
      : newDraft());
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

  const runBulk = async () => {
    if (!parsed || !parsed.ok) return;
    setBusy(true); setErr('');
    try { const r = await api.trainingBulkCreate(parsed.modules as ParsedModule[]); setBulkText(''); setBulkOpen(false); load(); setErr(`Imported ${r.created} module(s).`); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const readFile = (f: File | undefined, into: (t: string) => void) => { if (!f) return; const rd = new FileReader(); rd.onload = () => into(String(rd.result || '')); rd.readAsText(f); };
  const download = (name: string, text: string) => { const b = new Blob([text], { type: 'text/plain' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u); };

  // ---- content .txt upload → fill draft ----
  const applyTxt = (text: string) => {
    const r = parseTrainingText(text);
    if (!r.ok) { setErr('Content file: ' + r.errors.slice(0, 3).join(' · ')); return; }
    const m = r.modules[0]; if (!m || !editing) return;
    setErr('');
    setEditing({ ...editing, title: m.title, duration_mins: m.duration_mins ?? 0, description: m.description || '', body_html: m.body_html || '',
      quiz: m.quiz.length ? padQuiz(m.quiz as Quiz[], m.questions_per_module) : padQuiz(editing.quiz.filter(q => q.q.trim()), m.questions_per_module) });
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
            <div className="muted" style={{ fontSize: 13 }}>Content comes from a .txt file; pick a symbol and add questions here.</div>
          </div>
          <button style={btnG} onClick={closeEditor}>← Back</button>
        </div>
        {err && <div className="empty" style={{ padding: 10, color: err.startsWith('Imported') ? 'var(--good,#0f9d6b)' : 'var(--coral,#c0392b)' }}>{err}</div>}

        {/* symbol + questions count + active */}
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16, display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 5 }}>Symbol</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', maxWidth: 380 }}>
              {ICONS.map(ic => <button key={ic} onClick={() => setEditing({ ...editing, icon: ic })} style={{ width: 42, height: 42, borderRadius: 10, cursor: 'pointer', fontSize: 20, background: editing.icon === ic ? 'var(--brand-soft,#e7f0fc)' : '#fff', border: '1px solid ' + (editing.icon === ic ? 'var(--brand,#2f6fd0)' : 'var(--line,#e6e6ef)') }}>{ic}</button>)}
            </div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 5 }}>Questions per module</div>
            <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--line,#d7dce8)', borderRadius: 10, overflow: 'hidden' }}>
              <button onClick={() => setQpm(-1)} style={{ border: 'none', background: 'var(--card2,#f7f9fc)', width: 38, height: 40, fontSize: 18, fontWeight: 800, cursor: 'pointer', color: 'var(--muted,#647089)' }}>−</button>
              <span style={{ width: 52, textAlign: 'center', fontWeight: 800, fontSize: 15 }}>{editing.quiz.length}</span>
              <button onClick={() => setQpm(1)} style={{ border: 'none', background: 'var(--card2,#f7f9fc)', width: 38, height: 40, fontSize: 18, fontWeight: 800, cursor: 'pointer', color: 'var(--muted,#647089)' }}>＋</button>
            </div>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 22 }}>
            <input type="checkbox" checked={editing.active} onChange={e => setEditing({ ...editing, active: e.target.checked })} /> Visible to teachers
          </label>
        </section>

        {/* content via .txt */}
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <div style={{ fontWeight: 800, color: navy, fontSize: 14, marginBottom: 8 }}>Lesson content (from .txt)</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button style={btnG} onClick={() => download((editing.title || 'module').replace(/\W+/g, '_') + '.txt', editing.title ? moduleToTxt({ ...editing, questions_per_module: editing.quiz.length, quiz: editing.quiz.filter(q => q.q.trim()) }) : TXT_TEMPLATE)}>⬇ Download .txt {editing.title ? '(this module)' : 'template'}</button>
            <label style={{ ...btnP, display: 'inline-flex', alignItems: 'center' }}>⬆ Upload .txt<input type="file" accept=".txt,.md,text/plain" style={{ display: 'none' }} onChange={e => readFile(e.target.files?.[0], applyTxt)} /></label>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {editing.title ? <>
              <span style={chip}>Title: {editing.title}</span>
              {editing.duration_mins ? <span style={chip}>{editing.duration_mins} min</span> : null}
              {editing.description ? <span style={chip}>Description ✓</span> : null}
              {editing.body_html ? <span style={chip}>Body ✓</span> : <span style={{ ...chip, background: '#fbf0d5', color: 'var(--amber,#b8860b)' }}>No body yet</span>}
            </> : <span className="muted" style={{ fontSize: 12.5 }}>No content yet — download the template, fill it, and upload.</span>}
          </div>
          {editing.body_html && <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--brand,#2f6fd0)', fontWeight: 700 }}>Preview lesson body</summary>
            <div style={{ ...inp, marginTop: 6, background: '#fff', maxHeight: 240, overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: editing.body_html }} /></details>}
        </section>

        {/* questions */}
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontWeight: 800, color: navy, fontSize: 14 }}>Questions</span>
            <span className="muted" style={{ fontSize: 12 }}>Teachers pass at ≥ 2 of 3 correct. Blank questions are ignored on save.</span>
            <button style={{ ...btnG, marginLeft: 'auto', padding: '6px 10px' }} onClick={() => setQpm(1)}>＋ Add question</button>
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {editing.quiz.map((q, qi) => (
              <div key={qi} style={{ border: '1px solid var(--line,#e6e6ef)', borderRadius: 10, padding: 10, background: 'var(--card2,#f7f9fc)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontWeight: 800, fontSize: 12, color: 'var(--muted,#647089)' }}>Q{qi + 1}</span>
                  <input value={q.q} onChange={e => setQ(qi, { q: e.target.value })} style={{ ...inp, flex: 1 }} placeholder="Question text (leave blank to skip)" />
                  <button style={{ ...btnG, color: 'var(--coral,#c0392b)', padding: '6px 10px' }} onClick={() => setQpm(-1)}>Remove</button>
                </div>
                <div className="muted" style={{ fontSize: 11.5, margin: '8px 0 4px' }}>Options — select the correct one:</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {q.opts.map((o, oi) => (
                    <div key={oi} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input type="radio" name={`ans-${qi}`} checked={q.answer === oi} onChange={() => setQ(qi, { answer: oi })} />
                      <span style={{ fontWeight: 800, width: 18 }}>{String.fromCharCode(65 + oi)}</span>
                      <input value={o} onChange={e => setOpt(qi, oi, e.target.value)} style={{ ...inp, flex: 1 }} placeholder={`Option ${String.fromCharCode(65 + oi)}`} />
                      {q.opts.length > 2 && <button style={{ ...btnG, padding: '4px 8px', color: 'var(--coral,#c0392b)' }} onClick={() => rmOpt(qi, oi)}>✕</button>}
                    </div>
                  ))}
                </div>
                {q.opts.length < 6 && <button style={{ ...btnG, marginTop: 6, padding: '4px 10px' }} onClick={() => addOpt(qi)}>＋ Add option</button>}
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
        {canManage && <button style={btnG} onClick={() => { setBulkOpen(o => !o); }}>⬆ Bulk import</button>}
        {canManage && <button style={btnP} onClick={() => openEditor(null)}>＋ New module</button>}
      </div>

      {err && <div className="empty" style={{ padding: 10, color: err.startsWith('Imported') ? 'var(--good,#0f9d6b)' : 'var(--coral,#c0392b)' }}>{err}</div>}

      {bulkOpen && canManage && (
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <div style={{ fontWeight: 800, color: navy, fontSize: 14, marginBottom: 6 }}>Bulk import modules (.txt)</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>One block per module, separated by a line of <code>---</code>. All-or-nothing.</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ ...btnG, display: 'inline-flex', alignItems: 'center' }}>Choose .txt<input type="file" accept=".txt,.md,text/plain" style={{ display: 'none' }} onChange={e => readFile(e.target.files?.[0], setBulkText)} /></label>
            <button style={btnG} onClick={() => download('modules_template.txt', TXT_TEMPLATE)}>⬇ Template</button>
          </div>
          <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} placeholder="…or paste blocks here" spellCheck={false} style={{ ...inp, width: '100%', minHeight: 130, marginTop: 10, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }} />
          {parsed && !parsed.ok && <div style={{ marginTop: 10, border: '1px solid #f4cfc8', background: 'var(--coral-soft,#fdece9)', borderRadius: 8, padding: '8px 10px' }}><div style={{ fontWeight: 800, color: 'var(--coral,#c0392b)', fontSize: 12.5, marginBottom: 4 }}>{parsed.errors.length} problem(s):</div><ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>{parsed.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
          {parsed && parsed.ok && <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><span style={{ fontSize: 13, fontWeight: 700, color: 'var(--good,#0f9d6b)' }}>✓ {parsed.modules.length} module(s) ready</span><button style={{ ...btnP, marginLeft: 'auto' }} disabled={busy} onClick={runBulk}>{busy ? 'Importing…' : `Create ${parsed.modules.length} module(s)`}</button></div>}
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
