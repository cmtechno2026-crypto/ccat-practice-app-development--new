import React, { useRef, useState } from 'react';
import { Modal } from './ui';
import { api } from '../lib/api';
import { parseImportText, referencedImages, ImportCard, ImportError } from '../lib/importParse';
import { readBulkInput, matchImages, uploadImages, attachImages, BulkImage, MatchResult } from '../lib/bulkFile';

// "Bulk add from file" — the single, universal question importer for the set editor. The admin uploads
// (or pastes) ONE .md / .txt file in the block format, OR a .zip containing that file plus figure images
// referenced by "Q-Image:" / "<X>-Image:" lines. We parse + validate CLIENT-SIDE, match image references
// to zip files, and APPEND the parsed questions (with figures) as editable cards to the CURRENT set.
// Strict all-or-nothing text parse; missing image references block import. Grade / battery / subcategory /
// difficulty / type come from the set. Nothing is saved here — the admin reviews, then Save draft / Publish.

// The downloadable sample — EXACTLY the canonical format guide + examples (now incl. the optional figure
// lines + ZIP workflow). Exported so "Bulk add sets" downloads/copies the identical spec.
export const SAMPLE = `# CCAT question import — format guide
#
# HOW THIS FILE IS READ
#  - The file is a list of question BLOCKS. Separate each block with a BLANK LINE.
#  - Each block starts with a "Q:" line, then the question text (it may span several lines).
#  - Options are labelled  A)  B)  C)  D)  ...  (a dot also works: "A.").  Minimum 2 options.
#  - "Answer:" gives the SINGLE correct option letter — it must match one of the options.
#  - "Explanation:" is optional (one line).
#  - Lines that start with "#" are comments and are ignored.
#
# FIGURES (optional — leave them out for text-only questions):
#  - "Q-Image: filename"  adds a picture to the QUESTION (a question may be figure-only: leave "Q:" empty).
#  - "A-Image: filename"  (B-Image, C-Image, …) adds a picture to that OPTION (an option may be image-only).
#  - Provide the images in a ZIP: put THIS .md/.txt plus the image files into one .zip (images at the zip
#    root or in an images/ folder) and pick the ZIP with "Choose file…".  PNG / JPG / WEBP only, <= 2 MB each.
#  - A plain .md/.txt with no images still works with no ZIP.
#
# Fill in your own questions below in the same shape, then Import.
Q: Cat is to Kitten as Dog is to ?
A) Puppy
B) Cub
C) Foal
D) Calf
Answer: A
Explanation: A young dog is called a puppy.
Q: Which shape completes the pattern?
Q-Image: pattern_q2.png
A-Image: shape_a.png
B-Image: shape_b.png
C-Image: shape_c.png
D-Image: shape_d.png
Answer: C
Q: Choose the word that best completes the sentence: The careful scientist recorded every ___ in her notebook.
A) observation
B) observatory
C) observant
D) observe
Answer: A`;

const MAX_SHOWN = 10;

export function BulkImport({ title = 'Bulk add from file', onClose, onImport }: {
  title?: string; onClose: () => void; onImport: (cards: ImportCard[]) => void | Promise<void>;
}) {
  const [text, setText] = useState('');
  const [cards, setCards] = useState<ImportCard[] | null>(null);
  const [errors, setErrors] = useState<ImportError[] | null>(null);
  const [images, setImages] = useState<Map<string, BulkImage>>(new Map());
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [fileErr, setFileErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSample, setShowSample] = useState(false);
  const [showInstruction, setShowInstruction] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const SAMPLE_FILE = SAMPLE + '\n';
  const downloadSample = () => {
    const blob = new Blob([SAMPLE_FILE], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ccat-question-import-sample.md';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  const copyFormat = async () => {
    try { await navigator.clipboard.writeText(SAMPLE_FILE); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const doImport = async () => {
    if (!cards || !cards.length) return;
    if (match && match.missing.length) { setFileErr(`${match.missing.length} referenced image(s) are missing from the ZIP — add them (or remove the reference) before importing.`); return; }
    setBusy(true); setFileErr('');
    try {
      let out = cards;
      const refs = referencedImages(cards);
      if (refs.length) {
        const uploaded = await uploadImages(refs, images, (mime, b64, alt) => api.uploadAsset(mime, b64, alt));
        out = attachImages(cards, uploaded);
      }
      await onImport(out);
    } catch (e) { setFileErr((e as Error).message); } finally { setBusy(false); }
  };

  const shown = errors ? errors.slice(0, MAX_SHOWN) : [];
  const more = errors ? errors.length - shown.length : 0;
  const blockedByMissing = !!(match && match.missing.length);

  return (
    <Modal wide title={title} onClose={onClose}
      headerRight={<button className="btn ghost sm" onClick={() => setShowInstruction(s => !s)}>{showInstruction ? 'Hide instruction' : '❔ Instruction'}</button>}
      footer={<>
        <button className="btn ghost grow" onClick={onClose}>Cancel</button>
        <button className="btn grow" disabled={busy || !cards || !cards.length || blockedByMissing} onClick={doImport}>
          {busy ? 'Importing…' : cards && cards.length ? `Import ${cards.length} question${cards.length === 1 ? '' : 's'}` : 'Import'}
        </button>
      </>}>
      {showInstruction && (
        <div className="infobox" style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>How to bulk add (for beginners):</div>
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, fontSize: 13 }}>
            <li>Click <b>Download sample</b> — or <b>Copy format</b> — to get the exact format.</li>
            <li>Paste that sample + your own questions into ChatGPT or Claude and ask: <i>"Rewrite my questions in exactly this format."</i></li>
            <li>Copy the AI's result and paste it in the box below (or save it as a .md/.txt file and use <b>Choose file…</b>).</li>
            <li><b>Figures (optional):</b> add <code>Q-Image: file.png</code> / <code>A-Image: file.png</code> lines, put the .md/.txt + those images in ONE <b>.zip</b>, and choose the ZIP. PNG/JPG/WEBP, ≤2 MB each.</li>
            <li>Click <b>Parse &amp; check</b> (it lists any missing images), fix flags, then <b>Import</b>.</li>
          </ol>
          <div style={{ marginTop: 6, fontSize: 12.5 }}>Nothing is saved until you press <b>Save draft</b>. Grade / category / subcategory / difficulty come from the set.</div>
        </div>
      )}

      <div className="rowactions" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <button className="btn ghost sm" onClick={downloadSample}>⤓ Download sample</button>
        <button className="btn ghost sm" onClick={copyFormat}>{copied ? '✓ Copied!' : '⧉ Copy format'}</button>
        <button className="btn ghost sm" onClick={() => setShowSample(s => !s)}>{showSample ? 'Hide format' : 'View format'}</button>
        <input ref={fileRef} type="file" accept=".md,.txt,.zip,text/markdown,text/plain,application/zip" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); if (fileRef.current) fileRef.current.value = ''; }} />
        <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Choose file… (.md/.txt/.zip)</button>
        <button className="btn sm" onClick={() => parse(text)} disabled={!text.trim()}>Parse &amp; check</button>
      </div>

      {showSample && (
        <pre style={{ background: 'var(--panel, #f6f8fc)', border: '1px solid var(--line, #e3e8f0)', borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 1.5, overflow: 'auto', maxHeight: 240, whiteSpace: 'pre-wrap' }}>{SAMPLE}</pre>
      )}

      <label style={{ marginTop: 4 }}>✍️ Paste your questions here — or use “Choose file…” above (a .zip for figures)</label>
      <textarea rows={5} value={text}
        onChange={e => { setText(e.target.value); setCards(null); setErrors(null); setMatch(null); }}
        placeholder={'Paste the AI-formatted questions here…\n\nQ: Which one is the odd one out?\nA) Circle\nB) Square\nC) Triangle\nD) Dog\nAnswer: D\nExplanation: Dog is not a shape.'}
        style={{ fontFamily: 'ui-monospace,monospace', fontSize: 12.5 }} />

      {fileErr && <div className="err" style={{ marginTop: 8 }}>{fileErr}</div>}

      {errors && errors.length > 0 && (
        <div className="err" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>This file was not imported. Fix these and re-import:</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, listStyle: 'disc' }}>
            {shown.map((e, i) => <li key={i} style={{ fontFamily: 'ui-monospace,monospace' }}>{e.display}</li>)}
          </ul>
          {more > 0 && <div style={{ marginTop: 6 }}>…and {more} more. Fix these and re-import.</div>}
        </div>
      )}

      {match && (match.referenced.length > 0 || images.size > 0) && (
        <div className="infobox" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            Figures: {match.matched.length}/{match.referenced.length} matched{images.size ? ` · ${images.size} image${images.size === 1 ? '' : 's'} in ZIP` : ''}
          </div>
          {match.referenced.map(r => (
            <div key={r} style={{ fontSize: 12.5, fontFamily: 'ui-monospace,monospace' }}>
              {match.missing.includes(r) ? '✗ ' : '✓ '}{r}
              {match.missing.includes(r) && <b style={{ color: 'var(--coral)' }}> — MISSING</b>}
            </div>
          ))}
          {match.missing.length > 0 && <div className="err" style={{ marginTop: 4 }}>Add the missing image(s) to the ZIP (or remove the reference) before importing.</div>}
          {match.unused.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Not referenced (ignored): {match.unused.join(', ')}</div>}
        </div>
      )}

      {cards && cards.length > 0 && !blockedByMissing && (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          {cards.length} question{cards.length === 1 ? '' : 's'} ready ✓ — click <b>Import</b>, then review and <b>Save draft</b>.
        </div>
      )}
    </Modal>
  );
}
