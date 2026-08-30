import React, { useRef, useState } from 'react';
import { Modal } from './ui';
import { parseImportText, ImportError, ImportCard } from '../lib/importParse';

// "Import from file" for the set editor. The admin uploads ONE .md / .txt / .pdf / .docx file in the
// predefined block format; we extract its text CLIENT-SIDE (no gateway call), parse+validate it, and
// APPEND the parsed questions as normal editable cards via the same onImport path the CSV importer
// uses. Strict all-or-nothing: any format error rejects the whole file and lists the first errors with
// line/block numbers. PDF/DOCX readers are loaded on demand from a CDN so no build dependency changes.

// Kept identical to public/sample-import.{md,docx,pdf} so the format is unambiguous across file types.
const SAMPLE = `# CCAT question import — format guide
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

Q: Choose the word that best completes the sentence:
The careful scientist recorded every ___ in her notebook.
A) observation
B) observatory
C) observant
D) observe
Answer: A`;

const PDF_VERSION = '4.7.76';
const MAMMOTH_VERSION = '1.8.0';

// --- client-side text extraction (readers lazy-loaded from CDN; no bundled dependency) ------------
async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.md') || name.endsWith('.txt')) return await file.text();

  if (name.endsWith('.docx')) {
    let mammoth: any;
    try { mammoth = await import(/* @vite-ignore */ `https://cdn.jsdelivr.net/npm/mammoth@${MAMMOTH_VERSION}/+esm`); }
    catch { throw new Error("Couldn't load the Word (.docx) reader — check the network connection, or paste the questions into a .md / .txt file instead."); }
    const r = await (mammoth.default ?? mammoth).extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return String(r?.value ?? '');
  }

  if (name.endsWith('.pdf')) {
    let pdfjs: any;
    try {
      pdfjs = await import(/* @vite-ignore */ `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_VERSION}/+esm`);
      pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_VERSION}/build/pdf.worker.min.mjs`;
    } catch { throw new Error("Couldn't load the PDF reader — check the network connection, or paste the questions into a .md / .txt file instead."); }
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let out = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // Rebuild lines: pdf.js marks the end of a visual line with item.hasEOL.
      let line = '';
      for (const it of content.items as any[]) {
        if (typeof it.str === 'string') line += it.str;
        if (it.hasEOL) { out += line + '\n'; line = ''; }
      }
      if (line) out += line + '\n';
      out += '\n'; // page break → blank line
    }
    return out;
  }

  throw new Error('Unsupported file type. Choose a .md, .txt, .pdf, or .docx file.');
}

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

const MAX_SHOWN = 10;

export function FileImport({ onClose, onImport }: {
  onClose: () => void;
  onImport: (cards: ImportCard[]) => void | Promise<void>;
}) {
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<ImportError[] | null>(null);
  const [cards, setCards] = useState<ImportCard[] | null>(null);
  const [fatal, setFatal] = useState('');
  const [showSample, setShowSample] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const base = (import.meta as any).env?.BASE_URL || '/';

  const reset = () => { setErrors(null); setCards(null); setFatal(''); };

  const onFile = async (f: File) => {
    reset(); setFileName(f.name); setBusy(true);
    try {
      const text = await extractText(f);
      const res = parseImportText(text);
      if (res.ok) { setCards(res.cards); setErrors(null); }
      else { setErrors(res.errors); setCards(null); }
    } catch (e) {
      setFatal((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = ''; // allow re-choosing the same file after a fix
    }
  };

  const doImport = async () => {
    if (!cards || !cards.length) return;
    setBusy(true);
    try { await onImport(cards); } finally { setBusy(false); }
  };

  const shown = errors ? errors.slice(0, MAX_SHOWN) : [];
  const moreErrors = errors ? errors.length - shown.length : 0;

  return (
    <Modal wide title="Import questions from a file" onClose={onClose}
      footer={<>
        <button className="btn ghost grow" onClick={onClose}>Cancel</button>
        <button className="btn grow" disabled={busy || !cards || !cards.length} onClick={doImport}>
          {busy ? 'Working…' : cards && cards.length ? `Import ${cards.length} question${cards.length === 1 ? '' : 's'}` : 'Import'}
        </button>
      </>}>
      <p className="lead">
        Upload one <b>.md</b>, <b>.txt</b>, <b>.pdf</b>, or <b>.docx</b> file written in the block format.
        The questions are parsed and added as editable cards to this set — nothing is saved until you use <b>Save draft</b>.
      </p>

      <div className="rowactions" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <button className="btn ghost sm" onClick={() => download('ccat-import-sample.md', new Blob([SAMPLE], { type: 'text/markdown' }))}>⤓ Sample .md</button>
        <button className="btn ghost sm" onClick={() => download('ccat-import-sample.txt', new Blob([SAMPLE], { type: 'text/plain' }))}>⤓ Sample .txt</button>
        <a className="btn ghost sm" href={`${base}sample-import.docx`} download>⤓ Sample .docx</a>
        <a className="btn ghost sm" href={`${base}sample-import.pdf`} download>⤓ Sample .pdf</a>
        <button className="btn ghost sm" onClick={() => setShowSample(s => !s)}>{showSample ? 'Hide format' : 'View format'}</button>
        <span className="grow" />
        <input ref={fileRef} type="file" accept=".md,.txt,.pdf,.docx,text/markdown,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
        <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={busy}>Choose file…</button>
      </div>

      {showSample && (
        <pre style={{ background: 'var(--panel, #f6f8fc)', border: '1px solid var(--line, #e3e8f0)', borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 1.5, overflow: 'auto', maxHeight: 260, whiteSpace: 'pre-wrap' }}>{SAMPLE}</pre>
      )}

      {fileName && !busy && !fatal && (
        <div className="muted" style={{ fontSize: 12.5, margin: '6px 0' }}>
          <b>{fileName}</b>{cards ? ` — ${cards.length} question${cards.length === 1 ? '' : 's'} ready ✓` : errors ? ` — ${errors.length} error${errors.length === 1 ? '' : 's'} found` : ''}
        </div>
      )}
      {busy && <div className="muted" style={{ fontSize: 12.5, margin: '6px 0' }}>Reading {fileName}…</div>}

      {fatal && <div className="err" style={{ marginTop: 8 }}>{fatal}</div>}

      {errors && errors.length > 0 && (
        <div className="err" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>This file was not imported. Fix these and re-import:</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, listStyle: 'disc' }}>
            {shown.map((e, i) => <li key={i} style={{ fontFamily: 'ui-monospace,monospace' }}>{e.display}</li>)}
          </ul>
          {moreErrors > 0 && <div style={{ marginTop: 6, fontSize: 12.5 }}>…and {moreErrors} more error{moreErrors === 1 ? '' : 's'}. Fix these and re-import.</div>}
        </div>
      )}

      {cards && cards.length > 0 && (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          Ready to add {cards.length} question{cards.length === 1 ? '' : 's'}. Click <b>Import</b> — then review, edit, and <b>Save draft</b>.
        </div>
      )}
    </Modal>
  );
}
