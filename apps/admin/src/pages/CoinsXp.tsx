import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorBox, useToast } from '../components/ui';

const DIFFS = ['easy', 'medium', 'hard'];
const MILES = ['3', '7', '14', '30'];

export function CoinsXp() {
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = can('config.global');
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [xp, setXp] = useState<Record<string, string>>({});
  const [mil, setMil] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const r = await api.economy();
      setD(r);
      setXp(Object.fromEntries(DIFFS.map(k => [k, String(r.config.base_xp[k] ?? '')])));
      setMil(Object.fromEntries(MILES.map(k => [k, String(r.config.streak_milestones[k] ?? '')])));
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const publish = async () => {
    setBusy(true);
    try {
      await api.publishEconomy({
        base_xp: Object.fromEntries(DIFFS.map(k => [k, Number(xp[k])])),
        streak_milestones: Object.fromEntries(MILES.map(k => [k, Number(mil[k])])),
      });
      toast('Published new economy version'); load();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const recompute = async () => {
    setBusy(true);
    try { const r = await api.recomputeEconomy(); toast(`Recomputed — ${r.xp} XP + ${r.coin} coin caches fixed`); load(); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };

  if (error) return <><h2>Coins &amp; XP</h2><ErrorBox e={error} /></>;
  if (!d) return <><h2>Coins &amp; XP</h2><div className="empty">Loading…</div></>;
  const ig = d.integrity;
  const dirty = DIFFS.some(k => String(d.config.base_xp[k]) !== xp[k]) || MILES.some(k => String(d.config.streak_milestones[k]) !== mil[k]);

  return (
    <div>
      <h2 style={{ fontSize: 22 }}>Coins &amp; XP</h2>
      <p className="lead">Tune the reward economy and check its integrity against the authoritative ledgers. Config is versioned — publishing supersedes the previous version, never overwrites it.</p>

      {/* integrity */}
      <div className="kpirow">
        <div className="kpi"><div className="ico" style={{ background: ig.healthy ? 'var(--green-bg)' : 'var(--coral-bg)' }}>{ig.healthy ? '✅' : '⚠️'}</div><div><div className="n tabnum">{ig.healthy ? 'In balance' : `${ig.xp_mismatch_count + ig.coin_mismatch_count} off`}</div><div className="l">Economy integrity</div></div></div>
        <div className="kpi"><div className="ico">⭐</div><div><div className="n tabnum">{ig.xp_ledger_total.toLocaleString()}</div><div className="l">XP in ledger · {ig.xp_mismatch_count} cache mismatch</div></div></div>
        <div className="kpi"><div className="ico">🪙</div><div><div className="n tabnum">{ig.coin_ledger_total.toLocaleString()}</div><div className="l">Coins in ledger · {ig.coin_mismatch_count} cache mismatch</div></div></div>
        <div className="kpi"><div className="ico">🔥</div><div><div className="n tabnum">{ig.streak_bonuses.toLocaleString()}</div><div className="l">Streak bonuses · {ig.admin_adjustments} adjustments</div></div></div>
      </div>

      {(!ig.healthy) && (
        <div className="panel">
          <div className="panelhead"><h3>Cache mismatches</h3>{canEdit && <button className="btn warn sm" disabled={busy} onClick={recompute}>Recompute caches from ledger</button>}</div>
          <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>Cached balances that disagree with the append-only ledger (the ledger is authoritative). Recompute rebuilds the caches; it never touches the ledger.</p>
          <div className="tablewrap"><table>
            <thead><tr><th>Student</th><th>Kind</th><th className="right">Cached</th><th className="right">Ledger</th><th className="right">Δ</th></tr></thead>
            <tbody>
              {ig.xp_samples.map((r: any) => (<tr key={'x' + r.id}><td>{r.username}</td><td>XP</td><td className="right tabnum">{r.cached}</td><td className="right tabnum">{r.ledger}</td><td className="right tabnum" style={{ color: 'var(--coral)' }}>{r.cached - r.ledger}</td></tr>))}
              {ig.coin_samples.map((r: any) => (<tr key={'c' + r.id}><td>{r.username}</td><td>Coins</td><td className="right tabnum">{r.cached}</td><td className="right tabnum">{r.ledger}</td><td className="right tabnum" style={{ color: 'var(--coral)' }}>{r.cached - r.ledger}</td></tr>))}
            </tbody>
          </table></div>
        </div>
      )}

      {/* config editor */}
      <div className="panel">
        <div className="panelhead"><h3>Economy config</h3><span className="muted" style={{ fontSize: 12.5 }}>{d.config_meta ? `v: ${d.config_meta.version_label}` : 'defaults (no version published)'}</span></div>
        <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>XP awarded per correct answer by difficulty, and coin bonuses at streak milestones. {canEdit ? 'Publishing takes effect on the next scored session.' : 'Read-only — requires config permission.'}</p>

        <label style={{ marginTop: 6 }}>XP per correct answer</label>
        <div className="row">
          {DIFFS.map(k => (
            <div className="grow" key={k}>
              <label style={{ textTransform: 'capitalize' }}>{k}</label>
              <input type="number" min={0} value={xp[k] ?? ''} disabled={!canEdit} onChange={e => setXp({ ...xp, [k]: e.target.value })} />
            </div>
          ))}
        </div>

        <label style={{ marginTop: 14 }}>Streak milestone coins (days → coins)</label>
        <div className="row">
          {MILES.map(k => (
            <div className="grow" key={k}>
              <label>{k}-day</label>
              <input type="number" min={0} value={mil[k] ?? ''} disabled={!canEdit} onChange={e => setMil({ ...mil, [k]: e.target.value })} />
            </div>
          ))}
        </div>

        {canEdit && (
          <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
            <button className="btn" disabled={busy || !dirty} onClick={publish}>{busy ? 'Publishing…' : 'Publish new version'}</button>
            {dirty && <button className="btn ghost" onClick={() => { setXp(Object.fromEntries(DIFFS.map(k => [k, String(d.config.base_xp[k])]))); setMil(Object.fromEntries(MILES.map(k => [k, String(d.config.streak_milestones[k])]))); }}>Reset</button>}
          </div>
        )}
      </div>
    </div>
  );
}
