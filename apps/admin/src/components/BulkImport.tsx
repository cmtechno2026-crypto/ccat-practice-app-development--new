import React, { useRef, useState } from 'react';
import { Modal } from './ui';
import { parseImportText, ImportCard, ImportError } from '../lib/importParse';

// "Bulk add from file" — the single, universal question importer for the set editor. The admin uploads
// (or pastes) ONE .md / .txt file in the block format (Q:/A)/Answer:/Explanation:, "#" comments), we
// parse + validate it CLIENT-SIDE, and APPEND the parsed questions as fully-filled, editable cards to the
// CURRENT set. Strict all-or-nothing: any format error rejects the whole file with block/line-numbered
// reasons. Grade / battery / subcategory / difficulty / type come from the set, never the file. Nothing
// is saved here — the admin reviews, edits, adds more, then uses the existing Save draft / Publish flow.

// The downloadable sample — EXACTLY the canonical format guide + three example questions. Exported so the
// "Bulk add sets" panel downloads/copies the identical spec (single source of truth for the format).
export const SAMPLE = `# CCAT question import — format guide
#
# HOW THIS FILE IS READ
#  - The file is a list of question BLOCKS. Separate each block with a BLANK LINE.
#  - Each block starts with a "Q:" line, then the question text (it may span several lines).
#  - Options are labelled  A)  B)  C)  D)  ...  (a dot also works: "A.").  Minimum 2 options.
#  - "Answer:" gives the SINGLE correct option letter — it must match one of the options.
#  - "Explanation:" is optional (one line).
#  - Lines that start with "#" are comments and are ignored (you can delete this whole header).
#
# Fill in your own questions below in the same shape, then Import this file.
Q: Cat is to Kitten as Dog is to ?
A) Puppy
B) Cub
C) Foal
D) Calf
Answer: A
Explanation: A young dog is called a puppy.
Q: Which number comes next in the series: 2, 4, 8, 16, ?
A) 32
B) 24
C) 20
D) 18
Answer: A
Explanation: Each term is double the one before it.
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
  const [busy, setBusy] = useState(false);
  const [showSample, setShowSample] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parse = (src: string) => {
    const res = parseImportText(src);
    if (res.ok) { setCards(res.cards); setErrors(null); }
    else { setErrors(res.errors); setCards(null); }
  };
  const onFile = async (f: File) => { const t = await f.text(); setText(t); parse(t); };
  // Single source of truth for the format guide — the SAME text is downloaded as a file and copied to
  // the clipboard, so an AI conversion always gets the real spec.
  const SAMPLE_FILE = SAMPLE + '\n';
  const downloadSample = () => {
    const blob = new Blob([SAMPLE_FILE], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ccat-question-import-sample.md';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  const copyFormat = async () => {
    try {
      await navigator.clipboard.writeText(SAMPLE_FILE);
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the admin can still use Download sample */ }
  };
  const doImport = async () => {
    if (!cards || !cards.length) return;
    setBusy(true);
    try { await onImport(cards); } finally { setBusy(false); }
  };

  const shown = errors ? errors.slice(0, MAX_SHOWN) : [];
  const more = errors ? errors.length - shown.length : 0;

  return (
    <Modal wide title={title} onClose={onClose}
      footer={<>
        <button className="btn ghost grow" onClick={onClose}>Cancel</button>
        <button className="btn grow" disabled={busy || !cards || !cards.length} onClick={doImport}>
          {busy ? 'Importing…' : cards && cards.length ? `Import ${cards.length} question${cards.length === 1 ? '' : 's'}` : 'Import'}
        </button>
      </>}>
      <div className="infobox" style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>How to bulk add (for beginners):</div>
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, fontSize: 13 }}>
          <li>Click <b>Download sample</b> — or <b>Copy format</b> — to get the exact format.</li>
          <li>Paste that sample + your own questions into ChatGPT or Claude and ask: <i>"Rewrite my questions in exactly this format."</i></li>
          <li>Copy the AI's result and paste it in the box below (or save it as a .md/.txt file and use <b>Choose file…</b>).</li>
          <li>Click <b>Parse &amp; check</b>, fix any lines it flags, then <b>Import</b>.</li>
        </ol>
        <div style={{ marginTop: 6, fontSize: 12.5 }}>Nothing is saved until you press <b>Save draft</b>. Grade / category / subcategory / difficulty come from the set.</div>
      </div>

      <div className="rowactions" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <button className="btn ghost sm" onClick={downloadSample}>⤓ Download sample</button>
        <button className="btn ghost sm" onClick={copyFormat}>{copied ? '✓ Copied!' : '⧉ Copy format'}</button>
        <button className="btn ghost sm" onClick={() => setShowSample(s => !s)}>{showSample ? 'Hide format' : 'View format'}</button>
        <input ref={fileRef} type="file" accept=".md,.txt,.csv,text/markdown,text/plain,text/csv" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); if (fileRef.current) fileRef.current.value = ''; }} />
        <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Choose file…</button>
        <button className="btn sm" onClick={() => parse(text)} disabled={!text.trim()}>Parse &amp; check</button>
      </div>

      {showSample && (
        <pre style={{ background: 'var(--panel, #f6f8fc)', border: '1px solid var(--line, #e3e8f0)', borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 1.5, overflow: 'auto', maxHeight: 240, whiteSpace: 'pre-wrap' }}>{SAMPLE}</pre>
      )}

      <label style={{ marginTop: 4 }}>✍️ Paste your questions here — or use “Choose file…” above</label>
      <textarea rows={5} value={text}
        onChange={e => { setText(e.target.value); setCards(null); setErrors(null); }}
        placeholder={'Paste the AI-formatted questions here…\n\nQ: Which one is the odd one out?\nA) Circle\nB) Square\nC) Triangle\nD) Dog\nAnswer: D\nExplanation: Dog is not a shape.'}
        style={{ fontFamily: 'ui-monospace,monospace', fontSize: 12.5 }} />

      {errors && errors.length > 0 && (
        <div className="err" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>This file was not imported. Fix these and re-import:</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, listStyle: 'disc' }}>
            {shown.map((e, i) => <li key={i} style={{ fontFamily: 'ui-monospace,monospace' }}>{e.display}</li>)}
          </ul>
          {more > 0 && <div style={{ marginTop: 6 }}>…and {more} more. Fix these and re-import.</div>}
        </div>
      )}

      {cards && cards.length > 0 && (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          {cards.length} question{cards.length === 1 ? '' : 's'} ready ✓ — click <b>Import</b>, then review and <b>Save draft</b>.
        </div>
      )}
    </Modal>
  );
}
