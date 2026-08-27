import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Panel, Loading, ErrorBox } from '../components/ui';

const fmt = (d: string) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const CATS = [
  { k: '', l: 'All', c: 'var(--primary)' },
  { k: 'content', l: 'Content', c: 'var(--primary)' },
  { k: 'student', l: 'Student accounts', c: 'var(--coral)' },
  { k: 'economy', l: 'Economy', c: 'var(--amber)' },
  { k: 'governance', l: 'Governance', c: 'var(--purple, #5b3fa8)' },
];
const catColor = (c: string) => CATS.find(x => x.k === c)?.c || 'var(--muted)';

// Render a before→after diff from old_value/new_value JSON (mockup "WHAT CHANGED").
function Diff({ oldv, newv, reason, reference }: { oldv: any; newv: any; reason?: string; reference?: string }) {
  const keys = new Set<string>([...Object.keys(oldv || {}), ...Object.keys(newv || {})]);
  const parts: React.ReactNode[] = [];
  keys.forEach(k => {
    const a = oldv?.[k], b = newv?.[k];
    if (a === undefined && b !== undefined) parts.push(<span key={k}><b>{k}</b>: {JSON.stringify(b)}</span>);
    else if (JSON.stringify(a) !== JSON.stringify(b)) parts.push(<span key={k}><b>{k}</b>: {JSON.stringify(a)} → {JSON.stringify(b)}</span>);
  });
  return (
    <div>
      {reason && <div style={{ fontWeight: 600 }}>{reason}</div>}
      {parts.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{parts.reduce((acc: any, p, idx) => idx === 0 ? [p] : [...acc, <span key={'s' + idx}> · </span>, p], [])}</div>}
      {reference && <div className="muted" style={{ fontSize: 12 }}>ref {reference}</div>}
      {!reason && parts.length === 0 && !reference && <span className="muted">—</span>}
    </div>
  );
}

export function Audit() {
  const { can } = useAuth();
  const [scope, setScope] = useState<'self' | 'global'>('self');
  const [cat, setCat] = useState(''); const [q, setQ] = useState('');
  const [actor, setActor] = useState('');
  const [actors, setActors] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<any[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<any>(null);
  const [exporting, setExporting] = useState(false);

  const load = async (reset: boolean) => {
    setError(null);
    try {
      const r = await api.audit({ scope, category: cat || undefined, actor: actor || undefined, q: q || undefined, cursor: reset ? undefined : (cursor || undefined) });
      setItems(reset ? r.items : [...(items || []), ...r.items]);
      setCursor(r.next_cursor);
    } catch (e) { setError(e); }
  };
  useEffect(() => { setItems(null); load(true); }, [scope, cat, actor]); // eslint-disable-line
  // Whose-activity drilldown: load the distinct actors when viewing everyone's activity (AUDIT-1).
  useEffect(() => { if (scope === 'global') api.auditFacets('global').then(f => setActors(f.actors || [])).catch(() => setActors([])); else { setActors([]); setActor(''); } }, [scope]);
  const onSearch = (e: React.FormEvent) => { e.preventDefault(); setItems(null); load(true); };

  // Export is done SERVER-SIDE: the gateway enforces audit.export.self (and audit.read.global for the
  // global scope) and returns the full filtered set as CSV. The client no longer builds the CSV or
  // trusts a frontend-only permission check — it just downloads the authenticated response.
  const exportCsv = async () => {
    setExporting(true); setError(null);
    try {
      const { blob, filename, truncated } = await api.auditExport({ scope, category: cat || undefined, actor: actor || undefined, q: q || undefined });
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
      if (truncated) setError({ message: 'Export capped at 50,000 rows — narrow the filters to export the remainder.' });
    } catch (e) { setError(e); } finally { setExporting(false); }
  };

  return (
    <>
      <h2>Audit log</h2>
      <p className="lead">Every admin mutation with a before/after diff. Append-only; global scope needs audit.read.global (§25). Entries carry the Gateway request ID where captured.</p>

      <div className="toolbar" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 10, margin: 0, flexWrap: 'wrap' }}>
          {can('audit.read.global') && (
            <div className="filterchips" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className={`chipbtn ${scope === 'self' ? 'on' : ''}`} onClick={() => setScope('self')}>My activity</button>
              <button className={`chipbtn ${scope === 'global' ? 'on' : ''}`} onClick={() => setScope('global')}>Everyone</button>
              {scope === 'global' && actors.length > 0 && (
                <select value={actor} onChange={e => setActor(e.target.value)} aria-label="Filter by admin" style={{ marginLeft: 4 }}>
                  <option value="">All admins</option>
                  {actors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
            </div>
          )}
          <div className="filterchips" style={{ margin: 0 }}>
            {CATS.map(c => <button key={c.k} className={`chipbtn ${cat === c.k ? 'on' : ''}`} onClick={() => setCat(c.k)}>{c.l}</button>)}
          </div>
        </div>
        <div className="row" style={{ gap: 6, margin: 0 }}>
          <form onSubmit={onSearch} style={{ display: 'flex', gap: 6, margin: 0 }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search event, reason, reference…" />
            <button className="btn sm" type="submit">Search</button>
          </form>
          {can('audit.export.self') && <button className="btn ghost sm" onClick={exportCsv} disabled={exporting}>{exporting ? 'Exporting…' : 'Export CSV'}</button>}
        </div>
      </div>

      <Panel>
        {error ? <ErrorBox e={error} /> : items === null ? <Loading /> : (
          <>
            <div className="tablewrap"><table>
              <thead><tr><th>When</th><th>Who</th><th>What changed</th><th>Request</th></tr></thead>
              <tbody>{items.map((a: any) => (
                <tr key={a.id} style={{ borderLeft: `3px solid ${catColor(a.category)}` }}>
                  <td className="muted tabnum" style={{ fontSize: 12.5 }}>{fmt(a.created_at)}</td>
                  <td>
                    <div style={{ fontWeight: 700 }}>{a.actor_kind === 'system' ? 'system' : (a.actor_name || (a.actor_admin_id || '').slice(0, 8))}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{a.actor_kind === 'system' ? 'automated' : (a.actor_role === 'super_admin' ? 'Super-Admin' : 'Admin')} · <span style={{ color: catColor(a.category) }}>{a.event_type}</span></div>
                  </td>
                  <td style={{ maxWidth: 420 }}><Diff oldv={a.old_value} newv={a.new_value} reason={a.reason} reference={a.reference} /></td>
                  <td className="muted tabnum" style={{ fontSize: 12 }}>{a.request_id ? `req_${String(a.request_id).slice(0, 8)}` : '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {items.length === 0 && <div className="empty">No audit entries match these filters.</div>}
            {cursor && <div style={{ padding: 12, textAlign: 'center' }}><button className="btn ghost sm" onClick={() => load(false)}>Load more</button></div>}
          </>
        )}
      </Panel>
    </>
  );
}
