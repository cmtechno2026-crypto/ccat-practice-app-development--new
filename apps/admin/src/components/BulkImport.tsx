import React, { useRef, useState } from 'react';
import { Modal } from './ui';
import { parseQuestionsCsv, SAMPLE_CSV, ImportCard, CsvError } from '../lib/csv';

// Bulk add questions from a CSV in the simplified format (question, options, correct, explanation).
// STRICT all-or-nothing: a valid file appends fully-filled, editable cards to the CURRENT set; a
// malformed file is rejected with row-numbered errors and imports nothing. Grade / battery /
// subcategory / difficulty / type come from the set, not the file. Nothing is saved here — the admin
// reviews, edits, adds more, then uses the existing Save draft / Publish flow.

const MAX_SHOWN = 10;

export function BulkImport({ title = 'Bulk add from CSV', onClose, onImport }: {
  title?: string; onClose: () => void; onImport: (cards: ImportCard[]) => void | Promise<void>;
}) {
  const [text, setText] = useState('');
  const [cards, setCards] = useState<ImportCard[] | null>(null);
  const [errors, setErrors] = useState<CsvError[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parse = (src: string) => {
    const res = parseQuestionsCsv(src);
    if (res.ok) { setCards(res.cards); setErrors(null); }
    else { setErrors(res.errors); setCards(null); }
  };
  const onFile = async (f: File) => { const t = await f.text(); setText(t); parse(t); };
  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ccat-questions-sample.csv';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
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
      <p className="lead">
        Upload or paste a <b>.csv</b> with columns <code>question, option_a…option_f, correct, explanation</code>.
        Each row becomes a filled question card in this set — grade, battery, subcategory and difficulty come from the set, not the file.
        Nothing is saved until you use <b>Save draft</b>.
      </p>

      <div className="rowactions" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <button className="btn ghost sm" onClick={downloadSample}>⤓ Download sample CSV</button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); if (fileRef.current) fileRef.current.value = ''; }} />
        <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Choose CSV file</button>
        <button className="btn sm" onClick={() => parse(text)} disabled={!text.trim()}>Parse &amp; check</button>
      </div>

      <textarea rows={5} value={text}
        onChange={e => { setText(e.target.value); setCards(null); setErrors(null); }}
        placeholder={'question,option_a,option_b,option_c,option_d,correct,explanation\n"Which one is the odd one out?",Circle,Square,Triangle,Dog,D,"Dog is not a shape."'}
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
