import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Modal, useToast } from './ui';

// CreateSet — the "New set / New exam paper" dialog used by the canonical Content flow (pages/Content).
// A new set is created EMPTY; the shared editor authors questions inline (Google-Forms flow). At create
// time the admin chooses how the editor should open: with one blank question card ready to fill, or with
// the "Bulk add from file" importer already open to seed many questions at once. Both hand off to the
// existing SetEditor — no question is persisted here.

export function CreateSet({ mode, taxonomy, onClose, onDone, prefill }: {
  mode: 'practice' | 'exam'; taxonomy: any; onClose: () => void;
  onDone: (id: string, opts?: { blank?: boolean; bulk?: boolean }) => void;
  prefill?: { gradeId?: string; catId?: string; subId?: string; diffId?: string };
}) {
  const toast = useToast();
  const cats = taxonomy.categories ?? []; const subs = taxonomy.subcategories ?? []; const grades = taxonomy.grades ?? []; const diffs = taxonomy.difficulties ?? [];
  const [name, setName] = useState('');
  const [gradeId, setGradeId] = useState(prefill?.gradeId ?? grades[0]?.id ?? '');
  const [catId, setCatId] = useState(prefill?.catId ?? cats[0]?.id ?? '');
  const [subId, setSubId] = useState(prefill?.subId ?? '');
  const [diffId, setDiffId] = useState(prefill?.diffId ?? diffs[0]?.id ?? '');
  // How the new (empty) set opens in the editor. Default: neither — start empty (matches prior default).
  const [startBlank, setStartBlank] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const subFor = subs.filter((s: any) => s.category_id === catId);
  // Reset subcategory when the category changes, unless the current sub already belongs to it (prefill).
  useEffect(() => { setSubId(cur => subFor.some((s: any) => s.id === cur) ? cur : (subFor[0]?.id ?? '')); }, [catId]); // eslint-disable-line

  // Create the empty set, then hand off to the editor. `bulk` opens the Bulk-add-from-file panel on the
  // new set immediately (imported questions win — no stray blank card is forced in front of them).
  const create = async (bulk: boolean) => {
    if (!name.trim()) { setErr('Name required'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.createSet({ name: name.trim(), grade_id: gradeId, category_id: catId, subcategory_id: subId, difficulty_id: diffId, allowed_practice: mode === 'practice', allowed_exam: mode === 'exam', allowed_timers: mode === 'exam' ? ['timed'] : ['untimed'], question_version_ids: [] });
      toast('Set created');
      onDone(r.set_version_id, { blank: bulk ? false : startBlank, bulk });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal wide title={`New ${mode === 'exam' ? 'exam paper' : 'practice set'}`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={() => create(false)}>Create</button></>}>
      <label>Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder={mode === 'exam' ? 'Grade 5 Full Form A' : 'Verbal Analogies · Medium'} />
      <div className="editor"><div className="grid2">
        <div><label>Grade</label><select value={gradeId} onChange={e => setGradeId(e.target.value)}>{grades.map((g: any) => <option key={g.id} value={g.id}>Grade {g.grade_number}</option>)}</select></div>
        <div><label>Category</label><select value={catId} onChange={e => setCatId(e.target.value)}>{cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label>Subcategory</label><select value={subId} onChange={e => setSubId(e.target.value)}>{subFor.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label>Difficulty</label><select value={diffId} onChange={e => setDiffId(e.target.value)}>{diffs.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
      </div></div>

      <label style={{ marginTop: 14 }}>How do you want to start?</label>
      <label className="edcheck" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={startBlank} onChange={e => setStartBlank(e.target.checked)} />
        Start with one empty question <span className="muted">(otherwise the set starts empty)</span>
      </label>
      <div className="rowactions" style={{ marginTop: 10 }}>
        <button className="btn ghost sm" disabled={busy} onClick={() => create(true)} title="Create the set and open the Bulk add from file importer">
          ⤓ Bulk add from file…
        </button>
        <span className="muted" style={{ fontSize: 12 }}>Import many questions from a .md/.txt file right away.</span>
      </div>

      <div className="err">{err}</div>
    </Modal>
  );
}
