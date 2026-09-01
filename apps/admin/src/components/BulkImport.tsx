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

// Single source of the bulk-add format spec, reused by BOTH bulk panels (this one + "Bulk add sets").
// FORMAT_TEXT (BLOCK A) — shown by "View/Show format" and the Instruction panel, and copied by "Copy format".
// SAMPLE_FILE_TEXT (BLOCK B) — the clean starter file written by "Download sample" (.txt, UTF-8).
export const FORMAT_TEXT = `# ============================================================
# CCAT BULK-ADD — COPY THIS WHOLE THING
# Paste it into ChatGPT or Claude TOGETHER WITH your raw questions.
# ============================================================
#
# PROMPT (what to tell the AI):
# "Convert my questions into the exact CCAT bulk-add format shown below.
#  - One BLOCK per question, separated by ONE blank line.
#  - Start each block with 'Q:' then the question text.
#  - List options as 'A)' 'B)' 'C)' 'D)' (2-4 options).
#  - Put the correct option letter on an 'Answer:' line — it MUST match an option.
#  - 'Explanation:' is optional, one line.
#  - If a question or an option has a FIGURE/IMAGE, add a 'Q-Image:' or
#    '<Letter>-Image:' line with the image FILENAME, and give me the list of
#    filenames I must put in a .zip with this file. A question or option may be
#    figure-only (no text).
#  - Do NOT change my answers. Output ONLY the formatted blocks, nothing else."
#
# ============================================================
# FORMAT RULES
# ============================================================
# - Blocks are separated by a BLANK LINE. No blank line inside a block.
# - Minimum 2 options. 'Answer:' is ONE letter and must match a present option.
# - A QUESTION needs text OR a Q-Image (or both). An OPTION needs text OR an
#   <Letter>-Image (or both).
# - Images are OPTIONAL. Text-only files need no zip.
# - Image files: png / jpg / jpeg / webp. Reference them by filename; put the
#   actual files in a .ZIP with this text file (at the zip root or in images/).
# - Lines starting with '#' are comments and are ignored (you can delete them).
#
# BLOCK TEMPLATE:
# Q: <question text>            (optional if the question has a figure)
# Q-Image: <filename>           (optional — question figure)
# A) <option A text>            (text optional if the option has an image)
# A-Image: <filename>           (optional — option A figure)
# B) <option B text>
# C) <option C text>
# D) <option D text>
# Answer: <A/B/C/D>
# Explanation: <optional one line>
#
# ============================================================
# EXAMPLES
# ============================================================

Q: Which word best completes the sentence: The puppy ___ across the yard.
A) run
B) runs
C) running
D) ran
Answer: B
Explanation: Present tense, singular subject takes "runs".

Q: Choose the odd one out.
A) Apple
B) Banana
C) Carrot
D) Mango
Answer: C
Explanation: Carrot is a vegetable; the rest are fruits.

# Figure in the QUESTION, text options:
Q: Which shape comes next in the pattern?
Q-Image: q_pattern_01.png
A) Circle
B) Square
C) Triangle
D) Star
Answer: C

# Figure-only QUESTION, figure OPTIONS (e.g. Figure analogy):
Q-Image: q_matrix_02.png
A)
A-Image: opt2_a.png
B)
B-Image: opt2_b.png
C)
C-Image: opt2_c.png
D)
D-Image: opt2_d.png
Answer: B
`;

export const SAMPLE_FILE_TEXT = `# CCAT bulk-add sample — edit or replace with your own questions.
# One block per question, separated by a blank line.
# Options A) B) C) D); Answer: <letter> must match an option; Explanation: optional.
# For figures: add Q-Image:/A-Image: lines with filenames and zip the images with this file.

Q: Which word best completes the sentence: The children ___ happily in the park.
A) plays
B) played
C) playing
D) play
Answer: D
Explanation: Plural subject "children" takes "play".

Q: Choose the word that means the same as "big".
A) tiny
B) large
C) narrow
D) short
Answer: B

Q: Which one is the odd one out?
A) Rose
B) Lily
C) Tulip
D) Oak
Answer: D
Explanation: Oak is a tree; the others are flowers.

# Example with a question figure (include q_shape_01.png in the zip):
Q: Which shape completes the sequence?
Q-Image: q_shape_01.png
A) Circle
B) Square
C) Pentagon
D) Hexagon
Answer: C
`;

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

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_FILE_TEXT], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ccat-bulk-sample.txt';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  const copyFormat = async () => {
    try { await navigator.clipboard.writeText(FORMAT_TEXT); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const doImport = async () => {
    if (!cards || !cards.length) return;
    if (match && match.missing.length) { setFileErr(`${match.missing.length} referenced image(s) are missing from the ZIP — add them (or remove the reference) before importing.`); return; }
    setBusy(true); setFileErr('');
    try {
      let out = cards;
      const refs = referencedImages(cards);
      if (refs.length) {
        const uploaded = await uploadImages(refs, images, items => api.uploadAssetsBatch(items).then(r => {
          console.info(`[bulk] uploaded ${r.count} image(s) (${r.unique} unique) in ${r.elapsed_ms} ms — storage ${r.upload_ms} ms, db ${r.insert_ms} ms`);
          return r.assets;
        }));
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
        <pre style={{ background: 'var(--panel, #f6f8fc)', border: '1px solid var(--line, #e3e8f0)', borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 1.5, overflow: 'auto', maxHeight: 300, whiteSpace: 'pre-wrap', marginBottom: 10 }}>{FORMAT_TEXT}</pre>
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
        <pre style={{ background: 'var(--panel, #f6f8fc)', border: '1px solid var(--line, #e3e8f0)', borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 1.5, overflow: 'auto', maxHeight: 240, whiteSpace: 'pre-wrap' }}>{FORMAT_TEXT}</pre>
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
