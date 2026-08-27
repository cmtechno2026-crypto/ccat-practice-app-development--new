import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Modal, useToast } from './ui';

// CreateSet — the "New set / New exam paper" dialog used by the canonical Content flow (pages/Content
// + pages/ExamPapers). The old standalone SetsView / SetDetail browser (routed at /content/sets) was a
// duplicate of the Content set-browser + shared SetEditor and has been removed; this file now exports
// only the create dialog. A set may start empty (the shared editor authors questions inline) or be
// seeded from approved/published pool questions here.

export function CreateSet({ mode, taxonomy, onClose, onDone, prefill }: { mode: 'practice' | 'exam'; taxonomy: any; onClose: () => void; onDone: (id: string) => void; prefill?: { gradeId?: string; catId?: string; subId?: string; diffId?: string } }) {
  const toast = useToast();
  const cats = taxonomy.categories ?? []; const subs = taxonomy.subcategories ?? []; const grades = taxonomy.grades ?? []; const diffs = taxonomy.difficulties ?? [];
  const [name, setName] = useState('');
  const [gradeId, setGradeId] = useState(prefill?.gradeId ?? grades[0]?.id ?? '');
  const [catId, setCatId] = useState(prefill?.catId ?? cats[0]?.id ?? '');
  const [subId, setSubId] = useState(prefill?.subId ?? '');
  const [diffId, setDiffId] = useState(prefill?.diffId ?? diffs[0]?.id ?? '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [pool, setPool] = useState<any[]>([]); const [poolLoading, setPoolLoading] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const subFor = subs.filter((s: any) => s.category_id === catId);
  const gradeNumber = grades.find((g: any) => g.id === gradeId)?.grade_number;
  // Reset subcategory when the category changes, unless the current sub already belongs to it (prefill).
  useEffect(() => { setSubId(cur => subFor.some((s: any) => s.id === cur) ? cur : (subFor[0]?.id ?? '')); }, [catId]); // eslint-disable-line

  // eligible questions = approved + published for the chosen grade
  useEffect(() => {
    let alive = true;
    (async () => {
      setPoolLoading(true);
      const [a, p] = await Promise.all([api.questions({ state: 'approved' }), api.questions({ state: 'published' })]);
      if (!alive) return;
      setPool([...a.items, ...p.items].filter((q: any) => q.grade_number === gradeNumber));
      setSel(new Set()); setPoolLoading(false);
    })();
    return () => { alive = false; };
  }, [gradeNumber]);

  const toggle = (qid: string) => setSel(s => { const n = new Set(s); n.has(qid) ? n.delete(qid) : n.add(qid); return n; });
  const save = async () => {
    if (!name.trim()) { setErr('Name required'); return; }
    // Empty draft is allowed — the shared editor then authors questions inline (Google-Forms flow).
    // If the picker was used, keep the 5–20 bound; publishing enforces the ≥5 minimum regardless.
    if (sel.size > 0 && (sel.size < 5 || sel.size > 20)) { setErr('Either start empty and add questions in the editor, or pick between 5 and 20 existing questions'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.createSet({ name: name.trim(), grade_id: gradeId, category_id: catId, subcategory_id: subId, difficulty_id: diffId, allowed_practice: mode === 'practice', allowed_exam: mode === 'exam', allowed_timers: mode === 'exam' ? ['timed'] : ['untimed'], question_version_ids: [...sel] });
      toast('Set created'); onDone(r.set_version_id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={`New ${mode === 'exam' ? 'exam paper' : 'practice set'}`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>Create ({sel.size})</button></>}>
      <label>Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder={mode === 'exam' ? 'Grade 5 Full Form A' : 'Verbal Analogies · Medium'} />
      <div className="editor"><div className="grid2">
        <div><label>Grade</label><select value={gradeId} onChange={e => setGradeId(e.target.value)}>{grades.map((g: any) => <option key={g.id} value={g.id}>Grade {g.grade_number}</option>)}</select></div>
        <div><label>Category</label><select value={catId} onChange={e => setCatId(e.target.value)}>{cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label>Subcategory</label><select value={subId} onChange={e => setSubId(e.target.value)}>{subFor.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label>Difficulty</label><select value={diffId} onChange={e => setDiffId(e.target.value)}>{diffs.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
      </div></div>
      <label>Questions — optional: pick 5 to 20 existing (approved or published, Grade {gradeNumber}), or start empty and author in the editor</label>
      <div className="aihint" style={{ background: 'var(--tint)', color: 'var(--primary-ink)' }}>Selected: <b>{sel.size}</b> — leave at 0 to start empty.</div>
      <div style={{ maxHeight: 260, overflow: 'auto', marginTop: 8 }}>
        {poolLoading ? <div className="empty">Loading…</div> : pool.length === 0 ? <div className="empty">No eligible pool questions for this grade — you can start empty and add questions in the editor.</div> : pool.map(q => (
          <label className={`pickrow ${sel.has(q.id) ? 'sel' : ''}`} key={q.id}>
            <input type="checkbox" checked={sel.has(q.id)} onChange={() => toggle(q.id)} />
            <div className="grow"><div className="qrow-prev">{q.preview || '(no text)'}</div><div className="muted" style={{ fontSize: 12 }}>{q.category} · {q.difficulty} · {q.state}</div></div>
          </label>
        ))}
      </div>
      <div className="err">{err}</div>
    </Modal>
  );
}
