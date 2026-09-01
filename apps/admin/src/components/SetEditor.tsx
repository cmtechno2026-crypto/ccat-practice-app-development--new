import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from './ui';
import { BulkImport } from './BulkImport';

// One shared, Google-Forms-style question editor for BOTH practice sets and exam-paper batteries.
// Opens as a full-height drawer over the Content page. Collects ONE or MANY question cards and saves
// them together (batch author endpoint). For an exam battery, `scopeCategoryId` scopes the card list
// to that CCAT battery (category) and the save preserves the other two batteries.

type ImgRef = { asset_id: string; url: string; alt?: string };
type Opt = { option_id: string; text: string; correct: boolean; img?: ImgRef | null };
type Card = { key: string; id?: string; stem: string; type: string; opts: Opt[]; explanation: string; active: boolean; img?: { asset_id: string; url: string; alt?: string } | null };

const OPTION_IDS = 'abcdef';
let seq = 0;
const newKey = () => `c${++seq}`;
const textFromBlocks = (blocks: any): string => Array.isArray(blocks)
  ? blocks.map((b: any) => (b?.type === 'text' || b?.type === 'rich_text' || b?.type === 'math' ? String(b.value ?? '') : '')).join(' ').trim() : '';
const imageBlock = (blocks: any) => Array.isArray(blocks) ? (blocks.find((x: any) => x?.type === 'image') ?? null) : null;
// A broken image (e.g. the object 404s because it was on ephemeral disk) hides the <img> and reveals a
// following "not loading" note, so a missing figure never silently looks like a text-only question.
const onImgError = (e: React.SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.display = 'none';
  const note = e.currentTarget.nextElementSibling as HTMLElement | null;
  if (note && note.hasAttribute('hidden')) note.removeAttribute('hidden');
};
const blankCard = (type: string): Card => ({ key: newKey(), stem: '', type, active: true, explanation: '', img: null,
  opts: [{ option_id: 'a', text: '', correct: true }, { option_id: 'b', text: '', correct: false }, { option_id: 'c', text: '', correct: false }, { option_id: 'd', text: '', correct: false }] });

export function SetEditor({ taxonomy, setId, scopeCategoryId, scopeLabel, startBlank, openBulk, onClose, onSaved }: {
  taxonomy: any; setId: string; scopeCategoryId?: string; scopeLabel?: string;
  // Create-flow hints (only meaningful for a brand-new empty set):
  //  startBlank — open with one blank question card (checked) vs completely empty (unchecked).
  //  openBulk   — open the Bulk-add-from-file panel immediately (imported questions seed the set).
  // Both are undefined for the normal "edit existing set" entry points, which keep the prior behavior
  // (an empty set opens with one blank card as a convenience).
  startBlank?: boolean; openBulk?: boolean;
  onClose: () => void; onSaved?: () => void;
}) {
  const toast = useToast();
  const subs = taxonomy?.subcategories ?? [];
  const [set, setSet] = useState<any>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [subId, setSubId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bulk, setBulk] = useState(!!openBulk);

  const isExam = !!set?.allowed_exam;
  const scopeCat = scopeCategoryId;
  const subForCat = useMemo(() => subs.filter((s: any) => s.category_id === (scopeCat || set?.category_id)), [subs, scopeCat, set]);
  // The per-question TYPE field was removed from the card UI (it is redundant — every question inherits
  // the SET's battery/subcategory/difficulty/grade shown in the header). The gateway still REQUIRES a
  // non-empty question_type on the author payload, so we keep it on the model and default it to the
  // set's subcategory rather than dropping it from the request (contract safety).
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const defaultType = (): string => {
    const sub = subForCat.find((s: any) => s.id === (subId || set?.subcategory_id));
    return (sub?.key && slug(sub.key)) || (set?.subcategory ? slug(set.subcategory) : '') || 'verbal_analogy';
  };
  // Append imported/parsed cards to the editor (shared by CSV bulk-add and file Import). Cards arrive in
  // the same shape rowToCard produces; we stamp a fresh key and default the (hidden) type.
  const injectCards = (imported: any[]) => {
    setCards(cs => [...cs, ...imported.map((c: any) => ({ ...c, key: newKey(), type: c.type || defaultType() }))]);
    mark();
  };

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.set(setId);
      setSet(d);
      // For an exam battery, show only that category's questions; for a practice set, all.
      const mine = (d.questions || []).filter((q: any) => !scopeCat || q.category_key === catKey(taxonomy, scopeCat));
      const loaded: Card[] = [];
      for (const q of mine) {
        const full = await api.question(q.id).catch(() => null);
        if (!full) continue;
        const correct = new Set<string>(full.correct_option_ids ?? []);
        loaded.push({ key: newKey(), id: q.id, stem: textFromBlocks(full.prompt_blocks), type: full.question_type || 'verbal_analogy',
          explanation: textFromBlocks(full.explanation_blocks), active: q.active !== false, img: imageBlock(full.prompt_blocks),
          opts: (full.option_blocks || []).map((o: any) => ({ option_id: o.option_id, text: textFromBlocks(o.content), correct: correct.has(o.option_id), img: imageBlock(o.content) })) });
      }
      // Empty set: seed the opening cards per the create-flow hints. Opening the bulk importer, or an
      // explicit "start empty" (startBlank===false), begins with NO cards so imported questions aren't
      // preceded by a stray blank. Every other entry point keeps the one-blank-card convenience.
      const emptyStart = (openBulk || startBlank === false) ? [] : [blankCard('verbal_analogy')];
      setCards(loaded.length ? loaded : emptyStart);
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [setId, scopeCategoryId]);
  // Default the authoring subcategory. For a PRACTICE set, inherit the set's OWN subcategory (its
  // battery) so authored questions land under the right battery (BUG A). For an EXAM battery, the
  // battery is the category (scopeCat) and any subcategory within it is valid — default to the first.
  useEffect(() => {
    if (!subForCat.length) return;
    if (subForCat.find((s: any) => s.id === subId)) return;
    const inherit = !scopeCat && set?.subcategory_id && subForCat.find((s: any) => s.id === set.subcategory_id) ? set.subcategory_id : subForCat[0]?.id;
    setSubId(inherit ?? '');
  }, [subForCat, set]); // eslint-disable-line

  const mark = () => setDirty(true);
  const patchCard = (key: string, patch: Partial<Card>) => { setCards(cs => cs.map(c => c.key === key ? { ...c, ...patch } : c)); mark(); };
  const markCorrect = (key: string, i: number) => { setCards(cs => cs.map(c => c.key === key ? { ...c, opts: c.opts.map((o, j) => ({ ...o, correct: j === i })) } : c)); mark(); };
  const addOpt = (key: string) => { setCards(cs => cs.map(c => c.key === key && c.opts.length < 6 ? { ...c, opts: [...c.opts, { option_id: OPTION_IDS[c.opts.length], text: '', correct: false }] } : c)); mark(); };
  const rmOpt = (key: string, i: number) => { setCards(cs => cs.map(c => c.key === key && c.opts.length > 2 ? { ...c, opts: c.opts.filter((_, j) => j !== i).map((o, j) => ({ ...o, option_id: OPTION_IDS[j] })) } : c)); mark(); };
  // New cards inherit the previous card's type (a convenience); type is then set per-card. There is no
  // panel-level default type anymore — question type lives on each card (CHANGE 3).
  const addCard = () => { setCards(cs => [...cs, blankCard(cs[cs.length - 1]?.type || defaultType())]); mark(); };
  const dupCard = (key: string) => { setCards(cs => { const i = cs.findIndex(c => c.key === key); if (i < 0) return cs; const copy = { ...cs[i], key: newKey(), id: undefined, opts: cs[i].opts.map(o => ({ ...o })) }; return [...cs.slice(0, i + 1), copy, ...cs.slice(i + 1)]; }); mark(); };
  // Delete a question. Confirms first. If it was already saved (has an id), persist the removal
  // immediately (rewrite membership via authorSet) so it is gone on reopen without needing Save; an
  // unsaved card is just dropped locally. A set keeps ≥1 question.
  const delCard = async (key: string) => {
    const card = cards.find(c => c.key === key);
    if (!card) return;
    if (cards.length <= 1) { toast('A set needs at least one question — add another before deleting this.'); return; }
    if (!confirm('Delete this question? This cannot be undone.')) return;
    const remaining = cards.filter(c => c.key !== key);
    setCards(remaining); mark();
    if (card.id) {
      setBusy(true); setErr('');
      try { await api.authorSet(setId, remaining.map(cardToPayload), scopeCat); toast('Question deleted'); await load(); onSaved?.(); }
      catch (e) { setErr((e as Error).message); await load(); }
      finally { setBusy(false); }
    }
  };
  const move = (key: string, dir: -1 | 1) => { setCards(cs => { const i = cs.findIndex(c => c.key === key); const j = i + dir; if (i < 0 || j < 0 || j >= cs.length) return cs; const n = [...cs]; [n[i], n[j]] = [n[j], n[i]]; return n; }); mark(); };

  // Client-side guard mirroring the gateway: PNG/JPG/WEBP only, ≤2 MB. Returns an error string or null.
  const IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const IMG_MAX = 2 * 1024 * 1024;
  const imgError = (f: File): string | null =>
    !IMG_TYPES.includes(f.type) ? 'Image must be a PNG, JPG, or WEBP file.'
      : f.size > IMG_MAX ? 'Image is too large (max 2 MB).' : null;
  const toB64 = (file: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = rej; r.readAsDataURL(file); });

  // busy holds the target currently uploading: `${cardKey}` for the stem, `${cardKey}:${optIndex}` for an option.
  const [imgBusy, setImgBusy] = useState<string | null>(null);

  // Question stem figure.
  const uploadImg = async (key: string, file: File) => {
    const bad = imgError(file); if (bad) { toast(bad); return; }
    setImgBusy(key);
    try { const b64 = await toB64(file); const r = await api.uploadAsset(file.type, b64, 'stem'); patchCard(key, { img: { asset_id: r.id, url: r.url, alt: '' } }); toast('Figure uploaded'); }
    catch (e) { toast((e as Error).message); } finally { setImgBusy(null); }
  };
  // Option figure — attaches an image to one option alongside its text.
  const uploadOptImg = async (key: string, i: number, file: File) => {
    const bad = imgError(file); if (bad) { toast(bad); return; }
    setImgBusy(`${key}:${i}`);
    try {
      const b64 = await toB64(file);
      const r = await api.uploadAsset(file.type, b64, 'option');
      setCards(cs => cs.map(c => c.key === key ? { ...c, opts: c.opts.map((o, j) => j === i ? { ...o, img: { asset_id: r.id, url: r.url, alt: '' } } : o) } : c));
      mark(); toast('Option image uploaded');
    } catch (e) { toast((e as Error).message); } finally { setImgBusy(null); }
  };
  const setOptImg = (key: string, i: number, img: ImgRef | null) => { setCards(cs => cs.map(c => c.key === key ? { ...c, opts: c.opts.map((o, j) => j === i ? { ...o, img } : o) } : c)); mark(); };

  // Per-card validity for the pre-publish check surfaced inline.
  const cardIssues = (c: Card): string | null => {
    if (!c.stem.trim() && !c.img) return 'needs a question';
    const filled = c.opts.filter(o => o.text.trim() || o.img); // an option counts if it has text OR an image
    if (filled.length < 2) return 'needs ≥2 options';
    if (!filled.some(o => o.correct)) return 'needs a correct answer';
    return null;
  };
  // Category comes from CONTEXT (the exam battery = scopeCat, or the practice set's own category);
  // subcategory is the set's own (or the context battery's first sub) — never re-picked in the editor.
  const cardToPayload = (c: Card) => {
    const filled = c.opts.filter(o => o.text.trim() || o.img);
    const prompt_blocks: any[] = [];
    if (c.stem.trim()) prompt_blocks.push({ type: 'text', value: c.stem.trim() });
    if (c.img) prompt_blocks.push({ type: 'image', asset_id: c.img.asset_id, url: c.img.url, alt: c.img.alt ?? '' });
    if (!prompt_blocks.length) prompt_blocks.push({ type: 'text', value: '' });
    return {
      id: c.id, category_id: scopeCat || set.category_id, subcategory_id: subId || set.subcategory_id,
      grade_id: set.grade_id, difficulty_id: diffId(), question_type: c.type || defaultType(),
      prompt_blocks,
      // Option content carries a text block (when present) and/or an image block — an option may be
      // answered by its picture alone.
      option_blocks: filled.map(o => ({
        option_id: o.option_id,
        content: [
          ...(o.text.trim() ? [{ type: 'text', value: o.text.trim() }] : []),
          ...(o.img ? [{ type: 'image', asset_id: o.img.asset_id, url: o.img.url, alt: o.img.alt ?? '' }] : []),
        ],
      })),
      correct_option_ids: filled.filter(o => o.correct).map(o => o.option_id),
      explanation_blocks: c.explanation.trim() ? [{ type: 'text', value: c.explanation.trim() }] : null,
      active: c.active,
    };
  };
  const toPayload = () => cards.map(cardToPayload);
  const diffId = () => (taxonomy?.difficulties?.[0]?.id); // set-level difficulty is fixed; questions inherit it

  const save = async (): Promise<boolean> => {
    setErr('');
    const bad = cards.map((c, i) => ({ i, issue: cardIssues(c) })).filter(x => x.issue);
    // Saving a draft allows incomplete cards; only block on structural answer-key problems.
    const structural = cards.some(c => { const filled = c.opts.filter(o => o.text.trim()); return filled.some(o => o.correct) && !filled.filter(o => o.correct).every(o => c.opts.includes(o)); });
    if (structural) { setErr('An answer is marked on an empty option'); return false; }
    setBusy(true);
    try {
      await api.authorSet(setId, toPayload(), scopeCat);
      setDirty(false); toast(`Saved ${cards.length} question${cards.length === 1 ? '' : 's'}`); await load(); onSaved?.();
      if (bad.length) toast(`${bad.length} card(s) still incomplete — finish before publishing`);
      return true;
    } catch (e) { setErr((e as Error).message); return false; } finally { setBusy(false); }
  };

  const publish = async () => {
    const bad = cards.map((c, i) => ({ i: i + 1, issue: cardIssues(c) })).filter(x => x.issue);
    if (bad.length) { setErr(`Fix before publishing — ${bad.map(b => `Q${b.i} ${b.issue}`).join('; ')}`); return; }
    if (!(await save())) return;
    setBusy(true);
    try { await api.publishSet(setId); toast('Published — live on the website'); setDirty(false); onSaved?.(); onClose(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const close = () => { if (dirty && !confirm('Discard unsaved changes?')) return; onClose(); };

  const activeCount = cards.filter(c => c.active && !cardIssues(c)).length;
  const title = set ? (isExam ? `${set.name} — ${scopeLabel ?? 'Battery'}` : set.name) : 'Loading…';

  return (
    <div className="editordrawer" role="dialog" aria-label="Question editor">
      <div className="edhead">
        <div>
          <div className="edtitle">{title}</div>
          <div className="edsub muted">{set && (<>{isExam ? 'Exam battery' : 'Practice set'} · Grade {set.grade_number} · {set.category}{set.subcategory ? ` / ${set.subcategory}` : ''} · <b>{set.state}</b> · {cards.length} card{cards.length === 1 ? '' : 's'} ({activeCount} publish-ready)</>)}</div>
        </div>
        <div className="edactions">
          <button className="btn ghost sm" disabled={busy || !set || loading || preview} onClick={() => setBulk(true)}>⤓ Bulk add from file</button>
          <button className="btn ghost sm" onClick={() => setPreview(p => !p)}>{preview ? 'Edit' : 'Preview'}</button>
          <button className="btn sm" disabled={busy || !set} onClick={() => save()}>{busy ? 'Saving…' : 'Save draft'}</button>
          {set?.state !== 'published' && <button className="btn green sm" disabled={busy || !set} onClick={publish}>Publish</button>}
          <button className="btn ghost sm" onClick={close}>Close</button>
        </div>
      </div>

      {err && <div className="err ederr">{err}</div>}

      <div className="edbody">
        {loading ? <div className="muted" style={{ padding: 24 }}>Loading…</div> : preview ? (
          <StudentPreview cards={cards.filter(c => c.active)} />
        ) : (
          <>
            {/* No settings panel: category/subcategory come from where this editor was opened (shown in
                the header above), question type is per-card, and question order is the server default
                (fixed / by authoring order). Just the question cards below. */}
            {cards.map((c, i) => {
              const issue = cardIssues(c);
              return (
                <div className={`qcard ${issue ? 'qcard-bad' : ''}`} key={c.key}>
                  <div className="qcardhead">
                    <span className="qnum">Q{i + 1}</span>
                    <span className="grow" />
                    {issue && <span className="qissue">{issue}</span>}
                    <button className="iconbtn" title="Move up" onClick={() => move(c.key, -1)} disabled={i === 0}>↑</button>
                    <button className="iconbtn" title="Move down" onClick={() => move(c.key, 1)} disabled={i === cards.length - 1}>↓</button>
                    <button className="iconbtn" title="Duplicate" onClick={() => dupCard(c.key)}>⧉</button>
                    <button className="iconbtn danger" title="Delete" onClick={() => delCard(c.key)} disabled={cards.length <= 1}>✕</button>
                  </div>
                  <textarea className="qstem" rows={2} placeholder="Question text…" value={c.stem} onChange={e => patchCard(c.key, { stem: e.target.value })} />
                  {/* QUESTION FIGURE — its own control right under the question text (thumbnail + replace/remove). */}
                  <div className="qfigrow" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '2px 0 6px' }}>
                    <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
                      {imgBusy === c.key ? 'Uploading…' : (c.img ? '🖼 Replace figure' : '🖼 Add image / figure')}
                      <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { const f = e.target.files?.[0]; if (f) uploadImg(c.key, f); if (e.currentTarget) e.currentTarget.value = ''; }} />
                    </label>
                    <span className="muted" style={{ fontSize: 12 }}>Figure for the question (optional)</span>
                    {c.img && (
                      <div className="qimg" style={{ flexBasis: '100%', marginTop: 2 }}>
                        <img src={api.assetUrl(c.img.asset_id)} alt="" style={{ maxHeight: 90, borderRadius: 8 }}
                          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; (e.currentTarget.nextElementSibling as HTMLElement | null)?.removeAttribute('hidden'); }} />
                        <span hidden className="muted" style={{ fontSize: 12 }}>⚠ Image not loading (check storage).</span>
                        <button className="iconbtn danger" onClick={() => patchCard(c.key, { img: null })}>Remove</button>
                      </div>
                    )}
                  </div>
                  <div className="qopts">
                    {c.opts.map((o, j) => (
                      <div className="qopt" key={o.option_id} style={{ flexWrap: 'wrap' }}>
                        <input type="radio" name={`correct-${c.key}`} checked={o.correct} onChange={() => markCorrect(c.key, j)} aria-label={`Mark option ${o.option_id} correct`} />
                        <input className="qopttext" placeholder={`Option ${o.option_id.toUpperCase()}`} value={o.text} onChange={e => { setCards(cs => cs.map(cc => cc.key === c.key ? { ...cc, opts: cc.opts.map((oo, jj) => jj === j ? { ...oo, text: e.target.value } : oo) } : cc)); mark(); }} />
                        <label className="iconbtn" title="Add image to this option" style={{ cursor: 'pointer' }}>
                          {imgBusy === `${c.key}:${j}` ? '…' : '🖼'}
                          <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { const f = e.target.files?.[0]; if (f) uploadOptImg(c.key, j, f); if (e.currentTarget) e.currentTarget.value = ''; }} />
                        </label>
                        <button className="iconbtn" title="Remove option" onClick={() => rmOpt(c.key, j)} disabled={c.opts.length <= 2}>✕</button>
                        {o.img && (
                          <div className="qimg" style={{ flexBasis: '100%', marginTop: 4 }}>
                            <img src={api.assetUrl(o.img.asset_id)} alt="" style={{ maxHeight: 60 }} />
                            <button className="iconbtn danger" onClick={() => setOptImg(c.key, j, null)}>Remove image</button>
                          </div>
                        )}
                      </div>
                    ))}
                    <button className="btn ghost sm" onClick={() => addOpt(c.key)} disabled={c.opts.length >= 6}>+ Option</button>
                  </div>
                  <div className="qmeta">
                    <input className="qexpl" placeholder="Explanation (shown after answering, optional)" value={c.explanation} onChange={e => patchCard(c.key, { explanation: e.target.value })} />
                    <label className="edcheck"><input type="checkbox" checked={c.active} onChange={e => patchCard(c.key, { active: e.target.checked })} /> Active</label>
                  </div>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 4 }}>
              <button className="btn addcard" onClick={addCard}>+ Add question</button>
            </div>
          </>
        )}
      </div>

      {bulk && <BulkImport title="Bulk add from file" onClose={() => setBulk(false)}
        onImport={(imported) => { injectCards(imported); setBulk(false); toast(`Imported ${imported.length} question${imported.length === 1 ? '' : 's'} — review and Save draft`); }} />}
    </div>
  );
}

function catKey(taxonomy: any, catId: string): string {
  const c = (taxonomy?.categories ?? []).find((x: any) => x.id === catId);
  return c?.key ?? '';
}

function StudentPreview({ cards }: { cards: Card[] }) {
  if (!cards.length) return <div className="muted" style={{ padding: 24 }}>No active questions to preview.</div>;
  return (
    <div className="previewwrap">
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>Student preview — how these questions appear in Practice/Exam (order may shuffle at runtime).</div>
      {cards.map((c, i) => (
        <div className="pvcard" key={c.key}>
          <div className="pvstem"><b>{i + 1}.</b> {c.stem || <span className="muted">[image question]</span>}</div>
          {c.img && <><img className="pvimg" src={api.assetUrl(c.img.asset_id)} alt="" onError={onImgError} /><span hidden className="muted" style={{ fontSize: 12 }}>⚠ Question image not loading.</span></>}
          <div className="pvopts">
            {c.opts.filter(o => o.text.trim() || o.img).map(o => (
              <div className="pvopt" key={o.option_id}>
                <span className="pvbul">{o.option_id.toUpperCase()}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {o.text && <span>{o.text}</span>}
                  {o.img && <img src={api.assetUrl(o.img.asset_id)} alt="" style={{ maxHeight: 56, borderRadius: 6, display: 'block' }} onError={onImgError} />}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
