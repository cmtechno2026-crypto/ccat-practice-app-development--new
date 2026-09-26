import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { parseTrainingText, type ParsedModule } from '../lib/trainingImport';

// Web Admin — TeacherHub Training management. CRUD over ta_training_modules (the "Learning modules"
// teachers see in the TeacherHub app), plus a universal .txt bulk importer (all-or-nothing parse).
interface Quiz { q: string; opts: string[]; answer: number }
interface Module {
  id: number; title: string; icon: string | null; duration_mins: number | null;
  description: string | null; body_html: string | null; quiz: Quiz[] | null;
  sort_order: number; active: boolean; question_count?: number;
}
type Draft = Omit<Module, 'id' | 'question_count' | 'sort_order'> & { id?: number };

const inp: React.CSSProperties = { padding: '8px 10px', border: '1px solid var(--line,#d7dce8)', borderRadius: 8, background: 'var(--card2,#f7f9fc)', color: 'inherit', font: 'inherit' };
const navy = 'var(--brand,#1c3f6e)';
const btnP: React.CSSProperties = { ...inp, cursor: 'pointer', fontWeight: 800, background: 'var(--brand,#2f6fd0)', color: '#fff', border: 'none' };
const btnG: React.CSSProperties = { ...inp, cursor: 'pointer', fontWeight: 700 };
const blank = (): Draft => ({ title: '', icon: '📘', duration_mins: 5, description: '', body_html: '', quiz: [], active: true });

const FORMAT_HELP = `Title: Welcome & Onboarding
Icon: 🎓
Duration: 8
Description: Get started with TeacherHub.
Body:
<h4>Welcome</h4>
<p>Keep your availability up to date.</p>
Q: How soon should you review a request?
A) Within 1 week
B) Within 24 hours
Answer: B
---
Title: Next module
Description: Blocks are separated by a line of ---`;

export function TrainingAdmin() {
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkName, setBulkName] = useState('');

  const load = () => { setLoading(true); api.trainingModules().then(r => setModules(r.modules as Module[])).catch(e => setErr(e.message)).finally(() => setLoading(false)); };
  useEffect(load, []);

  const parsed = useMemo(() => (bulkText.trim() ? parseTrainingText(bulkText) : null), [bulkText]);

  const save = async () => {
    if (!editing) return;
    if (!editing.title.trim()) { setErr('Title is required.'); return; }
    // Validate quiz locally so the save is clean.
    for (const q of editing.quiz || []) {
      if (!q.q.trim()) { setErr('Every question needs text.'); return; }
      if (q.opts.length < 2) { setErr('Every question needs at least 2 options.'); return; }
      if (q.opts.some(o => !o.trim())) { setErr('Options cannot be empty.'); return; }
      if (q.answer < 0 || q.answer >= q.opts.length) { setErr('Pick a correct answer for every question.'); return; }
    }
    setBusy(true); setErr('');
    const body = {
      title: editing.title.trim(), icon: editing.icon || null, duration_mins: editing.duration_mins ?? null,
      description: editing.description || null, body_html: editing.body_html || null, quiz: editing.quiz || [], active: editing.active,
    };
    try {
      if (editing.id) await api.trainingUpdateModule(editing.id, body);
      else await api.trainingCreateModule(body);
      setEditing(null); load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async (m: Module) => {
    if (!window.confirm(`Delete "${m.title}"? Teachers' progress on it is also removed. This cannot be undone.`)) return;
    setBusy(true); setErr('');
    try { await api.trainingDeleteModule(m.id); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const toggleActive = async (m: Module) => {
    setBusy(true); setErr('');
    try { await api.trainingUpdateModule(m.id, { active: !m.active }); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const move = async (i: number, dir: -1 | 1) => {
    const j = i + dir; if (j < 0 || j >= modules.length) return;
    const next = modules.slice(); const [it] = next.splice(i, 1); next.splice(j, 0, it);
    setModules(next); // optimistic
    try { await api.trainingReorder(next.map(m => m.id)); } catch (e: any) { setErr(e.message); load(); }
  };
  const runBulk = async () => {
    if (!parsed || !parsed.ok) return;
    setBusy(true); setErr('');
    try { const r = await api.trainingBulkCreate(parsed.modules as ParsedModule[]); setBulkText(''); setBulkName(''); setBulkOpen(false); load(); setErr(`Imported ${r.created} module(s).`); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const onFile = (f: File | undefined) => {
    if (!f) return; setBulkName(f.name);
    const rd = new FileReader(); rd.onload = () => setBulkText(String(rd.result || '')); rd.readAsText(f);
  };

  // ---- Quiz builder helpers (operate on editing draft) ----
  const setQ = (qi: number, patch: Partial<Quiz>) => setEditing(e => e ? { ...e, quiz: (e.quiz || []).map((q, i) => i === qi ? { ...q, ...patch } : q) } : e);
  const addQ = () => setEditing(e => e ? { ...e, quiz: [...(e.quiz || []), { q: '', opts: ['', ''], answer: 0 }] } : e);
  const rmQ = (qi: number) => setEditing(e => e ? { ...e, quiz: (e.quiz || []).filter((_, i) => i !== qi) } : e);
  const setOpt = (qi: number, oi: number, val: string) => setQ(qi, { opts: (editing!.quiz![qi].opts).map((o, i) => i === oi ? val : o) });
  const addOpt = (qi: number) => { const q = editing!.quiz![qi]; if (q.opts.length < 6) setQ(qi, { opts: [...q.opts, ''] }); };
  const rmOpt = (qi: number, oi: number) => { const q = editing!.quiz![qi]; if (q.opts.length <= 2) return; const opts = q.opts.filter((_, i) => i !== oi); setQ(qi, { opts, answer: Math.min(q.answer, opts.length - 1) }); };

  const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted,#647089)', padding: '10px 12px', borderBottom: '1px solid var(--line,#e6e6ef)', background: 'var(--card2,#f7f9fc)', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '10px 12px', fontSize: 13, verticalAlign: 'middle', borderBottom: '1px solid var(--line,#eef1f6)' };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Link to="/teacherhub/training" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--brand,#2f6fd0)', textDecoration: 'none', width: 'fit-content' }}>← Training overview</Link>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ marginRight: 'auto' }}>
          <h2 style={{ margin: '0 0 2px', fontSize: 21, fontWeight: 900, letterSpacing: '-.02em', color: navy }}>Learning modules</h2>
          <div className="muted" style={{ fontSize: 13 }}>What teachers read and get quizzed on in the TeacherHub app. Order, activate and edit here.</div>
        </div>
        {canManage && <button style={btnG} onClick={() => { setBulkOpen(o => !o); setEditing(null); }}>⬆ Bulk import</button>}
        {canManage && <button style={btnP} onClick={() => { setEditing(blank()); setBulkOpen(false); }}>＋ New module</button>}
      </div>

      {err && <div className="empty" style={{ padding: 10, color: err.startsWith('Imported') ? 'var(--good,#0f9d6b)' : 'var(--coral,#c0392b)' }}>{err}</div>}

      {/* ---- Bulk import panel ---- */}
      {bulkOpen && canManage && (
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 16, color: navy }}>Import modules from a .txt file</h3>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>One block per module, separated by a line of <code>---</code>. All-or-nothing: any error rejects the whole file. Nothing is created until you confirm.</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="file" accept=".txt,.md,text/plain" onChange={e => onFile(e.target.files?.[0])} />
            {bulkName && <span className="muted" style={{ fontSize: 12 }}>{bulkName}</span>}
          </div>
          <textarea value={bulkText} onChange={e => { setBulkText(e.target.value); setBulkName(''); }} placeholder="…or paste blocks here" spellCheck={false}
            style={{ ...inp, width: '100%', minHeight: 140, marginTop: 10, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }} />
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--brand,#2f6fd0)', fontWeight: 700 }}>Show format</summary>
            <pre style={{ ...inp, whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 6 }}>{FORMAT_HELP}</pre>
          </details>
          {parsed && !parsed.ok && (
            <div style={{ marginTop: 10, border: '1px solid #f4cfc8', background: 'var(--coral-soft,#fdece9)', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontWeight: 800, color: 'var(--coral,#c0392b)', fontSize: 12.5, marginBottom: 4 }}>{parsed.errors.length} problem(s) — fix and re-check:</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>{parsed.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          {parsed && parsed.ok && (
            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--good,#0f9d6b)' }}>✓ {parsed.modules.length} module(s) ready: {parsed.modules.map(m => m.title).join(', ')}</span>
              <button style={{ ...btnP, marginLeft: 'auto' }} disabled={busy} onClick={runBulk}>{busy ? 'Importing…' : `Create ${parsed.modules.length} module(s)`}</button>
            </div>
          )}
        </section>
      )}

      {/* ---- Editor ---- */}
      {editing && canManage && (
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 16, color: navy }}>{editing.id ? 'Edit module' : 'New module'}</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'grid', gap: 4, flex: '2 1 260px' }}><span className="muted" style={{ fontSize: 12 }}>Module title *</span>
                <input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} style={inp} placeholder="Welcome & Onboarding" /></label>
              <label style={{ display: 'grid', gap: 4, width: 90 }}><span className="muted" style={{ fontSize: 12 }}>Icon</span>
                <input value={editing.icon || ''} onChange={e => setEditing({ ...editing, icon: e.target.value })} style={{ ...inp, textAlign: 'center' }} placeholder="📘" /></label>
              <label style={{ display: 'grid', gap: 4, width: 120 }}><span className="muted" style={{ fontSize: 12 }}>Minutes</span>
                <input type="number" min={0} max={600} value={editing.duration_mins ?? 0} onChange={e => setEditing({ ...editing, duration_mins: Number(e.target.value) })} style={inp} /></label>
            </div>
            <label style={{ display: 'grid', gap: 4 }}><span className="muted" style={{ fontSize: 12 }}>Description (one line on the card)</span>
              <input value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} style={inp} /></label>
            <label style={{ display: 'grid', gap: 4 }}><span className="muted" style={{ fontSize: 12 }}>Lesson body (HTML)</span>
              <textarea value={editing.body_html || ''} onChange={e => setEditing({ ...editing, body_html: e.target.value })} spellCheck={false}
                style={{ ...inp, minHeight: 160, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }} placeholder="<h4>Welcome</h4><p>…</p>" /></label>

            {/* quiz builder */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontWeight: 800, fontSize: 13, color: navy }}>Knowledge check</span>
                <span className="muted" style={{ fontSize: 12 }}>Teachers pass at ≥ 2 of 3 correct (rounds up). Leave empty for a read-only module.</span>
                <button style={{ ...btnG, marginLeft: 'auto', padding: '5px 10px' }} onClick={addQ}>＋ Add question</button>
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                {(editing.quiz || []).map((q, qi) => (
                  <div key={qi} style={{ border: '1px solid var(--line,#e6e6ef)', borderRadius: 10, padding: 10, background: 'var(--card2,#f7f9fc)' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontWeight: 800, fontSize: 12, color: 'var(--muted,#647089)' }}>Q{qi + 1}</span>
                      <input value={q.q} onChange={e => setQ(qi, { q: e.target.value })} style={{ ...inp, flex: 1 }} placeholder="Question text" />
                      <button style={{ ...btnG, color: 'var(--coral,#c0392b)', padding: '5px 10px' }} onClick={() => rmQ(qi)}>Remove</button>
                    </div>
                    <div className="muted" style={{ fontSize: 11.5, margin: '8px 0 4px' }}>Options — select the correct one:</div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {q.opts.map((o, oi) => (
                        <div key={oi} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input type="radio" name={`ans-${qi}`} checked={q.answer === oi} onChange={() => setQ(qi, { answer: oi })} title="Correct answer" />
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
            </div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={editing.active} onChange={e => setEditing({ ...editing, active: e.target.checked })} />
              Active (visible to teachers)
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={btnP} disabled={busy} onClick={save}>{busy ? 'Saving…' : editing.id ? 'Save changes' : 'Create module'}</button>
              <button style={btnG} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        </section>
      )}

      {/* ---- Module list ---- */}
      {loading ? <div className="muted" style={{ padding: 12 }}>Loading…</div>
        : modules.length === 0 ? <div className="muted" style={{ padding: 12 }}>No modules yet. Create one or bulk-import a .txt file.</div>
        : (
          <div style={{ overflowX: 'auto', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, background: 'var(--card,#fff)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
              <thead><tr><th style={th}>Order</th><th style={th}>Module</th><th style={th}>Duration</th><th style={th}>Questions</th><th style={th}>Active</th><th style={th}></th></tr></thead>
              <tbody>
                {modules.map((m, i) => (
                  <tr key={m.id}>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span className="muted" style={{ width: 18, textAlign: 'center' }}>{i + 1}</span>
                        {canManage && <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
                          <button style={{ ...btnG, padding: '0 6px', lineHeight: 1.2, opacity: i === 0 ? .35 : 1 }} disabled={i === 0} onClick={() => move(i, -1)} title="Move up">▲</button>
                          <button style={{ ...btnG, padding: '0 6px', lineHeight: 1.2, opacity: i === modules.length - 1 ? .35 : 1 }} disabled={i === modules.length - 1} onClick={() => move(i, 1)} title="Move down">▼</button>
                        </span>}
                      </div>
                    </td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <span style={{ fontSize: 20 }}>{m.icon || '📘'}</span>
                        <div><div style={{ fontWeight: 700 }}>{m.title}</div>{m.description && <div className="muted" style={{ fontSize: 12 }}>{m.description}</div>}</div>
                      </div>
                    </td>
                    <td style={td}><span className="muted">{m.duration_mins ? `${m.duration_mins} min` : '—'}</span></td>
                    <td style={td}><span className="muted">{m.question_count ?? (m.quiz?.length ?? 0)}</span></td>
                    <td style={td}>
                      <button onClick={() => canManage && toggleActive(m)} disabled={!canManage || busy} title={m.active ? 'Active — click to hide' : 'Hidden — click to show'}
                        style={{ cursor: canManage ? 'pointer' : 'default', border: 'none', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', background: m.active ? 'var(--good-soft,#dcf5ea)' : '#eceff2', color: m.active ? 'var(--good,#0f9d6b)' : '#6b7280' }}>
                        {m.active ? 'Active' : 'Hidden'}
                      </button>
                    </td>
                    <td style={td}>
                      {canManage && <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button style={{ ...btnG, padding: '5px 10px' }} onClick={() => { setEditing({ id: m.id, title: m.title, icon: m.icon, duration_mins: m.duration_mins, description: m.description, body_html: m.body_html, quiz: (m.quiz || []) as Quiz[], active: m.active }); setBulkOpen(false); }}>Edit</button>
                        <button style={{ ...btnG, padding: '5px 10px', color: 'var(--coral,#c0392b)' }} onClick={() => del(m)}>Delete</button>
                      </div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
