import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Loading, ErrorBox, Modal, useToast } from '../components/ui';
import { ContentTabs } from './Content';
import { SetEditor } from '../components/SetEditor';

// The three exam sections are the three top-level categories (mockup EXAM_SECTIONS).
const SECTION_KEYS = ['verbal', 'non_verbal', 'quantitative'];
const SECTION_LABEL: Record<string, string> = { verbal: 'Verbal', non_verbal: 'Non-verbal', quantitative: 'Quantitative' };

export function ExamPapers() {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('content.create');
  const [tax, setTax] = useState<any>(null);
  const [sets, setSets] = useState<any[] | null>(null);
  const [error, setError] = useState<any>(null);
  const [grade, setGrade] = useState<string>('');
  const [selId, setSelId] = useState<string>('');
  const [detail, setDetail] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const [pickSection, setPickSection] = useState<string | null>(null);
  const [battery, setBattery] = useState<string | null>(null); // secKey of the battery being authored
  const catIdFor = (secKey: string) => (tax?.categories ?? []).find((c: any) => c.key === secKey)?.id as string | undefined;

  const loadSets = () => api.sets().then(r => setSets(r.items)).catch(setError);
  useEffect(() => { loadSets(); api.taxonomy().then(setTax).catch(() => {}); }, []);
  useEffect(() => { if (!grade && tax?.grades?.length) setGrade(String(tax.grades[0].grade_number)); }, [tax]); // eslint-disable-line

  const examForms = useMemo(() => (sets || []).filter(s => s.allowed_exam && (!grade || String(s.grade_number) === grade)), [sets, grade]);
  // Auto-create the 3 starter exam papers when a grade has none (idempotent server-side). Admins then
  // edit/delete/add freely. Guarded per-grade so it fires once and respects deletions afterward.
  const scaffolded = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!manage || !grade || sets === null || examForms.length > 0) return;
    const gid = tax?.grades?.find((g: any) => String(g.grade_number) === grade)?.id;
    if (!gid || scaffolded.current.has(gid)) return;
    scaffolded.current.add(gid);
    api.scaffoldExamPapers(gid).then(r => { if (r.created > 0) loadSets(); }).catch(() => {});
  }, [grade, sets, examForms, manage, tax]); // eslint-disable-line
  useEffect(() => {
    if (examForms.length && !examForms.some(f => f.id === selId)) setSelId(examForms[0].id);
    if (!examForms.length) { setSelId(''); setDetail(null); }
  }, [examForms]); // eslint-disable-line
  const loadDetail = (id: string) => { if (!id) return setDetail(null); api.set(id).then(setDetail).catch(setError); };
  useEffect(() => { loadDetail(selId); }, [selId]); // eslint-disable-line

  const refresh = () => { loadSets(); if (selId) loadDetail(selId); };
  const act = async (fn: Promise<any>, m: string) => { try { await fn; toast(m); refresh(); } catch (e) { toast((e as Error).message); } };

  const setDuration = async (mins: number) => {
    if (!detail) return; const v = Math.max(1, Math.min(180, Math.round(mins) || 0));
    await act(api.patchSet(detail.id, { duration_minutes: v }), `Duration ${v} min`);
  };
  const removeQuestion = async (qid: string) => {
    if (!detail) return;
    const ids = detail.questions.map((q: any) => q.id).filter((x: string) => x !== qid);
    await act(api.setMembership(detail.id, ids), 'Question removed');
  };
  const addQuestions = async (newIds: string[]) => {
    if (!detail) return;
    const cur = detail.questions.map((q: any) => q.id);
    const ids = [...new Set([...cur, ...newIds])];
    if (ids.length > 20) { toast('An exam paper holds at most 20 questions'); return; }
    await act(api.setMembership(detail.id, ids), 'Questions added');
    setPickSection(null);
  };

  const sectionQuestions = (secKey: string) => (detail?.questions || []).filter((q: any) => q.category_key === secKey);

  return (
    <div>
      <div className="toolbar" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 22 }}>Content</h2>
          <p className="lead" style={{ marginBottom: 0 }}>Exam papers are full three-section CCAT forms, timed. Publish when the paper is complete.</p>
        </div>
        {manage && <button className="btn" onClick={() => setCreating(true)}>+ New exam paper</button>}
      </div>

      <div className="contentnav">
        <ContentTabs active="exam" />
        {tax && (
          <label className="gradesel">GRADE
            <select value={grade} onChange={e => { setGrade(e.target.value); }}>
              {tax.grades.map((g: any) => <option key={g.id} value={g.grade_number}>Grade {g.grade_number}</option>)}
            </select>
          </label>
        )}
      </div>

      {error ? <ErrorBox e={error} /> : sets === null ? <Loading /> : (
        <div className="contentgrid" style={{ gridTemplateColumns: '280px 1fr' }}>
          {/* form list */}
          <aside className="cattree">
            {examForms.length === 0 && <div className="muted" style={{ padding: 10, fontSize: 13 }}>No exam papers in Grade {grade} yet.</div>}
            {examForms.map(f => (
              <button key={f.id} className={`treesub ${selId === f.id ? 'on' : ''}`} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} onClick={() => setSelId(f.id)}>
                <span style={{ fontWeight: 700 }}>{f.name}</span>
                <span className="muted tabnum" style={{ fontSize: 12 }}>{f.question_count} q · {f.duration_minutes ? `${f.duration_minutes} min` : 'no time'} · {f.state}</span>
              </button>
            ))}
          </aside>

          {/* selected form editor */}
          <div>
            {!detail ? <div className="panel"><div className="empty">Select or create an exam paper.</div></div> : (
              <>
                <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ fontFamily: 'Baloo 2', fontSize: 20, color: 'var(--ink)' }}>{detail.name}</div>
                  <span className={`pill s-${detail.state}`} style={{ textTransform: 'uppercase', fontSize: 11 }}>{detail.state}</span>
                  <span className="spacerx" style={{ flex: 1 }} />
                  <label className="muted" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                    Duration
                    <input type="number" min={1} max={180} defaultValue={detail.duration_minutes ?? 30} disabled={!manage}
                      onBlur={e => setDuration(Number(e.target.value))} style={{ width: 74 }} /> min
                  </label>
                  {manage && detail.state === 'draft' && <button className="btn green sm" onClick={() => act(api.publishSet(detail.id), 'Published')}>Publish</button>}
                  {manage && detail.state === 'published' && <button className="btn amber sm" onClick={() => act(api.retireSet(detail.id), 'Retired — removed from the student catalog')}>Retire</button>}
                  {manage && detail.state === 'draft' && <button className="btn danger sm" onClick={() => act(api.deleteSet(detail.id), 'Deleted').then(() => { setSelId(''); })}>Delete</button>}
                </div>

                {detail.question_count < 5 && <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Add at least 5 questions across the sections before this paper can be published (currently {detail.question_count}).</p>}

                {SECTION_KEYS.map(secKey => {
                  const qs = sectionQuestions(secKey);
                  return (
                    <div className="panel" key={secKey} style={{ marginTop: 12 }}>
                      <div className="panelhead" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3><button className="linklike" onClick={() => manage && detail.state === 'draft' && catIdFor(secKey) && setBattery(secKey)} style={{ font: 'inherit', color: 'var(--ink)' }}>{SECTION_LABEL[secKey]}</button> <span className="muted" style={{ fontSize: 12.5, fontWeight: 700 }}>· {qs.length} question{qs.length === 1 ? '' : 's'} · {detail.state === 'published' ? 'live' : 'draft'}</span></h3>
                        {manage && detail.state === 'draft' && catIdFor(secKey) && <button className="btn sm" onClick={() => setBattery(secKey)}>+ Add question</button>}
                      </div>
                      {qs.length === 0 ? <div className="empty">No {SECTION_LABEL[secKey]} questions yet.</div> : (
                        <div className="tablewrap"><table>
                          <tbody>{qs.map((q: any) => (
                            <tr key={q.id}>
                              <td><div className="qrow-prev">{q.preview || '(no text)'}</div><div className="muted" style={{ fontSize: 12 }}>{q.difficulty} · {q.state}</div></td>
                              {manage && detail.state === 'draft' && <td className="right" style={{ width: 90 }}><button className="btn danger sm" onClick={() => removeQuestion(q.id)}>Remove</button></td>}
                            </tr>
                          ))}</tbody>
                        </table></div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}

      {creating && tax && <NewExamPaper tax={tax} grade={grade} onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); loadSets(); setSelId(id); }} />}
      {pickSection && detail && <SectionPicker gradeNumber={detail.grade_number} categoryKey={pickSection} current={detail.questions.map((q: any) => q.id)} onClose={() => setPickSection(null)} onAdd={addQuestions} />}
      {battery && detail && tax && catIdFor(battery) && (
        <SetEditor taxonomy={tax} setId={detail.id} scopeCategoryId={catIdFor(battery)} scopeLabel={`${SECTION_LABEL[battery]} battery`}
          onClose={() => setBattery(null)} onSaved={() => loadDetail(detail.id)} />
      )}
    </div>
  );
}

function NewExamPaper({ tax, grade, onClose, onDone }: { tax: any; grade: string; onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState(''); const [dur, setDur] = useState('30'); const [g, setG] = useState(grade);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => {
    if (!name.trim()) { setErr('Name required'); return; }
    const gradeObj = tax.grades.find((x: any) => String(x.grade_number) === g);
    // Nominal category/subcategory anchors (exam papers span all three sections via their questions).
    const cat = tax.categories?.[0]; const sub = (tax.subcategories || []).find((s: any) => s.category_id === cat?.id);
    if (!gradeObj || !cat || !sub) { setErr('Taxonomy not ready'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.createSet({ name: name.trim(), grade_id: gradeObj.id, category_id: cat.id, subcategory_id: sub.id,
        allowed_practice: false, allowed_exam: true, allowed_timers: ['timed'], question_version_ids: [], duration_minutes: Math.max(1, Math.min(180, Number(dur) || 30)) });
      toast('Exam paper created'); onDone(r.set_version_id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="New exam paper" onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>Create</button></>}>
      <label>Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Form A" />
      <div className="row">
        <div className="grow"><label>Grade</label><select value={g} onChange={e => setG(e.target.value)}>{tax.grades.map((x: any) => <option key={x.id} value={x.grade_number}>Grade {x.grade_number}</option>)}</select></div>
        <div className="grow"><label>Duration (min)</label><input type="number" min={1} max={180} value={dur} onChange={e => setDur(e.target.value)} /></div>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>You'll add questions to the three sections (Verbal / Non-verbal / Quantitative) next.</p>
      <div className="err">{err}</div>
    </Modal>
  );
}

function SectionPicker({ gradeNumber, categoryKey, current, onClose, onAdd }: { gradeNumber: number; categoryKey: string; current: string[]; onClose: () => void; onAdd: (ids: string[]) => void }) {
  const [pool, setPool] = useState<any[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => {
    // eligible = approved or published questions in this grade + section (category).
    Promise.all([api.questions({ state: 'approved' }), api.questions({ state: 'published' })])
      .then(([a, p]) => setPool([...a.items, ...p.items].filter((q: any) => q.grade_number === gradeNumber && q.category_key === categoryKey && !current.includes(q.id))))
      .catch(() => setPool([]));
  }, []); // eslint-disable-line
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <Modal wide title={`Add ${SECTION_LABEL[categoryKey]} questions`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={sel.size === 0} onClick={() => onAdd([...sel])}>Add ({sel.size})</button></>}>
      {pool === null ? <div className="empty">Loading…</div> : pool.length === 0 ? <div className="empty">No eligible {SECTION_LABEL[categoryKey]} questions for Grade {gradeNumber} — add or publish some questions for this grade first.</div> : (
        <div style={{ maxHeight: 320, overflow: 'auto' }}>{pool.map(q => (
          <label key={q.id} className={`pickrow ${sel.has(q.id) ? 'sel' : ''}`}>
            <input type="checkbox" checked={sel.has(q.id)} onChange={() => toggle(q.id)} />
            <div className="grow"><div className="qrow-prev">{q.preview || '(no text)'}</div><div className="muted" style={{ fontSize: 12 }}>{q.difficulty} · {q.state}</div></div>
          </label>
        ))}</div>
      )}
    </Modal>
  );
}
