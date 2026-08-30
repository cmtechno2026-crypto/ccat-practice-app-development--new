import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Modal, useToast } from './ui';

// Create or edit a DRAFT question. Builds the block-based prompt/option/explanation payloads the
// Gateway expects, supports an optional prompt image (uploaded via the storage service), and
// enforces 2–6 options with at least one correct answer before saving.
interface Props {
  taxonomy: any;
  editing?: any | null; // question detail when editing a draft
  onClose: () => void;
  onSaved: () => void;
}

type Opt = { option_id: string; text: string; correct: boolean };

function textFromBlocks(blocks: any): string {
  if (!Array.isArray(blocks)) return '';
  return blocks.map((b: any) => (b?.type === 'text' || b?.type === 'rich_text' || b?.type === 'math' ? String(b.value ?? '') : '')).join(' ').trim();
}
function imageBlock(blocks: any): { asset_id: string; url: string; alt?: string } | null {
  if (!Array.isArray(blocks)) return null;
  const b = blocks.find((x: any) => x?.type === 'image');
  return b ? { asset_id: b.asset_id, url: b.url, alt: b.alt } : null;
}

export function QuestionEditor({ taxonomy, editing, onClose, onSaved }: Props) {
  const toast = useToast();
  const isEdit = !!editing;
  const cats = taxonomy?.categories ?? [];
  const subs = taxonomy?.subcategories ?? [];
  const diffs = taxonomy?.difficulties ?? [];
  const grades = taxonomy?.grades ?? [];

  const [categoryId, setCategoryId] = useState(editing?.category_id ?? cats[0]?.id ?? '');
  const [subId, setSubId] = useState(editing?.subcategory_id ?? '');
  const [gradeId, setGradeId] = useState(editing?.grade_id ?? grades[0]?.id ?? '');
  const [diffId, setDiffId] = useState(editing?.difficulty_id ?? diffs[0]?.id ?? '');
  const [type, setType] = useState(editing?.question_type ?? 'verbal_analogy');
  const [stem, setStem] = useState(editing ? textFromBlocks(editing.prompt_blocks) : '');
  const [explanation, setExplanation] = useState(editing ? textFromBlocks(editing.explanation_blocks) : '');
  const [img, setImg] = useState<{ asset_id: string; url: string; alt?: string } | null>(editing ? imageBlock(editing.prompt_blocks) : null);
  const [opts, setOpts] = useState<Opt[]>(() => {
    if (editing?.option_blocks) {
      const correct = new Set<string>(editing.correct_option_ids ?? []);
      return editing.option_blocks.map((o: any) => ({ option_id: o.option_id, text: textFromBlocks(o.content), correct: correct.has(o.option_id) }));
    }
    return [{ option_id: 'a', text: '', correct: true }, { option_id: 'b', text: '', correct: false }, { option_id: 'c', text: '', correct: false }, { option_id: 'd', text: '', correct: false }];
  });
  const [multi, setMulti] = useState(() => (editing?.correct_option_ids?.length ?? 0) > 1 || editing?.question_type === 'multi_select');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const subForCat = subs.filter((s: any) => s.category_id === categoryId);
  useEffect(() => { if (!subForCat.find((s: any) => s.id === subId)) setSubId(subForCat[0]?.id ?? ''); }, [categoryId]); // eslint-disable-line

  const setOpt = (i: number, patch: Partial<Opt>) => setOpts(o => o.map((x, j) => j === i ? { ...x, ...patch } : x));
  const markCorrect = (i: number) => setOpts(o => o.map((x, j) => ({ ...x, correct: j === i })));
  const toggleCorrect = (i: number) => setOpts(o => o.map((x, j) => j === i ? { ...x, correct: !x.correct } : x));
  const addOpt = () => { if (opts.length >= 6) return; const id = 'abcdef'[opts.length]; setOpts(o => [...o, { option_id: id, text: '', correct: false }]); };
  const rmOpt = (i: number) => { if (opts.length <= 2) return; setOpts(o => o.filter((_, j) => j !== i)); };

  const pickImage = async (f: File) => {
    if (f.size > 5 * 1024 * 1024) { setErr('Image exceeds 5 MB'); return; }
    const buf = await f.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    try { const r = await api.uploadAsset(f.type, b64, stem.slice(0, 80)); setImg({ asset_id: r.id, url: r.url, alt: stem.slice(0, 80) }); toast('Image uploaded'); }
    catch (e) { setErr((e as Error).message); }
  };

  const save = async () => {
    setErr('');
    if (!stem.trim()) { setErr('Question text is required'); return; }
    if (!subId) { setErr('Pick a subcategory'); return; }
    const filled = opts.filter(o => o.text.trim());
    if (filled.length < 2) { setErr('At least 2 options with text'); return; }
    if (!filled.some(o => o.correct)) { setErr('Mark the correct answer'); return; }
    const prompt_blocks: any[] = [{ type: 'text', value: stem.trim() }];
    if (img) prompt_blocks.push({ type: 'image', asset_id: img.asset_id, url: img.url, alt: img.alt ?? '' });
    const option_blocks = filled.map(o => ({ option_id: o.option_id, content: [{ type: 'text', value: o.text.trim() }] }));
    const correct_option_ids = filled.filter(o => o.correct).map(o => o.option_id);
    const explanation_blocks = explanation.trim() ? [{ type: 'text', value: explanation.trim() }] : undefined;
    setBusy(true);
    try {
      if (isEdit) {
        await api.editQuestion(editing.id, { grade_id: gradeId, difficulty_id: diffId, question_type: type, prompt_blocks, option_blocks, correct_option_ids, explanation_blocks });
        toast('Draft updated');
      } else {
        await api.createQuestion({ category_id: categoryId, subcategory_id: subId, grade_id: gradeId, difficulty_id: diffId, question_type: type, prompt_blocks, option_blocks, correct_option_ids, explanation_blocks });
        toast('Draft created');
      }
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal wide title={isEdit ? 'Edit draft question' : 'New question'} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save as draft'}</button></>}>
      <div className="editor">
        <div className="grid2">
          <div>
            <label>Category</label>
            <select value={categoryId} onChange={e => setCategoryId(e.target.value)} disabled={isEdit}>
              {cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label>Subcategory</label>
            <select value={subId} onChange={e => setSubId(e.target.value)} disabled={isEdit}>
              {subForCat.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label>Grade</label>
            <select value={gradeId} onChange={e => setGradeId(e.target.value)}>
              {grades.map((g: any) => <option key={g.id} value={g.id}>Grade {g.grade_number}</option>)}
            </select>
          </div>
          <div>
            <label>Difficulty</label>
            <select value={diffId} onChange={e => setDiffId(e.target.value)}>
              {diffs.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        </div>

        <label>Question type</label>
        <input value={type} onChange={e => setType(e.target.value)} placeholder="e.g. verbal_analogy, number_series" />

        <label>Question text</label>
        <textarea rows={3} value={stem} onChange={e => setStem(e.target.value)} placeholder="Bird is to nest as bee is to ______." />

        <label>Question image (optional)</label>
        <div className="dropz" onClick={() => fileRef.current?.click()}>
          {img ? <><div>Image attached · click to replace</div><img src={img.url} alt={img.alt ?? ''} /></> : 'Click to upload a PNG or JPG (shown above the question).'}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) pickImage(f); }} />
        </div>

        <div className="rowactions" style={{ marginTop: 14, justifyContent: 'space-between' }}>
          <label style={{ margin: 0 }}>Options — mark {multi ? 'all correct answers' : 'the correct answer'}</label>
          <label className="muted" style={{ margin: 0, fontSize: 12.5 }}><input type="checkbox" checked={multi} onChange={e => {
            const on = e.target.checked; setMulti(on);
            if (!on) setOpts(o => o.map((x, j) => ({ ...x, correct: j === Math.max(0, o.findIndex(y => y.correct)) })));
          }} style={{ width: 'auto', marginRight: 6 }} />Multiple correct</label>
        </div>
        {opts.map((o, i) => (
          <div className="opt" key={i}>
            <label className="mark"><input type={multi ? 'checkbox' : 'radio'} name="correct" checked={o.correct} onChange={() => multi ? toggleCorrect(i) : markCorrect(i)} style={{ width: 'auto' }} /> {o.option_id.toUpperCase()}</label>
            <input type="text" value={o.text} onChange={e => setOpt(i, { text: e.target.value })} placeholder={`Option ${o.option_id.toUpperCase()}`} />
            {opts.length > 2 && <button className="rm" onClick={() => rmOpt(i)} title="Remove">✕</button>}
          </div>
        ))}
        {opts.length < 6 && <button className="btn ghost sm" onClick={addOpt}>+ Add option</button>}

        <label style={{ marginTop: 14 }}>Explanation (optional)</label>
        <textarea rows={2} value={explanation} onChange={e => setExplanation(e.target.value)} placeholder="Why the answer is correct — shown after review." />

        <div className="err">{err}</div>
      </div>
    </Modal>
  );
}
