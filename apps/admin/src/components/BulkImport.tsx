import React, { useMemo, useRef, useState } from 'react';
import { Modal } from './ui';
import { parseQuestionsCsv, rowToCard, CSV_TEMPLATE, ImportRow } from '../lib/csv';

// Shared manual CSV/paste importer. Paste rows or choose a .csv file → parsed, editable preview →
// fix inline → Import. Returns ready question cards to the caller (editor appends them; the import
// page authors them into a set). Nothing is generated — every field is admin-entered.

export function BulkImport({ title = 'Import questions from CSV', onClose, onImport }: {
  title?: string; onClose: () => void; onImport: (cards: ReturnType<typeof rowToCard>[]) => void | Promise<void>;
}) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [parseErr, setParseErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parse = (src: string) => {
    const r = parseQuestionsCsv(src);
    if (r.error) { setParseErr(r.error); setRows(null); return; }
    setParseErr(''); setRows(r.rows);
  };
  const onFile = async (f: File) => { const t = await f.text(); setText(t); parse(t); };
  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ccat-questions-template.csv';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };

  const recompute = (row: ImportRow): ImportRow => {
    const issues: string[] = [];
    if (!row.stem.trim()) issues.push('missing stem');
    const filled = row.options.filter(o => o.trim());
    if (filled.length < 2) issues.push('needs ≥2 options');
    if (row.correctIndex < 0 || !row.options[row.correctIndex]?.trim()) issues.push('mark the correct answer');
    return { ...row, issues };
  };
  const patchRow = (i: number, patch: Partial<ImportRow>) => setRows(rs => rs!.map((r, j) => j === i ? recompute({ ...r, ...patch }) : r));
  const patchOpt = (i: number, oi: number, val: string) => setRows(rs => rs!.map((r, j) => j === i ? recompute({ ...r, options: r.options.map((o, k) => k === oi ? val : o) }) : r));
  const removeRow = (i: number) => setRows(rs => rs!.filter((_, j) => j !== i));

  const ready = useMemo(() => (rows || []).filter(r => r.issues.length === 0), [rows]);
  const badCount = (rows || []).length - ready.length;

  const doImport = async () => {
    if (!ready.length) return;
    setBusy(true);
    try { await onImport(ready.map(rowToCard)); } finally { setBusy(false); }
  };

  return (
    <Modal wide title={title} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button>
        <button className="btn grow" disabled={busy || !ready.length} onClick={doImport}>{busy ? 'Importing…' : `Import ${ready.length} question${ready.length === 1 ? '' : 's'}`}</button></>}>
      <p className="lead">Paste rows or choose a <b>.csv</b> file, then review and fix before importing. Everything is entered by you — nothing is generated.</p>
      <div className="rowactions" style={{ marginBottom: 8 }}>
        <button className="btn ghost sm" onClick={downloadTemplate}>⤓ Download template</button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
        <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Choose CSV file</button>
        <button className="btn sm" onClick={() => parse(text)} disabled={!text.trim()}>Parse & preview</button>
      </div>
      <textarea rows={4} value={text} onChange={e => setText(e.target.value)} placeholder={'Paste CSV rows here (with the header row), or use "Choose CSV file"…'} style={{ fontFamily: 'ui-monospace,monospace', fontSize: 12.5 }} />
      {parseErr && <div className="err" style={{ marginTop: 8 }}>{parseErr}</div>}

      {rows && (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>{ready.length} ready{badCount ? ` · ${badCount} need fixing (highlighted)` : ''}. Edit any cell to fix; the correct answer is the marked option.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 340, overflowY: 'auto' }}>
            {rows.map((r, i) => (
              <div key={i} className={`improw ${r.issues.length ? 'improw-bad' : ''}`}>
                <div className="improw-head">
                  <span className="qnum">#{i + 1}</span>
                  <input className="grow" value={r.stem} placeholder="Question stem" onChange={e => patchRow(i, { stem: e.target.value })} />
                  <input className="imptype" value={r.type} onChange={e => patchRow(i, { type: e.target.value })} aria-label="Type" />
                  <button className="iconbtn danger" title="Remove row" onClick={() => removeRow(i)}>✕</button>
                </div>
                <div className="impopts">
                  {r.options.map((o, oi) => (
                    <label key={oi} className={`impopt ${oi === r.correctIndex ? 'correct' : ''}`}>
                      <input type="radio" name={`imp-${i}`} checked={oi === r.correctIndex} onChange={() => patchRow(i, { correctIndex: oi })} aria-label={`Mark option ${oi + 1} correct`} />
                      <input value={o} placeholder={`Option ${'ABCDEF'[oi]}`} onChange={e => patchOpt(i, oi, e.target.value)} />
                    </label>
                  ))}
                </div>
                {r.issues.length > 0 && <div className="impissue">⚠ {r.issues.join(' · ')}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
