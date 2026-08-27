import React, { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/ui';
import { parseScopedQuestionsCsv, scopedRowToImport, SCOPED_CSV_TEMPLATE, type ScopedImportRow } from '../lib/csv';

// Standalone manual bulk-import tool. Each CSV row carries its OWN scope — grade, battery
// (Verbal/Quantitative/Non-verbal), category (topic under the battery), difficulty — plus the
// question. Paste or upload a .csv → review + fix inline → import. The gateway resolves scope by
// name, groups rows by scope, and creates DRAFT practice set(s); nothing publishes until you publish
// each set in Content. Everything is admin-entered — nothing is generated.

type ImportResult = {
  imported: number;
  sets: { set_version_id: string; name: string; grade: number; battery: string; category: string; difficulty: string; question_count: number }[];
  rejected: { index: number; reasons: string[] }[];
};

export function ImportQuestions() {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('content.create');
  const [text, setText] = useState('');
  const [rows, setRows] = useState<ScopedImportRow[] | null>(null);
  const [parseErr, setParseErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const parse = (src: string) => {
    const r = parseScopedQuestionsCsv(src);
    if (r.error) { setParseErr(r.error); setRows(null); return; }
    setParseErr(''); setRows(r.rows); setResult(null);
  };
  const onFile = async (f: File) => { const t = await f.text(); setText(t); parse(t); };
  const downloadTemplate = () => {
    const blob = new Blob([SCOPED_CSV_TEMPLATE], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ccat-scoped-questions-template.csv';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };

  const recompute = (row: ScopedImportRow): ScopedImportRow => {
    const issues: string[] = [];
    if (!row.grade.trim()) issues.push('missing grade');
    if (!row.battery.trim()) issues.push('missing battery');
    if (!row.category.trim()) issues.push('missing category');
    if (!row.difficulty.trim()) issues.push('missing difficulty');
    if (!row.stem.trim()) issues.push('missing stem');
    const filled = row.options.filter(o => o.trim());
    if (filled.length < 2) issues.push('needs ≥2 options');
    if (row.correctIndex < 0 || !row.options[row.correctIndex]?.trim()) issues.push('mark the correct answer');
    return { ...row, issues };
  };
  const patch = (i: number, p: Partial<ScopedImportRow>) => setRows(rs => rs!.map((r, j) => j === i ? recompute({ ...r, ...p }) : r));
  const patchOpt = (i: number, oi: number, val: string) => setRows(rs => rs!.map((r, j) => j === i ? recompute({ ...r, options: r.options.map((o, k) => k === oi ? val : o) }) : r));
  const removeRow = (i: number) => setRows(rs => rs!.filter((_, j) => j !== i));

  const ready = useMemo(() => (rows || []).filter(r => r.issues.length === 0), [rows]);
  const badCount = (rows || []).length - ready.length;

  const doImport = async () => {
    if (!ready.length) return;
    setBusy(true);
    try {
      const res = await api.importScopedQuestions(ready.map(scopedRowToImport));
      setResult(res); setRows(null); setText('');
      toast(`Imported ${res.imported} question${res.imported === 1 ? '' : 's'} into ${res.sets.length} draft set${res.sets.length === 1 ? '' : 's'}`);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="toolbar">
        <div>
          <h2 style={{ fontSize: 22 }}>Bulk import practice questions</h2>
          <p className="lead" style={{ marginBottom: 0 }}>Each row carries its scope — <b>grade</b>, <b>battery</b>, <b>category</b>, <b>difficulty</b> — plus the question. Paste or upload a CSV, review &amp; fix, then import. Rows land in <b>draft</b> sets grouped by scope; publish each in Content to reach students.</p>
        </div>
        <Link className="btn ghost" to="/content/questions">← Questions</Link>
      </div>

      {!manage ? <div className="empty">You need content authoring permission to import questions.</div> : (
        <div className="panel">
          <div className="rowactions" style={{ marginBottom: 8 }}>
            <button className="btn ghost sm" onClick={downloadTemplate}>⤓ Download template</button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
            <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Choose CSV file</button>
            <button className="btn sm" onClick={() => parse(text)} disabled={!text.trim()}>Parse &amp; preview</button>
          </div>
          <textarea rows={4} value={text} onChange={e => setText(e.target.value)}
            placeholder={'Paste CSV rows here (with the header row: grade,battery,category,difficulty,stem,type,option_a,option_b,...,correct,explanation), or use "Choose CSV file"…'}
            style={{ fontFamily: 'ui-monospace,monospace', fontSize: 12.5, width: '100%' }} />
          {parseErr && <div className="err" style={{ marginTop: 8 }}>{parseErr}</div>}

          {rows && (
            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
                {ready.length} ready{badCount ? ` · ${badCount} need fixing (highlighted)` : ''}. Edit any cell to fix. Battery / category / difficulty are matched by name against the live taxonomy on import — a name we can't place comes back rejected with a reason.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto' }}>
                {rows.map((r, i) => (
                  <div key={i} className={`improw ${r.issues.length ? 'improw-bad' : ''}`}>
                    <div className="improw-head" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <span className="qnum">#{i + 1}</span>
                      <input style={{ width: 64 }} value={r.grade} placeholder="Grade" onChange={e => patch(i, { grade: e.target.value })} aria-label="Grade" />
                      <input style={{ width: 120 }} value={r.battery} placeholder="Battery" onChange={e => patch(i, { battery: e.target.value })} aria-label="Battery" />
                      <input style={{ width: 150 }} value={r.category} placeholder="Category" onChange={e => patch(i, { category: e.target.value })} aria-label="Category" />
                      <input style={{ width: 90 }} value={r.difficulty} placeholder="Difficulty" onChange={e => patch(i, { difficulty: e.target.value })} aria-label="Difficulty" />
                      <input className="imptype" style={{ width: 120 }} value={r.type} placeholder="type" onChange={e => patch(i, { type: e.target.value })} aria-label="Type" />
                      <button className="iconbtn danger" title="Remove row" onClick={() => removeRow(i)}>✕</button>
                    </div>
                    <input className="grow" style={{ width: '100%', marginTop: 6 }} value={r.stem} placeholder="Question stem" onChange={e => patch(i, { stem: e.target.value })} />
                    <div className="impopts">
                      {r.options.map((o, oi) => (
                        <label key={oi} className={`impopt ${oi === r.correctIndex ? 'correct' : ''}`}>
                          <input type="radio" name={`imp-${i}`} checked={oi === r.correctIndex} onChange={() => patch(i, { correctIndex: oi })} aria-label={`Mark option ${oi + 1} correct`} />
                          <input value={o} placeholder={`Option ${'ABCDEF'[oi]}`} onChange={e => patchOpt(i, oi, e.target.value)} />
                        </label>
                      ))}
                    </div>
                    {r.issues.length > 0 && <div className="impissue">⚠ {r.issues.join(' · ')}</div>}
                  </div>
                ))}
              </div>
              <div className="rowactions" style={{ marginTop: 12 }}>
                <button className="btn" disabled={busy || !ready.length} onClick={doImport}>{busy ? 'Importing…' : `Import ${ready.length} question${ready.length === 1 ? '' : 's'}`}</button>
              </div>
            </div>
          )}

          {result && (
            <div style={{ marginTop: 14 }}>
              <div className="aihint" style={{ background: 'var(--green-bg)', color: 'var(--green)' }}>
                ✓ Imported <b>{result.imported}</b> question{result.imported === 1 ? '' : 's'} into <b>{result.sets.length}</b> draft set{result.sets.length === 1 ? '' : 's'}. Open <Link to="/content">Content</Link> to review and <b>Publish</b> — published sets appear on the CCAT Practice website under their battery → category → difficulty for that grade.
              </div>
              {result.sets.length > 0 && (
                <div className="tablewrap" style={{ marginTop: 10 }}><table>
                  <thead><tr><th>Set</th><th>Grade</th><th>Battery</th><th>Category</th><th>Difficulty</th><th>Questions</th></tr></thead>
                  <tbody>{result.sets.map(s => (
                    <tr key={s.set_version_id}><td>{s.name}</td><td>{s.grade}</td><td>{s.battery}</td><td>{s.category}</td><td>{s.difficulty}</td><td className="tabnum">{s.question_count}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
              {result.rejected.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div className="err" style={{ marginBottom: 6 }}>{result.rejected.length} row{result.rejected.length === 1 ? '' : 's'} rejected — fix the CSV and re-import:</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {result.rejected.map(rj => <li key={rj.index} className="muted" style={{ fontSize: 12.5 }}>Row {rj.index + 1}: {rj.reasons.join(' · ')}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
