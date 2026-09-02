import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Loading, ErrorBox, useToast } from '../components/ui';
import { CreateSet } from '../components/SetsView';
import { QuestionEditor } from '../components/QuestionEditor';
import { SetEditor } from '../components/SetEditor';
import { BulkSets, maxQuestionsForSub } from '../components/BulkSets';
import { RenameSetName } from '../components/RenameSetName';

const slugKey = (s: string) => (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const DIFFS = [{ k: 'easy', l: 'Easy' }, { k: 'medium', l: 'Medium' }, { k: 'hard', l: 'Hard' }];
const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;
const fmtDate = (d: string) => {
  const t = new Date(d), now = new Date();
  if (t.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now.getTime() - 864e5); if (t.toDateString() === y.toDateString()) return 'Yesterday';
  return t.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
// Category → emoji, matching the mockup's tree (Verbal 📖 · Non-verbal 🔷 · Quantitative 🔢).
const catIcon = (name: string) => {
  const n = (name || '').toLowerCase();
  if (n.includes('non') || n.includes('figure') || n.includes('spatial') || n.includes('visual')) return '🔷';
  if (n.includes('quant') || n.includes('number') || n.includes('math') || n.includes('equation')) return '🔢';
  if (n.includes('verbal') || n.includes('word') || n.includes('language')) return '📖';
  return '📚';
};

// In-page Practice-sets / Exam-papers pill toggle (mockup).
export function ContentTabs({ active }: { active: 'practice' | 'exam' }) {
  return (
    <div className="pilltabs">
      <Link to="/content" className={`pilltab ${active === 'practice' ? 'on' : ''}`}>Practice sets</Link>
      <Link to="/content/exams" className={`pilltab ${active === 'exam' ? 'on' : ''}`}>Exam papers</Link>
    </div>
  );
}

export function Content({ mode = 'practice' }: { mode?: 'practice' | 'exam' }) {
  const { can } = useAuth();
  const toast = useToast();
  const [tax, setTax] = useState<any>(null);
  const [sets, setSets] = useState<any[] | null>(null);
  const [error, setError] = useState<any>(null);
  const [grade, setGrade] = useState<string>('');
  const [diff, setDiff] = useState('medium');
  const [sub, setSub] = useState<string>('');
  const [newSet, setNewSet] = useState(false);
  const [bulkSets, setBulkSets] = useState(false);
  const [newQ, setNewQ] = useState(false);
  const [editSet, setEditSet] = useState<{ id: string; blank?: boolean; bulk?: boolean } | null>(null);
  const isExam = mode === 'exam';

  const load = () => { setError(null); api.sets().then(r => setSets(r.items)).catch(setError); };
  useEffect(() => { load(); api.taxonomy().then(setTax).catch(() => {}); }, []);
  useEffect(() => {
    if (grade || !tax?.grades?.length || !sets) return;
    const byGrade = new Map<string, number>(); const byDiff = new Map<string, Map<string, number>>();
    for (const s of sets) {
      const g = String(s.grade_number); byGrade.set(g, (byGrade.get(g) || 0) + 1);
      if (!byDiff.has(g)) byDiff.set(g, new Map());
      const dm = byDiff.get(g)!; dm.set(s.difficulty_key, (dm.get(s.difficulty_key) || 0) + 1);
    }
    const bestGrade = [...byGrade.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || String(tax.grades[0].grade_number);
    setGrade(bestGrade);
    const dm = byDiff.get(bestGrade);
    if (dm) { const bestDiff = [...dm.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; if (bestDiff) setDiff(bestDiff); }
  }, [tax, sets]); // eslint-disable-line

  const act = async (fn: Promise<any>, m: string) => { try { await fn; toast(m); load(); } catch (e) { toast((e as Error).message); } };
  // Per-set cap for a subcategory (45 for a "… Battery Combine", 15 otherwise) — read from the catalog.
  const subMaxById = (id: string) => maxQuestionsForSub((tax?.subcategories ?? []).find((s: any) => s.id === id));

  const inGrade = useMemo(() => (sets || [])
    .filter(s => !grade || String(s.grade_number) === grade)
    .filter(s => isExam ? s.allowed_exam : s.allowed_practice), [sets, grade, isExam]);
  // Category → subcategory tree. Seeded from the FULL taxonomy so EVERY battery is selectable even
  // when it has no sets yet (BUG A: creating a set under an empty battery). Counts overlay from the
  // grade's existing sets (0 for empty batteries); the table below still filters by difficulty.
  const tree = useMemo(() => {
    const m = new Map<string, { category: string; subs: Map<string, { name: string; count: number }> }>();
    for (const c of (tax?.categories ?? [])) {
      const subs = new Map<string, { name: string; count: number }>();
      for (const s of (tax?.subcategories ?? []).filter((s: any) => s.category_id === c.id)) subs.set(s.id, { name: s.name, count: 0 });
      if (subs.size) m.set(c.id, { category: c.name, subs });
    }
    for (const s of inGrade) {
      if (!m.has(s.category_id)) m.set(s.category_id, { category: s.category, subs: new Map() });
      const c = m.get(s.category_id)!;
      const cur = c.subs.get(s.subcategory_id) || { name: s.subcategory, count: 0 };
      cur.count++; c.subs.set(s.subcategory_id, cur);
    }
    return m;
  }, [tax, inGrade]);

  // Auto-select the first subcategory (mockup always has one active).
  useEffect(() => {
    if (sub) { if (![...tree.values()].some(c => c.subs.has(sub))) setSub(''); return; }
    const first = [...tree.values()][0]?.subs.keys().next().value;
    if (first) setSub(first);
  }, [tree]); // eslint-disable-line

  // Render sets in the ORDER THE GATEWAY RETURNS — canonical: active oldest→newest (new one at the
  // bottom), then retired last (see /v1/admin/content/sets ORDER BY). No client-side re-sort: filtering
  // preserves the server order, so we must NOT sort by name (numeric/editable → lexical 1,10,11,2).
  const rows = useMemo(() => inGrade
    .filter(s => s.difficulty_key === diff && (!sub || s.subcategory_id === sub)), [inGrade, diff, sub]);
  const activeSubName = sub ? (inGrade.find(s => s.subcategory_id === sub)?.subcategory) : null;
  const activeCatName = sub ? (inGrade.find(s => s.subcategory_id === sub)?.category) : null;

  if (error) return <div><h2>Content</h2><ErrorBox e={error} /></div>;

  return (
    <div>
      <div className="toolbar" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 22 }}>Content</h2>
          <p className="lead" style={{ marginBottom: 0 }}>Practice sets power the Practice tab; exam papers are full three-section CCAT forms.</p>
        </div>
        <div className="row" style={{ margin: 0, gap: 8 }}>
          {can('content.create') && <button className="btn ghost" onClick={() => setNewQ(true)}>+ New question</button>}
          {!isExam && can('content.create') && <button className="btn ghost" onClick={() => { if (!sub) { toast('Pick a subcategory on the left first'); return; } setBulkSets(true); }}>⤓ Bulk add sets</button>}
          {can('content.create') && <button className="btn" onClick={() => setNewSet(true)}>+ New {isExam ? 'exam set' : 'set'}</button>}
        </div>
      </div>

      <div className="contentnav">
        <ContentTabs active={isExam ? 'exam' : 'practice'} />
        {tax && (
          <label className="gradesel">GRADE
            <select value={grade} onChange={e => { setGrade(e.target.value); setSub(''); }}>
              {tax.grades.map((g: any) => <option key={g.id} value={g.grade_number}>Grade {g.grade_number}</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="muted" style={{ fontSize: 13, margin: '2px 0 14px' }}>Everything you add, edit or view here belongs to <b style={{ color: 'var(--primary)' }}>Grade {grade}</b>.</p>

      {sets === null ? <Loading /> : (
        <div className="contentgrid">
          {/* category tree */}
          <aside className="cattree">
            {[...tree.values()].map((c, ci) => (
              <div key={ci} className="treecat">
                <div className="treecathd"><span>{catIcon(c.category)} {c.category}</span><span className="muted">{c.subs.size} group{c.subs.size === 1 ? '' : 's'}</span></div>
                {[...c.subs.entries()].map(([sid, sv]) => (
                  <button key={sid} className={`treesub ${sub === sid ? 'on' : ''}`} onClick={() => setSub(sid)}>
                    <span>{sv.name}</span><span className="muted tabnum">{sv.count} set{sv.count === 1 ? '' : 's'}</span>
                  </button>
                ))}
              </div>
            ))}
            {tree.size === 0 && <div className="muted" style={{ padding: 10, fontSize: 13 }}>No {diff} sets in Grade {grade}.</div>}
          </aside>

          {/* difficulty tabs + set table */}
          <div>
            <div className="contenthdr">
              <div className="muted" style={{ fontSize: 13 }}>{activeSubName ? `${activeCatName} → ${activeSubName}` : `All sets · Grade ${grade}`}</div>
              <div className="filterchips" style={{ margin: 0 }}>
                {DIFFS.map(d => <button key={d.k} className={`chipbtn ${diff === d.k ? 'on' : ''}`} onClick={() => { setDiff(d.k); }}>{d.l}</button>)}
              </div>
            </div>
            <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="tablewrap"><table>
                <thead><tr><th>Set</th><th>Questions</th><th>Status</th><th>Updated</th><th className="right">Actions</th></tr></thead>
                <tbody>{rows.map(s => {
                  const target = subMaxById(s.subcategory_id); const pct = Math.min(100, Math.round((s.question_count / target) * 100));
                  const barc = s.question_count >= target ? 'var(--green)' : s.question_count >= 5 ? 'var(--amber)' : 'var(--coral)';
                  return (
                    <tr key={s.id} className={s.state === 'retired' ? 'row-retired' : ''}>
                      <td>
                        <RenameSetName setId={s.id} name={s.name}
                          existingNames={new Set((sets || []).filter(x => String(x.grade_number) === String(s.grade_number) && x.subcategory_id === s.subcategory_id && x.difficulty_key === s.difficulty_key && x.state !== 'retired' && x.id !== s.id).map(x => String(x.name || '').trim().toLowerCase()))}
                          onRenamed={() => load()}>
                          <button className="linklike" style={{ fontWeight: 700 }} onClick={() => setEditSet({ id: s.id })}>{s.name}</button>
                        </RenameSetName>
                        <div className="muted" style={{ fontSize: 12 }}>{cap(s.difficulty_key || 'medium')} · v{s.version_number} · {[s.allowed_practice && 'practice', s.allowed_exam && 'exam'].filter(Boolean).join(' + ') || 'practice'}</div></td>
                      <td style={{ minWidth: 130 }}>
                        <div className="tabnum" style={{ fontWeight: 700, color: barc }}>{s.question_count} / {target}</div>
                        <div className="rbar"><i style={{ width: `${Math.max(4, pct)}%`, background: barc }} /></div>
                      </td>
                      <td><span className={`pill s-${s.state}`} style={{ textTransform: 'uppercase', fontSize: 11, letterSpacing: '.03em' }}>{s.state}</span></td>
                      <td className="muted tabnum" style={{ fontSize: 12.5 }}>{fmtDate(s.updated_at)}</td>
                      <td><div className="rowactions" style={{ justifyContent: 'flex-end' }}>
                        {can('content.create') && <button className="btn ghost sm" onClick={() => setEditSet({ id: s.id })}>Edit</button>}
                        {s.state === 'draft' && can('content.publish') && <button className="btn sm" onClick={() => act(api.publishSet(s.id), 'Published')}>Publish</button>}
                        {s.state === 'published' && can('content.retire') && <button className="btn amber sm" onClick={() => act(api.retireSet(s.id), 'Retired — removed from the student catalog')}>Retire</button>}
                        {can('content.create') && <button className="btn ghost sm" onClick={() => act(api.copySet(s.id), 'Copied to a new draft')}>Copy</button>}
                        {can('content.create') && <button className="btn danger sm" onClick={() => act(api.deleteSet(s.id), 'Deleted')}>Delete</button>}
                      </div></td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
              {rows.length === 0 && <div className="empty">No {diff} sets{activeSubName ? ` in ${activeSubName}` : ` in Grade ${grade}`} yet.</div>}
            </div>
            <div className="contentftr">
              <span className="muted" style={{ fontSize: 13 }}>{rows.length} {diff} set{rows.length === 1 ? '' : 's'}{activeSubName ? ` in ${activeSubName}` : ` in Grade ${grade}`}</span>
              {can('content.create') && <button className="btn ghost sm" onClick={() => setNewSet(true)}>+ New set{activeSubName ? ` in ${activeSubName}` : ''}</button>}
            </div>
          </div>
        </div>
      )}

      {newSet && tax && (
        <CreateSet
          mode={isExam ? 'exam' : 'practice'}
          taxonomy={tax}
          prefill={{
            gradeId: tax.grades?.find((g: any) => String(g.grade_number) === grade)?.id,
            catId: sub ? tax.subcategories?.find((s: any) => s.id === sub)?.category_id : undefined,
            subId: sub || undefined,
            diffId: tax.difficulties?.find((d: any) => d.key === diff)?.id,
          }}
          onClose={() => setNewSet(false)}
          onDone={(id: string, opts?: { blank?: boolean; bulk?: boolean }) => { setNewSet(false); load(); setEditSet({ id, blank: opts?.blank, bulk: opts?.bulk }); }}
        />
      )}
      {newQ && tax && (
        <QuestionEditor taxonomy={tax} editing={null} onClose={() => setNewQ(false)} onSaved={() => { setNewQ(false); load(); }} />
      )}
      {bulkSets && tax && sub && (() => {
        const gradeObj = tax.grades?.find((g: any) => String(g.grade_number) === grade);
        const subObj = tax.subcategories?.find((s: any) => s.id === sub);
        const catObj = tax.categories?.find((c: any) => c.id === subObj?.category_id);
        const diffObj = tax.difficulties?.find((d: any) => d.key === diff);
        if (!gradeObj || !subObj || !catObj || !diffObj) return null;
        return (
          <BulkSets
            ctx={{
              gradeId: gradeObj.id, catId: catObj.id, subId: subObj.id, diffId: diffObj.id,
              qType: slugKey(subObj.key) || 'verbal_analogy',
              gradeNumber: gradeObj.grade_number, categoryName: catObj.name, subcategoryName: subObj.name,
              difficultyLabel: diffObj.name, diffKey: diff, maxPerSet: maxQuestionsForSub(subObj),
            }}
            existingSets={sets || []} taxonomy={tax}
            onClose={() => setBulkSets(false)} onDone={load}
          />
        );
      })()}
      {editSet && tax && (
        <SetEditor taxonomy={tax} setId={editSet.id} startBlank={editSet.blank} openBulk={editSet.bulk} onClose={() => setEditSet(null)} onSaved={load} />
      )}
    </div>
  );
}
