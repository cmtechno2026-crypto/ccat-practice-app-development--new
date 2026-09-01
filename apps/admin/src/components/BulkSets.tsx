import React, { useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Modal, useToast } from './ui';
import { SetEditor } from './SetEditor';
import { parseImportText, referencedImages, ImportCard, ImportError } from '../lib/importParse';
import { readBulkInput, matchImages, uploadImages, attachImages, BulkImage, MatchResult } from '../lib/bulkFile';
import { SAMPLE } from './BulkImport';

// "Bulk add sets" — takes ONE file/paste of MANY questions and splits it into SEVERAL draft practice
// sets, each capped at MAX_QUESTIONS_PER_SET, all inheriting the Content page's current context
// (grade / category / subcategory / difficulty). Reuses the SAME parser (parseImportText) and the SAME
// format sample as the single-set importer — no second parser, no parallel format. On confirm it loops
// the existing create-set + author (save-draft) endpoints once per chunk, then hands off to the existing
// SetEditor / publishSet flow for editing the (usually partial) last set and publishing. Nothing is
// persisted until the admin confirms.

// The per-set cap. Single source of truth — imported by Content for the "x / N" set-size bar too.
export const MAX_QUESTIONS_PER_SET = 15;
const SAMPLE_FILE = SAMPLE + '\n';

// Spreadsheet-style label: 1→A … 26→Z, 27→AA, 28→AB … (used for "Set A", "Set B", …).
function idxToLabel(n: number): string {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
// Pick `count` set labels not already used in this subcategory+difficulty, skipping taken letters and
// rolling over to double letters (AA, AB, …) past Z. Returns the labels and whether doubles were needed.
function assignLabels(count: number, used: Set<string>): { labels: string[]; usedDouble: boolean } {
  const labels: string[] = [];
  let idx = 0;
  let usedDouble = false;
  while (labels.length < count) {
    idx++;
    const label = idxToLabel(idx);
    if (used.has(label.toUpperCase())) continue;
    if (label.length > 1) usedDouble = true;
    labels.push(label);
  }
  return { labels, usedDouble };
}

type Ctx = { gradeId: string; catId: string; subId: string; diffId: string; qType: string;
  gradeNumber: number | string; categoryName: string; subcategoryName: string; difficultyLabel: string; diffKey: string };
type Created = { name: string; id: string; count: number; full: boolean };

export function BulkSets({ ctx, existingSets, onClose, onDone, taxonomy }: {
  ctx: Ctx; existingSets: any[]; taxonomy: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [cards, setCards] = useState<ImportCard[] | null>(null);
  const [errors, setErrors] = useState<ImportError[] | null>(null);
  const [images, setImages] = useState<Map<string, BulkImage>>(new Map());
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [fileErr, setFileErr] = useState('');
  const [showSample, setShowSample] = useState(false);
  const [showInstruction, setShowInstruction] = useState(false);
  const [copied, setCopied] = useState(false);
  const [step, setStep] = useState<'input' | 'preview' | 'created'>('input');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [created, setCreated] = useState<Created[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const ctxLine = `Grade ${ctx.gradeNumber} · ${ctx.categoryName} · ${ctx.subcategoryName} · ${ctx.difficultyLabel}`;

  // Letters already used by existing "Set X" names in the SAME subcategory + difficulty.
  const usedLetters = useMemo(() => {
    const used = new Set<string>();
    for (const s of existingSets) {
      if (s.subcategory_id !== ctx.subId || s.difficulty_key !== ctx.diffKey) continue;
      if (s.state === 'retired') continue; // a retired set's letter is free to reuse
      const m = /^Set\s+([A-Za-z]+)$/.exec((s.name ?? '').trim());
      if (m) used.add(m[1].toUpperCase());
    }
    return used;
  }, [existingSets, ctx.subId, ctx.diffKey]);

  // Split parsed questions (order preserved) into chunks of ≤ MAX, and assign collision-free names.
  const plan = useMemo(() => {
    if (!cards || !cards.length) return null;
    const chunks: ImportCard[][] = [];
    for (let i = 0; i < cards.length; i += MAX_QUESTIONS_PER_SET) chunks.push(cards.slice(i, i + MAX_QUESTIONS_PER_SET));
    const { labels, usedDouble } = assignLabels(chunks.length, usedLetters);
    return { chunks, labels, usedDouble, total: cards.length };
  }, [cards, usedLetters]);

  const runParse = (src: string, imgs: Map<string, BulkImage>) => {
    const res = parseImportText(src);
    if (res.ok) {
      setCards(res.cards); setErrors(null);
      const refs = referencedImages(res.cards);
      setMatch(refs.length || imgs.size ? matchImages(refs, imgs) : null);
    } else { setErrors(res.errors); setCards(null); setMatch(null); }
  };
  const parse = (src: string) => runParse(src, images);
  const onFile = async (f: File) => {
    setFileErr('');
    try { const inp = await readBulkInput(f); setImages(inp.images); setText(inp.text); runParse(inp.text, inp.images); }
    catch (e) { setFileErr((e as Error).message); }
  };
  const downloadSample = () => {
    const blob = new Blob([SAMPLE_FILE], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ccat-question-import-sample.md';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  const copyFormat = async () => {
    try { await navigator.clipboard.writeText(SAMPLE_FILE); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const cardToPayload = (c: ImportCard) => {
    const filled = c.opts.filter(o => o.text.trim() || o.img);
    const prompt_blocks: any[] = [];
    if (c.stem.trim()) prompt_blocks.push({ type: 'text', value: c.stem.trim() });
    if (c.img) prompt_blocks.push({ type: 'image', asset_id: c.img.asset_id, url: c.img.url, alt: c.img.alt ?? '' });
    if (!prompt_blocks.length) prompt_blocks.push({ type: 'text', value: '' });
    return {
      category_id: ctx.catId, subcategory_id: ctx.subId, grade_id: ctx.gradeId, difficulty_id: ctx.diffId,
      question_type: ctx.qType, prompt_blocks,
      option_blocks: filled.map(o => ({
        option_id: o.option_id,
        content: [
          ...(o.text.trim() ? [{ type: 'text', value: o.text.trim() }] : []),
          ...(o.img ? [{ type: 'image', asset_id: o.img.asset_id, url: o.img.url, alt: o.img.alt ?? '' }] : []),
        ],
      })),
      correct_option_ids: filled.filter(o => o.correct).map(o => o.option_id),
      explanation_blocks: c.explanation.trim() ? [{ type: 'text', value: c.explanation.trim() }] : null,
      active: true,
    };
  };

  // Create one draft set per chunk (reusing createSet + authorSet). Sequential so a failure stops before
  // creating the rest; already-created drafts are reported and left for the admin (they can delete/edit).
  const confirmCreate = async () => {
    if (!plan || !cards) return;
    if (match && match.missing.length) { setFileErr(`${match.missing.length} referenced image(s) are missing from the ZIP — fix before creating.`); return; }
    setBusy(true); setErrors(null); setFileErr('');
    const done: Created[] = [];
    try {
      // Upload every referenced figure ONCE, attach to the cards, then re-chunk in the same order so
      // figures ride along on their questions across the split.
      let resolved = cards;
      const refs = referencedImages(cards);
      if (refs.length) {
        setProgress(`Uploading ${refs.length} image${refs.length === 1 ? '' : 's'}…`);
        const uploaded = await uploadImages(refs, images, (m, b, a) => api.uploadAsset(m, b, a));
        resolved = attachImages(cards, uploaded);
      }
      const chunks: ImportCard[][] = [];
      for (let i = 0; i < resolved.length; i += MAX_QUESTIONS_PER_SET) chunks.push(resolved.slice(i, i + MAX_QUESTIONS_PER_SET));
      for (let i = 0; i < chunks.length; i++) {
        const name = `Set ${plan.labels[i]}`;
        setProgress(`Creating ${name} (${i + 1}/${chunks.length})…`);
        const r = await api.createSet({ name, grade_id: ctx.gradeId, category_id: ctx.catId, subcategory_id: ctx.subId, difficulty_id: ctx.diffId, allowed_practice: true, allowed_exam: false, allowed_timers: ['untimed'], question_version_ids: [] });
        await api.authorSet(r.set_version_id, chunks[i].map(cardToPayload));
        done.push({ name, id: r.set_version_id, count: chunks[i].length, full: chunks[i].length >= MAX_QUESTIONS_PER_SET });
      }
      setCreated(done);
      setStep('created');
      toast(`Created ${done.map(d => d.name).join(', ')} (${done.length} set${done.length === 1 ? '' : 's'}, ${plan.total} questions)`);
      onDone();
    } catch (e) {
      setCreated(done);
      setProgress('');
      setErrors([{ block: 0, line: 0, message: '', display: `${done.length} set(s) created before an error: ${(e as Error).message}. Created sets are drafts you can edit or delete.` }]);
      if (done.length) setStep('created');
    } finally { setBusy(false); setProgress(''); }
  };

  const publishOne = async (c: Created) => {
    try { await api.publishSet(c.id); toast(`${c.name} published`); onDone(); }
    catch (e) { toast(`${c.name}: ${(e as Error).message}`); }
  };
  const publishAll = async () => {
    setBusy(true);
    let ok = 0; const failed: string[] = [];
    for (const c of created) {
      try { await api.publishSet(c.id); ok++; } catch (e) { failed.push(`${c.name} (${(e as Error).message})`); }
    }
    onDone();
    setBusy(false);
    toast(failed.length ? `Published ${ok}; still draft: ${failed.join('; ')}` : `Published all ${ok} sets`);
  };

  const refreshCount = async (id: string) => {
    try { const d = await api.set(id); setCreated(cs => cs.map(c => c.id === id ? { ...c, count: (d.questions || []).length, full: (d.questions || []).length >= MAX_QUESTIONS_PER_SET } : c)); onDone(); } catch { /* ignore */ }
  };

  const shown = errors ? errors.slice(0, 10) : [];

  return (
    <>
      <Modal wide title="Bulk add sets" onClose={onClose}
        headerRight={step === 'input'
          ? <button className="btn ghost sm" onClick={() => setShowInstruction(s => !s)}>{showInstruction ? 'Hide instruction' : '❔ Instruction'}</button>
          : undefined}
        footer={step === 'input' ? (
          <><button className="btn ghost grow" onClick={onClose}>Cancel</button>
            <button className="btn grow" disabled={!cards || !cards.length || !!(match && match.missing.length)} onClick={() => setStep('preview')}>Preview split{cards && cards.length ? ` (${cards.length} questions)` : ''}</button></>
        ) : step === 'preview' ? (
          <><button className="btn ghost grow" onClick={() => setStep('input')} disabled={busy}>← Back</button>
            <button className="btn grow" disabled={busy || !plan} onClick={confirmCreate}>{busy ? (progress || 'Creating…') : `Create ${plan?.chunks.length ?? 0} draft set${(plan?.chunks.length ?? 0) === 1 ? '' : 's'}`}</button></>
        ) : (
          <><button className="btn ghost grow" onClick={onClose}>Done</button>
            <button className="btn grow" disabled={busy || !created.length} onClick={publishAll}>{busy ? 'Publishing…' : 'Publish all'}</button></>
        )}>

        <div className="infobox" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12.5 }}>New sets will be created in:</div>
          <div style={{ fontWeight: 800 }}>{ctxLine}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>Every generated set and question inherits this context. Max {MAX_QUESTIONS_PER_SET} questions per set.</div>
        </div>

        {step === 'input' && (
          <>
            <div className="rowactions" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
              <button className="btn ghost sm" onClick={downloadSample}>⤓ Download sample</button>
              <button className="btn ghost sm" onClick={copyFormat}>{copied ? '✓ Copied!' : '⧉ Copy format'}</button>
              <button className="btn ghost sm" onClick={() => setShowSample(s => !s)}>{showSample ? 'Hide format' : 'View format'}</button>
              <input ref={fileRef} type="file" accept=".md,.txt,.zip,text/markdown,text/plain,application/zip" hidden
                onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); if (fileRef.current) fileRef.current.value = ''; }} />
              <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Choose file… (.md/.txt/.zip)</button>
              <button className="btn sm" onClick={() => parse(text)} disabled={!text.trim()}>Parse &amp; check</button>
            </div>

            {showInstruction && (
              <div className="infobox" style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 800, marginBottom: 4 }}>How to bulk add sets (for beginners):</div>
                <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, fontSize: 13 }}>
                  <li>Click <b>Download sample</b> — or <b>Copy format</b> — to get the exact question format.</li>
                  <li>Paste that sample + all your questions into ChatGPT or Claude and ask: <i>"Rewrite my questions in exactly this format."</i></li>
                  <li>Copy the AI's result and paste it in the box below (or save as a .md/.txt file and use <b>Choose file…</b>).</li>
                  <li><b>Figures (optional):</b> add <code>Q-Image: file.png</code> / <code>A-Image: file.png</code> lines, put the .md/.txt + those images in ONE <b>.zip</b>, and choose the ZIP. PNG/JPG/WEBP, ≤2 MB each.</li>
                  <li>Click <b>Parse &amp; check</b> (it lists any missing images), fix flags, then <b>Preview split</b>.</li>
                  <li>Your questions are split into sets of {MAX_QUESTIONS_PER_SET} (Set A, Set B, …). Top up the last set if needed, then create and publish.</li>
                </ol>
              </div>
            )}

            {showSample && (
              <pre style={{ background: 'var(--panel, #f6f8fc)', border: '1px solid var(--line, #e3e8f0)', borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 1.5, overflow: 'auto', maxHeight: 240, whiteSpace: 'pre-wrap' }}>{SAMPLE}</pre>
            )}

            <label style={{ marginTop: 4 }}>✍️ Paste ALL your questions here — they'll be split into sets of {MAX_QUESTIONS_PER_SET} (a .zip for figures)</label>
            <textarea rows={7} value={text}
              onChange={e => { setText(e.target.value); setCards(null); setErrors(null); setMatch(null); }}
              placeholder={'Paste the AI-formatted questions here…\n\nQ: Which one is the odd one out?\nA) Circle\nB) Square\nC) Triangle\nD) Dog\nAnswer: D\nExplanation: Dog is not a shape.'}
              style={{ fontFamily: 'ui-monospace,monospace', fontSize: 12.5 }} />

            {fileErr && <div className="err" style={{ marginTop: 8 }}>{fileErr}</div>}

            {match && (match.referenced.length > 0 || images.size > 0) && (
              <div className="infobox" style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  Figures: {match.matched.length}/{match.referenced.length} matched{images.size ? ` · ${images.size} image${images.size === 1 ? '' : 's'} in ZIP` : ''}
                </div>
                {match.referenced.map(r => (
                  <div key={r} style={{ fontSize: 12.5, fontFamily: 'ui-monospace,monospace' }}>
                    {match.missing.includes(r) ? '✗ ' : '✓ '}{r}{match.missing.includes(r) && <b style={{ color: 'var(--coral)' }}> — MISSING</b>}
                  </div>
                ))}
                {match.missing.length > 0 && <div className="err" style={{ marginTop: 4 }}>Add the missing image(s) to the ZIP (or remove the reference) before creating.</div>}
                {match.unused.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Not referenced (ignored): {match.unused.join(', ')}</div>}
              </div>
            )}

            {errors && errors.length > 0 && (
              <div className="err" style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Nothing was split — fix these and Parse &amp; check again:</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, listStyle: 'disc' }}>
                  {shown.map((e, i) => <li key={i} style={{ fontFamily: 'ui-monospace,monospace' }}>{e.display}</li>)}
                </ul>
                {errors.length > shown.length && <div style={{ marginTop: 6 }}>…and {errors.length - shown.length} more.</div>}
              </div>
            )}
            {cards && cards.length > 0 && (
              <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>{cards.length} question{cards.length === 1 ? '' : 's'} parsed ✓ — Preview split to see the sets.</div>
            )}
          </>
        )}

        {step === 'preview' && plan && (
          <>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{plan.total} questions → {plan.chunks.length} set{plan.chunks.length === 1 ? '' : 's'}</div>
            <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
              {plan.chunks.map((ch, i) => {
                const full = ch.length >= MAX_QUESTIONS_PER_SET;
                return (
                  <div key={i} className="pickrow" style={{ justifyContent: 'space-between' }}>
                    <div><b>Set {plan.labels[i]}</b> <span className="muted" style={{ fontSize: 12 }}>· {ctx.subcategoryName} · {ctx.difficultyLabel}</span></div>
                    <div className="tabnum" style={{ fontWeight: 700, color: full ? 'var(--green)' : 'var(--amber)' }}>{ch.length} / {MAX_QUESTIONS_PER_SET}{full ? '' : ' (partial)'}</div>
                  </div>
                );
              })}
            </div>
            {plan.usedDouble && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>More than 26 names needed — continued with double letters (Set AA, AB, …).</div>}
            <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>The last set may be partial. After creating, open it to add questions before publishing, or leave it as a draft. Nothing is saved until you press Create.</div>
          </>
        )}

        {step === 'created' && (
          <>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Created {created.length} draft set{created.length === 1 ? '' : 's'}.</div>
            {errors && errors.length > 0 && <div className="err" style={{ marginBottom: 8 }}>{errors[0].display}</div>}
            <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
              {created.map(c => (
                <div key={c.id} className="pickrow" style={{ justifyContent: 'space-between' }}>
                  <div><b>{c.name}</b> <span className="tabnum muted" style={{ fontSize: 12 }}>· {c.count} / {MAX_QUESTIONS_PER_SET}{c.full ? '' : ' (partial)'}</span></div>
                  <div className="rowactions">
                    <button className="btn ghost sm" onClick={() => setEditingId(c.id)}>Open / Edit</button>
                    <button className="btn sm" disabled={busy} onClick={() => publishOne(c)}>Publish</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Publishing enforces the usual rules — a set below the minimum stays a draft until you add questions (open the partial set to top it up).</div>
          </>
        )}
      </Modal>

      {editingId && taxonomy && (
        <SetEditor taxonomy={taxonomy} setId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => refreshCount(editingId)} />
      )}
    </>
  );
}
