import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync, Panel, Modal, Loading, ErrorBox, useToast } from '../components/ui';
import { GamTabs } from '../components/GamTabs';

export function Achievements() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api.achievements());
  const [avatars, setAvatars] = useState<any[] | null>(null);
  const [themes, setThemes] = useState<any[] | null>(null);
  useEffect(() => { api.avatars().then(r => setAvatars(r.items)).catch(() => {}); api.themes().then(r => setThemes(r.items)).catch(() => {}); }, []);
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState<{ version_id: string; name: string; xp: string; coins: string; repeatable: boolean } | null>(null);
  const [f, setF] = useState({ key: '', name: '', type: 'xp_total', threshold: '100', xp: '25', coins: '0', repeatable: false });
  const [err, setErr] = useState('');
  // Triggers that carry a numeric threshold. The others (first_completion, perfect_set) are event triggers.
  const THRESHOLD_TYPES = ['xp_total', 'questions_answered', 'streak_days', 'batteries_covered'];
  const submit = async () => {
    if (!f.key.trim() || !f.name.trim()) { setErr('Key and name required'); return; }
    const criteria = THRESHOLD_TYPES.includes(f.type) ? { type: f.type, threshold: Number(f.threshold) } : { type: f.type };
    try { await api.createAchievement({ key: f.key.trim(), name: f.name.trim(), criteria, xp: Number(f.xp) || undefined, coins: Number(f.coins) || undefined, repeatable: f.repeatable }); setCreate(false); toast('Achievement created'); reload(); }
    catch (e) { setErr((e as Error).message); }
  };
  const activeCount = (data?.items || []).filter((a: any) => a.active).length;
  const earnedTotal = (data?.items || []).reduce((s: number, a: any) => s + (a.earned_count || 0), 0);
  const avatarStages = (avatars || []).reduce((s: number, fam: any) => s + (fam.stages?.length || 0), 0);
  const themesLive = (themes || []).filter((t: any) => t.active).length;

  return (
    <>
      <GamTabs active="achievements" />
      <div className="toolbar">
        <div>
          <h2 style={{ fontSize: 22 }}>Gamification</h2>
          <p className="lead" style={{ marginBottom: 0 }}>Achievements, avatars and themes — what keeps a child coming back tomorrow.</p>
        </div>
        <div className="row" style={{ margin: 0, gap: 8 }}>
          {can('config.global') && <Link className="btn ghost sm" to="/gamification/economy">Coins &amp; XP config</Link>}
          {can('achievement.manage') && <button className="btn sm" onClick={() => { setF({ key: '', name: '', type: 'xp_total', threshold: '100', xp: '25', coins: '0', repeatable: false }); setErr(''); setCreate(true); }}>+ New achievement</button>}
        </div>
      </div>

      <div className="kpirow">
        <div className="kpi"><div className="ico" style={{ background: 'var(--amber-bg)' }}>🏆</div><div><div className="n tabnum">{activeCount}</div><div className="l">Active achievements</div></div></div>
        <div className="kpi"><div className="ico" style={{ background: 'var(--tint)' }}>🦊</div><div><div className="n tabnum">{avatars ? `${avatars.length}×7` : '—'}</div><div className="l">Avatar families × stages ({avatarStages})</div></div></div>
        <div className="kpi"><div className="ico" style={{ background: 'var(--lilac,#f0ebfa)' }}>🎨</div><div><div className="n tabnum">{themes ? themesLive : '—'}</div><div className="l">Themes published</div></div></div>
        <div className="kpi"><div className="ico" style={{ background: 'var(--green-bg)' }}>⭐</div><div><div className="n tabnum">{earnedTotal.toLocaleString()}</div><div className="l">Achievements earned (all-time)</div></div></div>
      </div>

      <Panel>
        {loading ? <Loading /> : error ? <ErrorBox e={error} /> : (
          <div className="tablewrap"><table>
            <thead><tr><th>Name</th><th>Key</th><th>Criteria</th><th>Rewards</th><th>Active</th><th className="right">Earned</th><th></th></tr></thead>
            <tbody>{data!.items.map((a: any) => (
              <tr key={a.version_id}><td style={{ fontWeight: 700 }}>{a.name}</td><td className="muted">{a.key}</td>
                <td>{a.criteria?.type}{a.criteria?.threshold ? ` ≥ ${a.criteria.threshold}` : ''}{a.repeatable ? <span className="tag" style={{ marginLeft: 6 }}>repeatable</span> : ''}</td>
                <td>{a.rewards.map((r: any) => r.kind === 'xp' ? `+${r.xp} XP` : r.kind === 'coins' ? `+${r.coins} coins` : r.kind).join(' · ') || '—'}</td>
                <td>{can('achievement.manage')
                  ? <button className={`toggle ${a.active ? 'on' : ''}`} onClick={async () => { try { await api.setAchievementActive(a.version_id, !a.active); toast(a.active ? 'Deactivated' : 'Activated'); reload(); } catch (e) { toast((e as Error).message); } }} aria-label="Toggle achievement" />
                  : (a.active ? <span className="tag">active</span> : <span className="muted">off</span>)}</td>
                <td className="right tabnum">{a.earned_count}</td>
                <td>{can('achievement.manage') && <button className="btn ghost sm" onClick={() => { const xp = a.rewards.find((r: any) => r.kind === 'xp')?.xp ?? 0; const coins = a.rewards.find((r: any) => r.kind === 'coins')?.coins ?? 0; setEdit({ version_id: a.version_id, name: a.name, xp: String(xp), coins: String(coins), repeatable: !!a.repeatable }); setErr(''); }}>Edit</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
      {create && (
        <Modal title="New achievement" onClose={() => setCreate(false)} footer={<><button className="btn ghost grow" onClick={() => setCreate(false)}>Cancel</button><button className="btn grow" onClick={submit}>Create</button></>}>
          <div className="row"><div className="grow"><label>Key</label><input value={f.key} onChange={e => setF({ ...f, key: e.target.value })} placeholder="e.g. streak_5" /></div>
            <div className="grow"><label>Name</label><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></div></div>
          <label>Criteria</label><select value={f.type} onChange={e => setF({ ...f, type: e.target.value })}>
            <option value="first_completion">First completion</option>
            <option value="perfect_set">Perfect set</option>
            <option value="xp_total">XP total</option>
            <option value="questions_answered">Questions answered</option>
            <option value="streak_days">Streak days</option>
            <option value="batteries_covered">Batteries covered</option>
          </select>
          {THRESHOLD_TYPES.includes(f.type) && <><label>Threshold</label><input type="number" value={f.threshold} onChange={e => setF({ ...f, threshold: e.target.value })} /></>}
          <div className="row"><div className="grow"><label>Reward XP</label><input type="number" value={f.xp} onChange={e => setF({ ...f, xp: e.target.value })} /></div>
            <div className="grow"><label>Reward coins</label><input type="number" value={f.coins} onChange={e => setF({ ...f, coins: e.target.value })} /></div></div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <input type="checkbox" checked={f.repeatable} onChange={e => setF({ ...f, repeatable: e.target.checked })} />
            Repeatable — earn again each qualifying session (for event triggers like Perfect set)
          </label>
          <div className="err">{err}</div>
        </Modal>
      )}
      {edit && (
        <Modal title={`Edit — ${edit.name}`} onClose={() => setEdit(null)}
          footer={<><button className="btn ghost grow" onClick={() => setEdit(null)}>Cancel</button>
            <button className="btn grow" onClick={async () => {
              if (!edit.name.trim()) { setErr('Name required'); return; }
              try { await api.editAchievement(edit.version_id, { name: edit.name.trim(), xp: Number(edit.xp) || 0, coins: Number(edit.coins) || 0, repeatable: edit.repeatable }); setEdit(null); toast('Achievement updated'); reload(); }
              catch (e) { setErr((e as Error).message); }
            }}>Save</button></>}>
          <label>Name</label><input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} />
          <div className="row"><div className="grow"><label>Reward XP</label><input type="number" min={0} value={edit.xp} onChange={e => setEdit({ ...edit, xp: e.target.value })} /></div>
            <div className="grow"><label>Reward coins</label><input type="number" min={0} value={edit.coins} onChange={e => setEdit({ ...edit, coins: e.target.value })} /></div></div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <input type="checkbox" checked={edit.repeatable} onChange={e => setEdit({ ...edit, repeatable: e.target.checked })} />
            Repeatable — earn again each qualifying session
          </label>
          <div className="err">{err}</div>
        </Modal>
      )}
    </>
  );
}
