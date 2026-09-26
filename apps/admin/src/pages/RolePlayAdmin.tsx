import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// TeacherHub admin — Role-play scenarios. Authors scenarios (brief + observer rubric) teachers
// practise against. Draft/published gates teacher visibility. CRUD on ta_training_roleplays.
interface RolePlay {
  id: number; title: string; brief: string; observer_plays: string; rubric: string[] | null;
  est_mins: number; status: 'draft' | 'published'; sort_order: number;
}
type Draft = Omit<RolePlay, 'id' | 'sort_order'> & { id?: number };

const inp: React.CSSProperties = { padding: '8px 10px', border: '1px solid var(--line,#d7dce8)', borderRadius: 8, background: 'var(--card2,#f7f9fc)', color: 'inherit', font: 'inherit' };
const navy = 'var(--brand,#1c3f6e)';
const btnP: React.CSSProperties = { ...inp, cursor: 'pointer', fontWeight: 800, background: 'var(--brand,#2f6fd0)', color: '#fff', border: 'none' };
const btnG: React.CSSProperties = { ...inp, cursor: 'pointer', fontWeight: 700 };
const blank = (): Draft => ({ title: '', brief: '', observer_plays: '', rubric: [''], est_mins: 10, status: 'draft' });

export function RolePlayAdmin() {
  const { can } = useAuth();
  const canManage = can('teacher.slots.manage');
  const [rows, setRows] = useState<RolePlay[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);

  const load = () => { setLoading(true); api.trainingRoleplays().then(r => setRows(r.roleplays as RolePlay[])).catch(e => setErr(e.message)).finally(() => setLoading(false)); };
  useEffect(load, []);

  const save = async () => {
    if (!editing) return;
    if (!editing.title.trim()) { setErr('Title is required.'); return; }
    const rubric = (editing.rubric || []).map(r => r.trim()).filter(Boolean);
    setBusy(true); setErr('');
    const body = { title: editing.title.trim(), brief: editing.brief, observer_plays: editing.observer_plays, rubric, est_mins: editing.est_mins ?? 10, status: editing.status };
    try { if (editing.id) await api.trainingUpdateRoleplay(editing.id, body); else await api.trainingCreateRoleplay(body); setEditing(null); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async (r: RolePlay) => {
    if (!window.confirm(`Delete "${r.title}"? This cannot be undone.`)) return;
    setBusy(true); setErr('');
    try { await api.trainingDeleteRoleplay(r.id); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const setStatus = async (r: RolePlay, status: 'draft' | 'published') => {
    setBusy(true); setErr('');
    try { await api.trainingUpdateRoleplay(r.id, { status }); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const move = async (i: number, dir: -1 | 1) => {
    const j = i + dir; if (j < 0 || j >= rows.length) return;
    const next = rows.slice(); const [it] = next.splice(i, 1); next.splice(j, 0, it); setRows(next);
    try { await api.trainingReorderRoleplays(next.map(r => r.id)); } catch (e: any) { setErr(e.message); load(); }
  };

  const setCrit = (ci: number, val: string) => setEditing(e => e ? { ...e, rubric: (e.rubric || []).map((c, i) => i === ci ? val : c) } : e);
  const addCrit = () => setEditing(e => e ? { ...e, rubric: [...(e.rubric || []), ''] } : e);
  const rmCrit = (ci: number) => setEditing(e => e ? { ...e, rubric: (e.rubric || []).filter((_, i) => i !== ci) } : e);

  const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted,#647089)', padding: '10px 12px', borderBottom: '1px solid var(--line,#e6e6ef)', background: 'var(--card2,#f7f9fc)', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '10px 12px', fontSize: 13, verticalAlign: 'middle', borderBottom: '1px solid var(--line,#eef1f6)' };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Link to="/teacherhub/training" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--brand,#2f6fd0)', textDecoration: 'none', width: 'fit-content' }}>← Training overview</Link>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ marginRight: 'auto' }}>
          <h2 style={{ margin: '0 0 2px', fontSize: 21, fontWeight: 900, letterSpacing: '-.02em', color: navy }}>Role-play scenarios</h2>
          <div className="muted" style={{ fontSize: 13 }}>Practice conversations with a brief and an observer rubric. Only <b>published</b> scenarios show to teachers.</div>
        </div>
        {canManage && <button style={btnP} onClick={() => setEditing(blank())}>＋ New scenario</button>}
      </div>

      {err && <div className="empty" style={{ padding: 10, color: 'var(--coral,#c0392b)' }}>{err}</div>}

      {editing && canManage && (
        <section style={{ background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 16, color: navy }}>{editing.id ? 'Edit scenario' : 'New scenario'}</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'grid', gap: 4, flex: '2 1 260px' }}><span className="muted" style={{ fontSize: 12 }}>Title *</span>
                <input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} style={inp} placeholder="Handling a hesitant parent" /></label>
              <label style={{ display: 'grid', gap: 4, width: 130 }}><span className="muted" style={{ fontSize: 12 }}>Est. minutes</span>
                <input type="number" min={0} max={600} value={editing.est_mins ?? 0} onChange={e => setEditing({ ...editing, est_mins: Number(e.target.value) })} style={inp} /></label>
              <label style={{ display: 'grid', gap: 4, width: 150 }}><span className="muted" style={{ fontSize: 12 }}>Status</span>
                <select value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value as 'draft' | 'published' })} style={{ ...inp, cursor: 'pointer' }}><option value="draft">Draft</option><option value="published">Published</option></select></label>
            </div>
            <label style={{ display: 'grid', gap: 4 }}><span className="muted" style={{ fontSize: 12 }}>Scenario brief (what the teacher is asked to do)</span>
              <textarea value={editing.brief} onChange={e => setEditing({ ...editing, brief: e.target.value })} style={{ ...inp, minHeight: 90 }} /></label>
            <label style={{ display: 'grid', gap: 4 }}><span className="muted" style={{ fontSize: 12 }}>Observer plays (setup / what the partner role-plays)</span>
              <textarea value={editing.observer_plays} onChange={e => setEditing({ ...editing, observer_plays: e.target.value })} style={{ ...inp, minHeight: 70 }} /></label>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontWeight: 800, fontSize: 13, color: navy }}>Observer rubric</span>
                <span className="muted" style={{ fontSize: 12 }}>What the observer checks for.</span>
                <button style={{ ...btnG, marginLeft: 'auto', padding: '5px 10px' }} onClick={addCrit}>＋ Add point</button>
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                {(editing.rubric || []).map((c, ci) => (
                  <div key={ci} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: 'var(--muted,#647089)' }}>•</span>
                    <input value={c} onChange={e => setCrit(ci, e.target.value)} style={{ ...inp, flex: 1 }} placeholder="e.g. Acknowledged the parent's concern before responding" />
                    {(editing.rubric || []).length > 1 && <button style={{ ...btnG, padding: '4px 8px', color: 'var(--coral,#c0392b)' }} onClick={() => rmCrit(ci)}>✕</button>}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={btnP} disabled={busy} onClick={save}>{busy ? 'Saving…' : editing.id ? 'Save changes' : 'Create scenario'}</button>
              <button style={btnG} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        </section>
      )}

      {loading ? <div className="muted" style={{ padding: 12 }}>Loading…</div>
        : rows.length === 0 ? <div className="muted" style={{ padding: 12 }}>No scenarios yet. Create one to get started.</div>
        : (
          <div style={{ overflowX: 'auto', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, background: 'var(--card,#fff)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
              <thead><tr><th style={th}>Order</th><th style={th}>Scenario</th><th style={th}>Time</th><th style={th}>Status</th><th style={th}></th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id}>
                    <td style={td}><div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span className="muted" style={{ width: 18, textAlign: 'center' }}>{i + 1}</span>
                      {canManage && <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
                        <button style={{ ...btnG, padding: '0 6px', lineHeight: 1.2, opacity: i === 0 ? .35 : 1 }} disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
                        <button style={{ ...btnG, padding: '0 6px', lineHeight: 1.2, opacity: i === rows.length - 1 ? .35 : 1 }} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>▼</button>
                      </span>}
                    </div></td>
                    <td style={td}><div style={{ fontWeight: 700 }}>{r.title}</div>{r.brief && <div className="muted" style={{ fontSize: 12, maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.brief}</div>}</td>
                    <td style={td}><span className="muted">{r.est_mins ? `${r.est_mins} min` : '—'}</span></td>
                    <td style={td}>
                      <button onClick={() => canManage && setStatus(r, r.status === 'published' ? 'draft' : 'published')} disabled={!canManage || busy} title={r.status === 'published' ? 'Published — click to unpublish' : 'Draft — click to publish'}
                        style={{ cursor: canManage ? 'pointer' : 'default', border: 'none', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', background: r.status === 'published' ? 'var(--good-soft,#dcf5ea)' : '#fbf0d5', color: r.status === 'published' ? 'var(--good,#0f9d6b)' : 'var(--amber,#b8860b)' }}>
                        {r.status}
                      </button>
                    </td>
                    <td style={td}>{canManage && <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button style={{ ...btnG, padding: '5px 10px' }} onClick={() => setEditing({ id: r.id, title: r.title, brief: r.brief, observer_plays: r.observer_plays, rubric: (r.rubric && r.rubric.length ? r.rubric : ['']) as string[], est_mins: r.est_mins, status: r.status })}>Edit</button>
                      <button style={{ ...btnG, padding: '5px 10px', color: 'var(--coral,#c0392b)' }} onClick={() => del(r)}>Delete</button>
                    </div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
