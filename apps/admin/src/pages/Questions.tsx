import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Modal, ErrorBox, useToast } from '../components/ui';
import { QuestionEditor } from '../components/QuestionEditor';

const STATES = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'approved', label: 'Approved' },
  { key: 'published', label: 'Published' },
  { key: 'retired', label: 'Retired' },
];
const STATE_LABEL: Record<string, string> = {
  draft: 'Draft', automated_checks: 'Automated checks', expert_review: 'Expert review',
  approved: 'Approved', published: 'Published', retired: 'Retired',
};

export function Questions() {
  const { can } = useAuth();
  const toast = useToast();
  const [state, setState] = useState('');
  const [search, setSearch] = useState('');
  const [gradeId, setGradeId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [taxonomy, setTaxonomy] = useState<any>(null);

  const [editing, setEditing] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState<any[] | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try { const r = await api.questions({ state: state || undefined, search: search.trim() || undefined, grade_id: gradeId || undefined, category_id: categoryId || undefined }); setItems(r.items); }
    catch (e) { setError(e); } finally { setLoading(false); }
  };
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [state, search, gradeId, categoryId]); // eslint-disable-line
  useEffect(() => { api.taxonomy().then(setTaxonomy).catch(() => {}); }, []);

  const act = async (fn: () => Promise<any>, msg: string) => {
    try { await fn(); toast(msg); load(); } catch (e) { toast((e as Error).message); }
  };
  const openEdit = async (id: string) => { const d = await api.question(id); setEditing(d); };
  const openHistory = async (id: string) => { const r = await api.questionVersions(id); setHistory(r.items); };
  const revise = async (id: string) => {
    try { const r = await api.reviseQuestion(id); await openEdit(r.id); toast('New editable version created'); load(); }
    catch (e) { toast((e as Error).message); }
  };
  const removeDraft = async (id: string) => {
    if (!confirm('Delete this unreferenced draft question? This cannot be undone.')) return;
    await act(() => api.deleteQuestion(id), 'Draft deleted');
  };

  return (
    <div>
      <div className="toolbar">
        <div>
          <h2 style={{ fontSize: 22 }}>Questions</h2>
          <p className="lead" style={{ marginBottom: 0 }}>Author, review and publish CCAT items. Drafts are editable; approved and published versions are immutable.</p>
        </div>
        <div className="rowactions">
          {can('content.create') && <Link className="btn ghost" to="/content/import">⤓ Import from CSV</Link>}
          {can('content.create') && <button className="btn" onClick={() => setCreating(true)}>+ Add question</button>}
        </div>
      </div>

      <div className="filterchips">
        {STATES.map(s => <button key={s.key} className={`chipbtn ${state === s.key ? 'on' : ''}`} onClick={() => setState(s.key)}>{s.label}</button>)}
      </div>
      <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
        <div className="rowactions" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search question text or type…" style={{ minWidth: 260, flex: 1 }} />
          <select value={gradeId} onChange={e => setGradeId(e.target.value)} style={{ width: 150 }}>
            <option value="">All grades</option>{(taxonomy?.grades ?? []).map((g: any) => <option key={g.id} value={g.id}>Grade {g.grade_number}</option>)}
          </select>
          <select value={categoryId} onChange={e => setCategoryId(e.target.value)} style={{ width: 210 }}>
            <option value="">All categories</option>{(taxonomy?.categories ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>

      {error ? <ErrorBox e={error} /> : (
        <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="tablewrap"><table>
            <thead><tr><th>Question</th><th>Category</th><th>Grade</th><th>Difficulty</th><th>State</th><th></th></tr></thead>
            <tbody>{items.map(q => (
              <tr key={q.id}>
                <td><div className="qrow-prev">{q.preview || '(no text)'}</div><div className="muted" style={{ fontSize: 12 }}>v{q.version_number} · {q.question_type}</div></td>
                <td>{q.category}<div className="muted" style={{ fontSize: 12 }}>{q.subcategory}</div></td>
                <td>Grade {q.grade_number}</td>
                <td style={{ textTransform: 'capitalize' }}>{q.difficulty}</td>
                <td><span className={`pill dotted s-${q.state}`} style={{ textTransform: 'none' }}>{STATE_LABEL[q.state] || q.state}</span></td>
                <td><div className="rowactions">
                  {q.state === 'draft' && can('content.create') && <button className="btn ghost sm" onClick={() => openEdit(q.id)}>Edit</button>}
                  {q.state === 'draft' && can('content.edit') && <button className="btn warn sm" onClick={() => removeDraft(q.id)}>Delete</button>}
                  {q.state === 'draft' && can('content.review') && <button className="btn green sm" onClick={() => act(() => api.reviewQuestion(q.id, 'approved'), 'Approved')}>Approve</button>}
                  {q.state === 'approved' && can('content.review') && <button className="btn ghost sm" onClick={() => act(() => api.reviewQuestion(q.id, 'changes_requested'), 'Sent back to draft')}>Request changes</button>}
                  {q.state === 'approved' && can('content.publish') && <button className="btn sm" onClick={() => act(() => api.publishQuestion(q.id), 'Published')}>Publish</button>}
                  {q.state === 'published' && can('content.retire') && <button className="btn warn sm" onClick={() => act(() => api.retireQuestion(q.id), 'Retired')}>Retire</button>}
                  {q.state !== 'draft' && can('content.edit') && <button className="btn ghost sm" onClick={() => revise(q.id)}>Revise</button>}
                  <button className="btn ghost sm" onClick={() => openHistory(q.id)}>History</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
          {loading && <div className="empty">Loading…</div>}
          {!loading && items.length === 0 && <div className="empty">No questions in this view. Add your first with <b>+ Add question</b>, or bring many in at once with <b>Import from CSV</b>.</div>}
        </div>
      )}

      {(creating || editing) && taxonomy && (
        <QuestionEditor taxonomy={taxonomy} editing={editing} onClose={() => { setCreating(false); setEditing(null); }} onSaved={() => { setCreating(false); setEditing(null); load(); }} />
      )}

      {history && (
        <Modal title="Version history" onClose={() => setHistory(null)}>
          {history.length === 0 ? <div className="empty">No versions.</div> : history.map(v => (
            <div className="minirow" key={v.id}>
              <div className="grow"><b>v{v.version_number}</b> <span className={`pill dotted s-${v.state}`} style={{ textTransform: 'none' }}>{STATE_LABEL[v.state] || v.state}</span></div>
              <div className="muted" style={{ fontSize: 12.5, textAlign: 'right' }}>{v.author || 'system'}<br />{new Date(v.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}
