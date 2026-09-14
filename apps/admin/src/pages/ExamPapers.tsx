import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Loading, ErrorBox, Modal, useToast } from '../components/ui';
import { ContentTabs } from './Content';
import { BulkSets } from '../components/BulkSets';

// EXAM PAPERS (new model): Battery (category) → Sets → Questions. No subcategory.
// Pick a battery pill → see that battery's single-battery exam sets → add / bulk-add sets → each set has
// its own time limit and up to 60 questions from that battery. Backend accepts allowed_exam sets with a
// NULL subcategory (see admin-content-authoring create + /questions cap = 60).

const BATTERIES = [
  { key: 'verbal', label: 'Verbal', color: '#5b8def' },
  { key: 'quantitative', label: 'Quantitative', color: '#12b886' },
  { key: 'non_verbal', label: 'Non-verbal', color: '#7b61ff' },
];
const MAX_Q = 60;
const slugKey = (s: string) => (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function ExamPapers() {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('content.create');
  const [tax, setTax] = useState<any>(null);
  const [sets, setSets] = useState<any[] | null>(null);
  const [error, setError] = useState<any>(null);
  const [grade, setGrade] = useState<string>('');
  const [battery, setBattery] = useState<string>('verbal');
  const [selId, setSelId] = useState<string>('');
  const [detail, setDetail] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [pick, setPick] = useState(false);

  const catIdFor = (key: string) => (tax?.categories ?? []).find((c: any) => c.key === key)?.id as string | undefined;

  const loadSets = () => api.sets().then(r => setSets(r.items)).catch(setError);
  useEffect(() => { loadSets(); api.taxonomy().then(setTax).catch(() => {}); }, []);
  useEffect(() => { if (!grade && tax?.grades?.length) setGrade(String(tax.grades[0].grade_number)); }, [tax]); // eslint-disable-line

  // Exam sets in this grade + selected battery.
  const examSets = useMemo(() => (sets || []).filter(s =>
    s.allowed_exam && (!grade || String(s.grade_number) === grade) && s.category_id === catIdFor(battery)
  ), [sets, grade, battery, tax]); // eslint-disable-line

  useEffect(() => {
    if (examSets.length && !examSets.some(f => f.id === selId)) setSelId(examSets[0].id);
    if (!examSets.length) { setSelId(''); setDetail(null); }
  }, [examSets]); // eslint-disable-line

  const loadDetail = (id: string) => { if (!id) return setDetail(null); api.set(id).then(setDetail).catch(() => setDetail(null)); };
  useEffect(() => { loadDetail(selId); }, [selId]); // eslint-disable-line

  const refresh = () => { loadSets(); if (selId) loadDetail(selId); };
  const act = async (fn: Promise<any>, m: string) => { try { await fn; toast(m); refresh(); } catch (e) { toast((e as Error).message); } };

  const setDuration = async (mins: number) => {
    if (!detail) return;
    const v = Math.max(1, Math.min(180, Math.round(mins) || 0));
    await act(api.patchSet(detail.id, { duration_minutes: v }), `Time limit ${v} min`);
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
    if (ids.length > MAX_Q) { toast(`An exam set holds at most ${MAX_Q} questions`); return; }
    await act(api.setMembership(detail.id, ids), 'Questions added');
    setPick(false);
  };

  const gradeObj = tax?.grades?.find((g: any) => String(g.grade_number) === grade);

  return (
    <div>
      <div className="toolbar" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 22 }}>Content</h2>
          <p className="lead" style={{ marginBottom: 0 }}>Exam papers are single-battery timed sets. Pick a battery, add sets, then publish.</p>
        </div>
        <div className="row" style={{ margin: 0, gap: 8 }}>
          {manage && <button className="btn ghost" onClick={() => { if (!catIdFor(battery)) { toast('Pick a battery first'); return; } setBulk(true); }}>⤓ Bulk add sets</button>}
          {manage && <button className="btn" onClick={() => setCreating(true)}>+ New exam set</button>}
        </div>
      </div>

      <div className="contentnav">
        <ContentTabs active="exam" />
        {tax && (
          <label className="gradesel">GRADE
            <select value={grade} onChange={e => setGrade(e.target.value)}>
              {tax.grades.map((g: any) => <option key={g.id} value={g.grade_number}>Grade {g.grade_number}</option>)}
            </select>
          </label>
        )}
      </div>

      {/* battery selector */}
      <div className="row" style={{ gap: 10, margin: '6px 0 16px', flexWrap: 'wrap' }}>
        {BATTERIES.map(b => {
          const on = battery === b.key;
          const count = (sets || []).filter(s => s.allowed_exam && (!grade || String(s.grade_number) === grade) && s.category_id === catIdFor(b.key)).length;
          return (
            <button key={b.key} onClick={() => setBattery(b.key)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 999,
                border: `2px solid ${on ? b.color : 'transparent'}`, background: on ? '#fff' : '#f2f4f9',
                color: on ? b.color : '#2a3450', fontWeight: 700, fontFamily: 'Poppins, sans-serif', cursor: 'pointer' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: b.color }} />
              {b.label} <span style={{ fontSize: 12, color: '#9aa3b5' }}>{count}</span>
            </button>
          );
        })}
      </div>

      {error ? <ErrorBox e={error} /> : sets === null ? <Loading /> : (
        <div className="contentgrid" style={{ gridTemplateColumns: '280px 1fr' }}>
          {/* set list for this battery */}
          <aside className="cattree">
            {examSets.length === 0 && <div className="muted" style={{ padding: 10, fontSize: 13 }}>No {BATTERIES.find(b => b.key === battery)?.label} exam sets in Grade {grade} yet.</div>}
            {examSets.map(f => (
              <button key={f.id} className={`treesub ${selId === f.id ? 'on' : ''}`} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} onClick={() => setSelId(f.id)}>
                <span style={{ fontWeight: 700 }}>{f.name}</span>
                <span className="muted tabnum" style={{ fontSize: 12 }}>{f.question_count} q · {f.duration_minutes ? `${f.duration_minutes} min` : 'no time'} · {f.state}</span>
              </button>
            ))}
          </aside>

          {/* selected set editor */}
          <div>
            {!detail ? <div className="panel"><div className="empty">Select or create an exam set.</div></div> : (
              <>
                <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ fontFamily: 'Baloo 2', fontSize: 20, color: 'var(--ink)' }}>{detail.name}</div>
                  <span className={`pill s-${detail.state}`} style={{ textTransform: 'uppercase', fontSize: 11 }}>{detail.state}</span>
                  <label className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>⏱ Time limit
                    <input key={`${detail.id}-${detail.duration_minutes}`} type="number" min={1} max={180} defaultValue={detail.duration_minutes ?? 30} disabled={!manage}
                      onBlur={e => setDuration(Number(e.target.value))} style={{ width: 64 }} /> min</label>
                  <span className="spacerx" style={{ flex: 1 }} />
                  <span className="muted" style={{ fontSize: 13 }}>{detail.question_count} / {MAX_Q} questions</span>
                  {manage && detail.state === 'draft' && <button className="btn green sm" onClick={() => act(api.publishSet(detail.id), 'Published')}>Publish</button>}
                  {manage && detail.state === 'published' && <button className="btn amber sm" onClick={() => act(api.retireSet(detail.id), 'Retired — removed from the student catalog')}>Retire</button>}
                  {manage && (detail.state === 'draft' || detail.state === 'retired') && <button className="btn danger sm" onClick={async () => { try { await api.deleteSet(detail.id); toast('Deleted'); setSelId(''); setDetail(null); loadSets(); } catch (e) { toast((e as Error).message); } }}>Delete</button>}
                </div>

                {detail.question_count < 5 && <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Add at least 5 questions before this set can be published (currently {detail.question_count}).</p>}

                <div className="panel" style={{ marginTop: 12 }}>
                  <div className="panelhead" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3>Questions <span className="muted" style={{ fontSize: 12.5, fontWeight: 700 }}>· {detail.question_count} of {MAX_Q}</span></h3>
                    {manage && detail.state === 'draft' && <button className="btn sm" onClick={() => setPick(true)}>+ Add question</button>}
                  </div>
                  {(detail.questions || []).length === 0 ? <div className="empty">No questions yet.</div> : (
                    <div className="tablewrap"><table>
                      <tbody>{detail.questions.map((q: any) => (
                        <tr key={q.id}>
                          <td><div className="qrow-prev">{q.preview || '(no text)'}</div><div className="muted" style={{ fontSize: 12 }}>{q.difficulty} · {q.state}</div></td>
                          {manage && detail.state === 'draft' && <td className="right" style={{ width: 90 }}><button className="btn danger sm" onClick={() => removeQuestion(q.id)}>Remove</button></td>}
                        </tr>
                      ))}</tbody>
                    </table></div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {creating && tax && gradeObj && catIdFor(battery) && (
        <NewExamSet gradeObj={gradeObj} categoryId={catIdFor(battery)!} batteryLabel={BATTERIES.find(b => b.key === battery)!.label}
          onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); loadSets(); setSelId(id); }} />
      )}
      {bulk && tax && gradeObj && catIdFor(battery) && (() => {
        const catId = catIdFor(battery)!;
        const subObj = (tax.subcategories || []).filter((s: any) => s.category_id === catId).sort((a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0))[0];
        const diffObj = (tax.difficulties || []).find((d: any) => d.key === 'medium') || (tax.difficulties || [])[0];
        const catObj = (tax.categories || []).find((c: any) => c.id === catId);
        if (!subObj || !diffObj || !catObj) { toast('Add a subcategory + difficulty to this battery first'); setBulk(false); return null; }
        return (
          <BulkSets exam taxonomy={tax} existingSets={examSets}
            ctx={{ gradeId: gradeObj.id, catId, subId: subObj.id, diffId: diffObj.id,
              qType: slugKey(subObj.key) || 'verbal_analogy',
              gradeNumber: gradeObj.grade_number, categoryName: catObj.name, subcategoryName: subObj.name,
              difficultyLabel: diffObj.name, diffKey: diffObj.key, maxPerSet: 15 }}
            onClose={() => setBulk(false)} onDone={() => loadSets()} />
        );
      })()}
      {pick && detail && (
        <QuestionPicker gradeNumber={detail.grade_number} categoryKey={battery} current={detail.questions.map((q: any) => q.id)}
          remaining={MAX_Q - detail.question_count} onClose={() => setPick(false)} onAdd={addQuestions} />
      )}
    </div>
  );
}

function NewExamSet({ gradeObj, categoryId, batteryLabel, onClose, onDone }: { gradeObj: any; categoryId: string; batteryLabel: string; onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState(''); const [dur, setDur] = useState('25');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => {
    if (!name.trim()) { setErr('Name required'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.createSet({
        name: name.trim(), grade_id: gradeObj.id, category_id: categoryId,
        allowed_practice: false, allowed_exam: true, allowed_timers: ['timed'],
        question_version_ids: [], duration_minutes: Math.max(1, Math.min(180, Number(dur) || 25)),
      });
      toast('Exam set created'); onDone(r.set_version_id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`New ${batteryLabel} exam set`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>Create</button></>}>
      <label>Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Verbal — Set 1" />
      <label style={{ marginTop: 10 }}>Time limit (min)</label>
      <input type="number" min={1} max={180} value={dur} onChange={e => setDur(e.target.value)} />
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Single-battery ({batteryLabel}) timed set. Add up to {MAX_Q} questions next.</p>
      <div className="err">{err}</div>
    </Modal>
  );
}

function QuestionPicker({ gradeNumber, categoryKey, current, remaining, onClose, onAdd }: { gradeNumber: number; categoryKey: string; current: string[]; remaining: number; onClose: () => void; onAdd: (ids: string[]) => void }) {
  const [pool, setPool] = useState<any[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => {
    Promise.all([api.questions({ state: 'approved' }), api.questions({ state: 'published' })])
      .then(([a, p]) => setPool([...a.items, ...p.items].filter((q: any) => q.grade_number === gradeNumber && q.category_key === categoryKey && !current.includes(q.id))))
      .catch(() => setPool([]));
  }, []); // eslint-disable-line
  const toggle = (id: string) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else { if (n.size >= remaining) return n; n.add(id); } return n; });
  return (
    <Modal wide title={`Add questions (${remaining} slot${remaining === 1 ? '' : 's'} left)`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={sel.size === 0} onClick={() => onAdd([...sel])}>Add ({sel.size})</button></>}>
      {pool === null ? <div className="empty">Loading…</div> : pool.length === 0 ? <div className="empty">No eligible questions for this battery in Grade {gradeNumber} — add or publish some questions first.</div> : (
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
