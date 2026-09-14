import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Loading, ErrorBox, Modal, useToast } from '../components/ui';
import { ContentTabs } from './Content';
import { BulkSets } from '../components/BulkSets';
import { SetEditor } from '../components/SetEditor';
import { RenameSetName } from '../components/RenameSetName';

// EXAM PAPERS (new model): Battery (category) → Sets → Questions. No subcategory. Presented as the SAME
// full-width set table as Practice (rename in place, Questions progress bar, Status, Updated, Actions) —
// plus a Time-limit column, since exam sets are timed and practice sets are not. Edit opens the shared
// SetEditor. Backend accepts allowed_exam sets with a NULL subcategory.

const BATTERIES = [
  { key: 'verbal', label: 'Verbal', color: '#5b8def' },
  { key: 'quantitative', label: 'Quantitative', color: '#12b886' },
  { key: 'non_verbal', label: 'Non-verbal', color: '#7b61ff' },
];
const MAX_Q = 60;
const slugKey = (s: string) => (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const fmtDate = (d: string) => {
  if (!d) return '—';
  const t = new Date(d); if (isNaN(t.getTime())) return '—';
  return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export function ExamPapers() {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('content.create');
  const [tax, setTax] = useState<any>(null);
  const [sets, setSets] = useState<any[] | null>(null);
  const [error, setError] = useState<any>(null);
  const [grade, setGrade] = useState<string>('');
  const [battery, setBattery] = useState<string>('verbal');
  const [creating, setCreating] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const catIdFor = (key: string) => (tax?.categories ?? []).find((c: any) => c.key === key)?.id as string | undefined;

  const loadSets = () => api.sets().then(r => setSets(r.items)).catch(setError);
  useEffect(() => { loadSets(); api.taxonomy().then(setTax).catch(() => {}); }, []);
  useEffect(() => { if (!grade && tax?.grades?.length) setGrade(String(tax.grades[0].grade_number)); }, [tax]); // eslint-disable-line

  // Exam sets in this grade + selected battery.
  const examSets = useMemo(() => (sets || []).filter(s =>
    s.allowed_exam && (!grade || String(s.grade_number) === grade) && s.category_id === catIdFor(battery)
  ), [sets, grade, battery, tax]); // eslint-disable-line

  const act = async (fn: Promise<any>, m: string) => { try { await fn; toast(m); loadSets(); } catch (e) { toast((e as Error).message); } };
  const saveDuration = async (id: string, mins: number) => {
    const v = Math.max(1, Math.min(180, Math.round(mins) || 0));
    await act(api.patchSet(id, { duration_minutes: v }), `Time limit ${v} min`);
  };
  const doDelete = async (id: string) => { try { await api.deleteSet(id); toast('Deleted'); loadSets(); } catch (e) { toast((e as Error).message); } };

  const gradeObj = tax?.grades?.find((g: any) => String(g.grade_number) === grade);
  const batteryLabel = BATTERIES.find(b => b.key === battery)?.label || '';

  return (
    <div>
      <div className="toolbar" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 22 }}>Content</h2>
          <p className="lead" style={{ marginBottom: 0 }}>Exam papers are single-battery timed sets. Pick a battery, add sets, then publish.</p>
        </div>
        <div className="row" style={{ margin: 0, gap: 8 }}>
          {manage && <button className="btn ghost" onClick={() => { if (!catIdFor(battery)) { toast('Pick a battery first'); return; } setBulk(true); }}>⤓ Bulk add sets</button>}
          {manage && <button className="btn" onClick={() => setCreating(true)}>+ New exam set</button>}
        </div>
      </div>

      <div className="contentnav">
        <ContentTabs active="exam" />
        {tax && (
          <label className="gradesel">GRADE
            <select value={grade} onChange={e => setGrade(e.target.value)}>
              {tax.grades.map((g: any) => <option key={g.id} value={g.grade_number}>Grade {g.grade_number}</option>)}
            </select>
          </label>
        )}
      </div>

      {/* battery selector */}
      <div className="row" style={{ gap: 10, margin: '6px 0 16px', flexWrap: 'wrap' }}>
        {BATTERIES.map(b => {
          const on = battery === b.key;
          const count = (sets || []).filter(s => s.allowed_exam && (!grade || String(s.grade_number) === grade) && s.category_id === catIdFor(b.key)).length;
          return (
            <button key={b.key} onClick={() => setBattery(b.key)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 999,
                border: `2px solid ${on ? b.color : 'transparent'}`, background: on ? '#fff' : '#f2f4f9',
                color: on ? b.color : '#2a3450', fontWeight: 700, fontFamily: 'Poppins, sans-serif', cursor: 'pointer' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: b.color }} />
              {b.label} <span style={{ fontSize: 12, color: '#9aa3b5' }}>{count}</span>
            </button>
          );
        })}
      </div>

      {error ? <ErrorBox e={error} /> : sets === null ? <Loading /> : (
        <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="tablewrap"><table>
            <thead><tr><th>Set</th><th>Questions</th><th>Time limit</th><th>Status</th><th>Updated</th><th className="right">Actions</th></tr></thead>
            <tbody>{examSets.map(s => {
              const pct = Math.min(100, Math.round((s.question_count / MAX_Q) * 100));
              const barc = s.question_count >= 5 ? 'var(--green)' : s.question_count >= 1 ? 'var(--amber)' : 'var(--coral)';
              return (
                <tr key={s.id} className={s.state === 'retired' ? 'row-retired' : ''}>
                  <td>
                    <RenameSetName setId={s.id} name={s.name}
                      existingNames={new Set(examSets.filter(x => x.state !== 'retired' && x.id !== s.id).map(x => String(x.name || '').trim().toLowerCase()))}
                      onRenamed={() => loadSets()}>
                      <button className="linklike" style={{ fontWeight: 700 }} onClick={() => setEditId(s.id)}>{s.name}</button>
                    </RenameSetName>
                    <div className="muted" style={{ fontSize: 12 }}>{batteryLabel} · v{s.version_number} · exam</div>
                  </td>
                  <td style={{ minWidth: 130 }}>
                    <div className="tabnum" style={{ fontWeight: 700, color: barc }}>{s.question_count} / {MAX_Q}</div>
                    <div className="rbar"><i style={{ width: `${Math.max(4, pct)}%`, background: barc }} /></div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className="muted" style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>⏱
                      <input key={`${s.id}-${s.duration_minutes}`} type="number" min={1} max={180} defaultValue={s.duration_minutes ?? 30} disabled={!manage}
                        onBlur={e => saveDuration(s.id, Number(e.target.value))} style={{ width: 56 }} /> min</span>
                  </td>
                  <td><span className={`pill s-${s.state}`} style={{ textTransform: 'uppercase', fontSize: 11, letterSpacing: '.03em' }}>{s.state}</span></td>
                  <td className="muted tabnum" style={{ fontSize: 12.5 }}>{fmtDate(s.updated_at)}</td>
                  <td><div className="rowactions" style={{ justifyContent: 'flex-end' }}>
                    {manage && <button className="btn ghost sm" onClick={() => setEditId(s.id)}>Edit</button>}
                    {s.state === 'draft' && can('content.publish') && <button className="btn green sm" onClick={() => act(api.publishSet(s.id), 'Published')}>Publish</button>}
                    {s.state === 'published' && can('content.retire') && <button className="btn amber sm" onClick={() => act(api.retireSet(s.id), 'Retired — removed from the student catalog')}>Retire</button>}
                    {manage && <button className="btn ghost sm" onClick={() => act(api.copySet(s.id), 'Copied to a new draft')}>Copy</button>}
                    {manage && <button className="btn danger sm" onClick={() => doDelete(s.id)}>Delete</button>}
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table></div>
          {examSets.length === 0 && <div className="empty">No {batteryLabel} exam sets in Grade {grade} yet.</div>}
        </div>
      )}

      {creating && tax && gradeObj && catIdFor(battery) && (
        <NewExamSet gradeObj={gradeObj} categoryId={catIdFor(battery)!} batteryLabel={batteryLabel}
          onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); loadSets(); setEditId(id); }} />
      )}
      {bulk && tax && gradeObj && catIdFor(battery) && (() => {
        const catId = catIdFor(battery)!;
        const subObj = (tax.subcategories || []).filter((s: any) => s.category_id === catId).sort((a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0))[0];
        const diffObj = (tax.difficulties || []).find((d: any) => d.key === 'medium') || (tax.difficulties || [])[0];
        const catObj = (tax.categories || []).find((c: any) => c.id === catId);
        if (!subObj || !diffObj || !catObj) { toast('Add a subcategory + difficulty to this battery first'); setBulk(false); return null; }
        return (
          <BulkSets exam taxonomy={tax} existingSets={examSets}
            ctx={{ gradeId: gradeObj.id, catId, subId: subObj.id, diffId: diffObj.id,
              qType: slugKey(subObj.key) || 'verbal_analogy',
              gradeNumber: gradeObj.grade_number, categoryName: catObj.name, subcategoryName: subObj.name,
              difficultyLabel: diffObj.name, diffKey: diffObj.key, maxPerSet: 15 }}
            onClose={() => setBulk(false)} onDone={() => loadSets()} />
        );
      })()}
      {editId && tax && (
        <SetEditor taxonomy={tax} setId={editId} onClose={() => setEditId(null)} onSaved={() => loadSets()} />
      )}
    </div>
  );
}

function NewExamSet({ gradeObj, categoryId, batteryLabel, onClose, onDone }: { gradeObj: any; categoryId: string; batteryLabel: string; onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState(''); const [dur, setDur] = useState('25');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => {
    if (!name.trim()) { setErr('Name required'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.createSet({
        name: name.trim(), grade_id: gradeObj.id, category_id: categoryId,
        allowed_practice: false, allowed_exam: true, allowed_timers: ['timed'],
        question_version_ids: [], duration_minutes: Math.max(1, Math.min(180, Number(dur) || 25)),
      });
      toast('Exam set created'); onDone(r.set_version_id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`New ${batteryLabel} exam set`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button><button className="btn grow" disabled={busy} onClick={save}>Create</button></>}>
      <label>Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Verbal — Set 1" />
      <label style={{ marginTop: 10 }}>Time limit (min)</label>
      <input type="number" min={1} max={180} value={dur} onChange={e => setDur(e.target.value)} />
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Single-battery ({batteryLabel}) timed set. Add up to {MAX_Q} questions next.</p>
      <div className="err">{err}</div>
    </Modal>
  );
}
