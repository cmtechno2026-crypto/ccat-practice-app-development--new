import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Modal, ErrorBox, useToast } from '../components/ui';

// ---- helpers ---------------------------------------------------------------
const AVATARS = ['🦊', '🐢', '🦋', '🦖', '🐝', '🦉', '🐬', '🐼', '🦁', '🐧'];
const avatarFor = (id: string) => AVATARS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATARS.length];

const STATUS_LABEL: Record<string, string> = {
  active: 'Active', suspended: 'Suspended', banned: 'Banned',
  pending_deletion: 'Pending deletion', device_revoked: 'Device revoked', purged: 'Purged',
};
function StatusChip({ s }: { s: string }) {
  return <span className={`pill dotted s-${s} st-${s}`} style={{ textTransform: 'none' }}>{STATUS_LABEL[s] || s}</span>;
}

function bandColor(band: string | null, pct: number | null) {
  if (band === 'ready' || (pct !== null && pct >= 70)) return { c: 'var(--green)', label: 'Ready' };
  if (band === 'needs_work' || (pct !== null && pct < 45)) return { c: 'var(--coral)', label: 'Needs work' };
  return { c: 'var(--amber)', label: 'Building' };
}

function Readiness({ pct, band, insufficient }: { pct: number | null; band: string | null; insufficient: boolean }) {
  if (insufficient || pct === null) return <span className="muted" style={{ fontSize: 13 }}>Not enough data</span>;
  const { c, label } = bandColor(band, pct);
  return (
    <div>
      <span className="readw tabnum" style={{ color: c }}>{pct}%</span>{' '}
      <span className="muted" style={{ fontSize: 12.5 }}>{label}</span>
      <div className="rbar"><i style={{ width: `${Math.max(4, Math.min(100, pct))}%`, background: c }} /></div>
    </div>
  );
}

const ALL_COLS = [
  { key: 'grade', label: 'Grade & status' },
  { key: 'readiness', label: 'Readiness' },
  { key: 'progress', label: 'Progress' },
  { key: 'email', label: 'Parent email' },
  { key: 'phone', label: 'Parent phone' },
  { key: 'devices', label: 'Devices' },
];
const SORTS = [
  { key: 'last_active', label: 'Last active' },
  { key: 'xp', label: 'XP' },
  { key: 'readiness', label: 'Readiness' },
  { key: 'grade', label: 'Grade' },
  { key: 'username', label: 'Username' },
  { key: 'created', label: 'Newest' },
];

function loadCols(): Set<string> {
  try {
    const raw = localStorage.getItem('ccat_admin_studcols');
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set(ALL_COLS.map(c => c.key));
}

// ---- component -------------------------------------------------------------
export function Students() {
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();

  const [stats, setStats] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [matched, setMatched] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);

  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [band, setBand] = useState<string | null>(null);
  const [sort, setSort] = useState('last_active');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [cols, setCols] = useState<Set<string>>(loadCols);
  const [menu, setMenu] = useState<string | null>(null); // 'sort' | 'cols' | 'state'

  const [pending, setPending] = useState<any>(null);
  const [reason, setReason] = useState(''); const [detail, setDetail] = useState(''); const [merr, setMerr] = useState('');

  const debounce = useRef<any>(null);
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(debounce.current);
  }, [q]);

  const load = useCallback(async (append = false, cursor?: string) => {
    setLoading(true); setError(null);
    try {
      const r = await api.students({ q: debouncedQ || undefined, status: status || undefined, band: band || undefined, sort, dir, cursor, limit: 50 });
      setMatched(r.matched); setNextCursor(r.next_cursor);
      setItems(prev => append ? [...prev, ...r.items] : r.items);
    } catch (e) { setError(e); } finally { setLoading(false); }
  }, [debouncedQ, status, band, sort, dir]);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => { api.studentStats().then(setStats).catch(() => {}); }, []);

  const toggleCol = (k: string) => {
    setCols(prev => {
      const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k);
      try { localStorage.setItem('ccat_admin_studcols', JSON.stringify([...n])); } catch { /* ignore */ }
      return n;
    });
  };

  const exportCsv = () => {
    const head = ['Username', 'Name', 'Grade', 'Status', 'Readiness %', 'XP', 'Coins', 'Sets', 'Parent email', 'Parent phone', 'Devices'];
    const lines = items.map(r => [r.username, r.display_name, r.grade_number, r.display_status, r.readiness_pct ?? '', r.xp_total, r.coins, r.sets_completed ?? '', r.guardian_email ?? '', r.guardian_phone ?? '', `${r.device_active}/${r.device_total}`]
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `ccat-students-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
    toast(`Exported ${items.length} rows`);
  };

  // status actions (preserved)
  const act = (r: any, to: string, label: string) => { setPending({ id: r.id, version: r.version, to, label, name: r.display_name }); setReason(''); setDetail(''); setMerr(''); };
  const confirm = async () => {
    if (!reason.trim()) { setMerr('Reason code required'); return; }
    try { await api.studentStatus(pending.id, pending.version, pending.to, reason.trim(), detail.trim() || undefined); setPending(null); toast(`Status changed to ${pending.to}`); load(false); }
    catch (e) { if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { setMerr('Changed by someone else — refreshing.'); load(false); } else setMerr((e as Error).message); }
  };

  const chip = (key: string | null, label: string, count?: number) => (
    <button className={`chipbtn ${status === key ? 'on' : ''}`} onClick={() => setStatus(key)}>
      {label}{count !== undefined && <span className="c tabnum">{count.toLocaleString()}</span>}
    </button>
  );

  const sortLabel = SORTS.find(s => s.key === sort)?.label ?? 'Last active';
  const stateLabel = band ? { ready: 'Ready', building: 'Building', needs_work: 'Needs work' }[band] : 'All readiness';

  return (
    <div onClick={() => menu && setMenu(null)}>
      <h2>Students</h2>
      <p className="lead">Every CCAT account currently using the app, with the detail you need before you touch it. Choose which columns you want to see.</p>

      {/* toolbar */}
      <div className="toolrow" onClick={e => e.stopPropagation()}>
        <button className="chipbtn" onClick={() => setMenu(menu === 'sort' ? null : 'sort')}>
          Sort · {sortLabel} {dir === 'asc' ? '↑' : '↓'}
          {menu === 'sort' && (
            <div className="popover" onClick={e => e.stopPropagation()}>
              <div className="ph">Sort by</div>
              {SORTS.map(s => <label key={s.key}><input type="radio" checked={sort === s.key} onChange={() => setSort(s.key)} />{s.label}</label>)}
              <div className="ph">Direction</div>
              <label><input type="radio" checked={dir === 'desc'} onChange={() => setDir('desc')} />Descending ↓</label>
              <label><input type="radio" checked={dir === 'asc'} onChange={() => setDir('asc')} />Ascending ↑</label>
            </div>
          )}
        </button>
        <button className="chipbtn" onClick={() => setMenu(menu === 'cols' ? null : 'cols')}>
          Columns · {cols.size + 1}
          {menu === 'cols' && (
            <div className="popover" onClick={e => e.stopPropagation()}>
              <div className="ph">Show columns</div>
              <label style={{ opacity: .5 }}><input type="checkbox" checked disabled />Student</label>
              {ALL_COLS.map(c => <label key={c.key}><input type="checkbox" checked={cols.has(c.key)} onChange={() => toggleCol(c.key)} />{c.label}</label>)}
            </div>
          )}
        </button>
        <button className="chipbtn" onClick={exportCsv}>Export CSV</button>
        <button className={`chipbtn ${band ? 'on' : ''}`} onClick={() => setMenu(menu === 'state' ? null : 'state')}>
          State: {stateLabel}
          {menu === 'state' && (
            <div className="popover" onClick={e => e.stopPropagation()}>
              <div className="ph">Readiness state</div>
              <label><input type="radio" checked={band === null} onChange={() => setBand(null)} />All readiness</label>
              <label><input type="radio" checked={band === 'ready'} onChange={() => setBand('ready')} />Ready</label>
              <label><input type="radio" checked={band === 'building'} onChange={() => setBand('building')} />Building</label>
              <label><input type="radio" checked={band === 'needs_work'} onChange={() => setBand('needs_work')} />Needs work</label>
            </div>
          )}
        </button>
      </div>

      {/* KPI cards */}
      <div className="kpirow">
        <div className="kpi"><div className="ico">👥</div><div><div className="n tabnum">{(stats?.total ?? 0).toLocaleString()}</div><div className="l">Accounts · Grades 3–6</div></div></div>
        <div className="kpi"><div className="ico">⚡</div><div><div className="n tabnum">{(stats?.practised_today ?? 0).toLocaleString()}</div><div className="l">Practised today</div></div></div>
        <div className="kpi"><div className="ico">⏸️</div><div><div className="n tabnum">{(stats?.suspended ?? 0).toLocaleString()}</div><div className="l">Suspended</div></div></div>
        <div className="kpi"><div className="ico">🗑️</div><div><div className="n tabnum">{(stats?.pending_deletion ?? 0).toLocaleString()}</div><div className="l">Deletion inside 30-day window</div></div></div>
      </div>

      {/* filter chips */}
      <div className="filterchips">
        <input className="searchbox" placeholder="Search username, name, email or phone…" value={q} onChange={e => setQ(e.target.value)} />
        {chip(null, 'All', stats?.total)}
        {chip('active', 'Active', stats?.active)}
        {chip('suspended', 'Suspended', stats?.suspended)}
        {chip('pending_deletion', 'Deletion', stats?.pending_deletion)}
        {chip('banned', 'Banned', stats?.banned)}
        <span className="spacerx" />
        <span className="muted" style={{ fontSize: 12.5 }}>Sorted by {sortLabel} {dir === 'asc' ? '↑' : '↓'}</span>
      </div>

      {error ? <ErrorBox e={error} /> : (
        <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="tablewrap"><table>
            <thead><tr>
              <th>Student</th>
              {cols.has('grade') && <th>Grade &amp; status</th>}
              {cols.has('readiness') && <th>Readiness</th>}
              {cols.has('progress') && <th>Progress</th>}
              {cols.has('email') && <th>Parent email</th>}
              {cols.has('phone') && <th>Parent phone</th>}
              {cols.has('devices') && <th>Devices</th>}
              <th></th>
            </tr></thead>
            <tbody>{items.map(r => (
              <tr key={r.id}>
                <td>
                  <div className="stud">
                    <span className="av">{avatarFor(r.id)}</span>
                    <span>
                      <span className="nm" onClick={() => nav(`/students/${r.id}`)}>{r.username}</span>
                      <div className="un">{r.display_name}</div>
                    </span>
                  </div>
                </td>
                {cols.has('grade') && <td><div className="gradestk"><div className="g">Grade {r.grade_number}</div><StatusChip s={r.display_status} /></div></td>}
                {cols.has('readiness') && <td><Readiness pct={r.readiness_pct} band={r.readiness_band} insufficient={r.readiness_insufficient} /></td>}
                {cols.has('progress') && <td><div className="progx"><span className="xp tabnum">{r.xp_total.toLocaleString()} XP</span><div className="sub tabnum">🪙 {r.coins}{r.streak_current > 0 ? ` · 🔥 ${r.streak_current}d` : ''} · {r.sets_completed ?? 0} sets</div></div></td>}
                {cols.has('email') && <td>{r.guardian_email || <span className="muted">—</span>}</td>}
                {cols.has('phone') && <td className="tabnum">{r.guardian_phone || <span className="muted">—</span>}</td>}
                {cols.has('devices') && <td>{r.device_total === 0 ? <span className="muted">None</span> : r.device_active < r.device_total ? `${r.device_active} of ${r.device_total} active` : `${r.device_total} device${r.device_total > 1 ? 's' : ''}`}</td>}
                <td><div className="rowactions">
                  {r.status === 'active' && can('student.suspend') && <button className="btn warn sm" onClick={() => act(r, 'suspended', 'Suspend')}>Suspend</button>}
                  {r.status === 'active' && can('student.ban') && <button className="btn danger sm" onClick={() => act(r, 'banned', 'Ban')}>Ban</button>}
                  {r.status === 'suspended' && can('student.unsuspend') && <button className="btn ghost sm" onClick={() => act(r, 'active', 'Unsuspend')}>Unsuspend</button>}
                  {r.status === 'banned' && can('student.unban') && <button className="btn ghost sm" onClick={() => act(r, 'active', 'Unban')}>Unban</button>}
                  <button className="btn ghost sm" onClick={() => nav(`/students/${r.id}`)}>View</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
          {items.length === 0 && !loading && <div className="empty">No students match that — try a different search or clear the filters.</div>}
          {loading && items.length === 0 && <div className="empty">Loading…</div>}
          {nextCursor && (
            <div className="loadmore">
              <button className="btn ghost" disabled={loading} onClick={() => load(true, nextCursor)}>
                {loading ? 'Loading…' : `Show more — ${items.length} of ${matched.toLocaleString()}`}
              </button>
            </div>
          )}
          {!nextCursor && items.length > 0 && <div className="empty" style={{ fontSize: 12.5 }}>Showing all {matched.toLocaleString()} matching students</div>}
        </div>
      )}

      {pending && (
        <Modal title={`${pending.label} — ${pending.name}`} onClose={() => setPending(null)}
          footer={<><button className="btn ghost grow" onClick={() => setPending(null)}>Cancel</button><button className="btn grow" onClick={confirm}>Confirm</button></>}>
          <label>Reason code</label><input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. abuse, support_hold" />
          <label>Details (optional)</label><input value={detail} onChange={e => setDetail(e.target.value)} />
          <div className="err">{merr}</div>
        </Modal>
      )}
    </div>
  );
}
