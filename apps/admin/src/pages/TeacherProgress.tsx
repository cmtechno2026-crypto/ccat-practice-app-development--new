import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

// TeacherHub → Teacher Progress. Shows every teacher's real training-module completion, read live
// from the TeacherHub DB (public.ta_training_progress joined to ta_teachers). Read-only.
const navy = 'var(--brand,#1c3f6e)';
const good = 'var(--good,#0f9d6b)';
const card: React.CSSProperties = { background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16 };
const inp: React.CSSProperties = { border: '1px solid var(--line,#d7dce8)', borderRadius: 9, padding: '9px 11px', fontSize: 13.5, background: 'var(--card2,#f7f9fc)', color: 'inherit', outline: 'none' };

interface Mod { id: number; title: string; icon: string | null }
interface Row { id: string; name: string; email: string; passed: number; last_at: string | null; passed_ids: number[] }

const fmtDate = (s: string | null) => { if (!s) return '—'; try { return new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return '—'; } };

export function TeacherProgress() {
  const [total, setTotal] = useState(0);
  const [modules, setModules] = useState<Mod[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'progress' | 'name'>('progress');

  useEffect(() => {
    let on = true;
    setLoading(true);
    api.teacherTrainingProgress()
      .then(r => { if (!on) return; setTotal(r.total); setModules(r.modules); setRows(r.teachers); setErr(''); })
      .catch(e => on && setErr(e.message || 'Failed to load progress'))
      .finally(() => on && setLoading(false));
    return () => { on = false; };
  }, []);

  const view = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows;
    if (q) list = list.filter(r => (r.name || '').toLowerCase().includes(q) || (r.email || '').toLowerCase().includes(q));
    list = [...list].sort(sort === 'name'
      ? (a, b) => (a.name || '').localeCompare(b.name || '')
      : (a, b) => (b.passed - a.passed) || (a.name || '').localeCompare(b.name || ''));
    return list;
  }, [rows, search, sort, total]);

  const stats = useMemo(() => {
    const n = rows.length;
    const done = rows.filter(r => total > 0 && r.passed >= total).length;
    const started = rows.filter(r => r.passed > 0).length;
    const avg = n && total ? Math.round((rows.reduce((s, r) => s + Math.min(r.passed, total), 0) / (n * total)) * 100) : 0;
    return { n, done, started, avg };
  }, [rows, total]);

  const Stat = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div style={{ ...card, flex: '1 1 140px', minWidth: 130 }}>
      <div style={{ fontSize: 22, fontWeight: 900, color: navy, lineHeight: 1 }}>{value}</div>
      <div className="muted" style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', marginTop: 6 }}>{label}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--muted,#8a90a6)' }}>
          <Link to="/teacherhub/training" style={{ color: 'inherit', textDecoration: 'none' }}>Training</Link> / Teacher progress
        </div>
        <h2 style={{ margin: '4px 0 2px', fontSize: 22, fontWeight: 900, color: navy }}>Teacher progress</h2>
        <div className="muted" style={{ fontSize: 13 }}>Module completion across all TeacherHub teachers, read live from the app.</div>
      </div>

      {err && <div style={{ ...card, borderColor: '#f0c7c0', background: '#fdeeec', color: '#9a3a2c', fontSize: 13 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Stat label="Teachers" value={stats.n} />
        <Stat label="Active modules" value={total} />
        <Stat label="Avg completion" value={`${stats.avg}%`} />
        <Stat label="Started / Finished" value={`${stats.started} / ${stats.done}`} />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input style={{ ...inp, flex: '1 1 220px', maxWidth: 320 }} placeholder="Search teacher by name or email…" value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ display: 'inline-flex', border: '1px solid var(--line,#d7dce8)', borderRadius: 9, overflow: 'hidden' }}>
          <button onClick={() => setSort('progress')} style={{ border: 'none', background: sort === 'progress' ? 'var(--brand,#2f6fd0)' : 'var(--card2,#f7f9fc)', color: sort === 'progress' ? '#fff' : 'var(--muted,#647089)', fontWeight: 800, fontSize: 12.5, padding: '8px 12px', cursor: 'pointer' }}>By progress</button>
          <button onClick={() => setSort('name')} style={{ border: 'none', background: sort === 'name' ? 'var(--brand,#2f6fd0)' : 'var(--card2,#f7f9fc)', color: sort === 'name' ? '#fff' : 'var(--muted,#647089)', fontWeight: 800, fontSize: 12.5, padding: '8px 12px', cursor: 'pointer' }}>By name</button>
        </div>
      </div>

      {!loading && !err && rows.length > 0 && stats.started === 0 && (
        <div style={{ ...card, borderColor: '#cfe0f6', background: 'var(--tint,#eaf1fb)', color: '#134682', fontSize: 12.5 }}>
          No teacher has completed a module yet — each teacher's row fills in as they finish training in the TeacherHub app.
        </div>
      )}

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '11px 14px', borderBottom: '1px solid var(--line,#e6e6ef)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--muted,#8a90a6)', position: 'sticky', left: 0, background: 'var(--card,#fff)' }}>Teacher</th>
                <th style={{ textAlign: 'left', padding: '11px 14px', borderBottom: '1px solid var(--line,#e6e6ef)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--muted,#8a90a6)', minWidth: 150 }}>Progress</th>
                {modules.map(m => (
                  <th key={m.id} title={m.title} style={{ textAlign: 'center', padding: '11px 6px', borderBottom: '1px solid var(--line,#e6e6ef)', fontSize: 16, width: 34 }}>{m.icon || '📘'}</th>
                ))}
                <th style={{ textAlign: 'right', padding: '11px 14px', borderBottom: '1px solid var(--line,#e6e6ef)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--muted,#8a90a6)', minWidth: 110 }}>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={3 + modules.length} style={{ padding: 20, textAlign: 'center', color: 'var(--muted,#8a90a6)' }}>Loading…</td></tr>}
              {!loading && view.length === 0 && <tr><td colSpan={3 + modules.length} style={{ padding: 20, textAlign: 'center', color: 'var(--muted,#8a90a6)' }}>No teachers match.</td></tr>}
              {!loading && view.map(r => {
                const pct = total ? Math.round((Math.min(r.passed, total) / total) * 100) : 0;
                const full = total > 0 && r.passed >= total;
                return (
                  <tr key={r.id}>
                    <td style={{ padding: '10px 14px', borderBottom: '1px solid var(--line,#f0f2f7)', position: 'sticky', left: 0, background: 'var(--card,#fff)' }}>
                      <div style={{ fontWeight: 700, color: navy, whiteSpace: 'nowrap' }}>{r.name || '—'}</div>
                      <div className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{r.email}</div>
                    </td>
                    <td style={{ padding: '10px 14px', borderBottom: '1px solid var(--line,#f0f2f7)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, height: 7, borderRadius: 999, background: '#eceff4', overflow: 'hidden', minWidth: 70 }}>
                          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: full ? good : 'var(--brand,#2f6fd0)' }} />
                        </div>
                        <span style={{ fontWeight: 800, fontSize: 12, color: full ? good : navy, whiteSpace: 'nowrap' }}>{r.passed}/{total}</span>
                      </div>
                    </td>
                    {modules.map(m => {
                      const p = r.passed_ids.includes(m.id);
                      return (
                        <td key={m.id} title={`${m.title}: ${p ? 'Passed' : 'Not done'}`} style={{ textAlign: 'center', padding: '10px 6px', borderBottom: '1px solid var(--line,#f0f2f7)' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 999, fontSize: 11, fontWeight: 800, background: p ? 'var(--good-bg,#e6f5ec)' : '#eef0f4', color: p ? good : '#c2c8d4' }}>{p ? '✓' : ''}</span>
                        </td>
                      );
                    })}
                    <td style={{ padding: '10px 14px', borderBottom: '1px solid var(--line,#f0f2f7)', textAlign: 'right', whiteSpace: 'nowrap', color: 'var(--muted,#647089)', fontSize: 12.5 }}>{fmtDate(r.last_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
