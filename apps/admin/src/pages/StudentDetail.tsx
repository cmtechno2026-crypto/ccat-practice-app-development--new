import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync, StatusPill, Stat, Modal, Loading, ErrorBox, useToast } from '../components/ui';

// Expiry is entered as a date meaning 12:00 am IST on that day (mirrors the Membership page). These
// live at module scope so both the fetch (prefill) and the save can use them safely.
const istMidnightIso = (date: string): string | null => { if (!date) return null; const t = new Date(`${date}T00:00:00+05:30`); return isNaN(t.getTime()) ? null : t.toISOString(); };
const toDateInputIST = (iso?: string | null): string => { if (!iso) return ''; const t = new Date(iso); if (isNaN(t.getTime())) return ''; const x = new Date(t.getTime() + 5.5 * 3600 * 1000); const p = (n: number) => String(n).padStart(2, '0'); return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}`; };

export function StudentDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api.studentDetail(id!), [id]);
  const [adjust, setAdjust] = useState(false);
  const [form, setForm] = useState({ kind: 'coins', delta: '10', reason: '', reference: '' });
  const [err, setErr] = useState('');
  const [pinReset, setPinReset] = useState(false);
  const [del, setDel] = useState(false);
  const [delRef, setDelRef] = useState('');
  const [delErr, setDelErr] = useState('');
  const [purge, setPurge] = useState(false);
  const [purgeRef, setPurgeRef] = useState('');
  const [purgeErr, setPurgeErr] = useState('');
  const [purging, setPurging] = useState(false);
  const [edit, setEdit] = useState(false);
  const [editForm, setEditForm] = useState({ display_name: '', grade_id: '' });
  const [editErr, setEditErr] = useState('');
  const [grades, setGrades] = useState<{ id: string; grade_number: number; name: string }[]>([]);
  // Redesigned lower panels: fixed tiles, exactly one expanded at a time (keeps a gap-free 4×2 block).
  const [openPanel, setOpenPanel] = useState<'sessions' | 'guardians' | 'devices' | 'rewards' | 'history'>('sessions');
  // Membership (per-student; guardian tier resolved server-side). Same model as the Membership page.
  const [membership, setMembership] = useState<any>(null);
  const [planForm, setPlanForm] = useState<{ tier: string; reason: string; until: string }>({ tier: 't50', reason: 'comp', until: '' });
  const loadMembership = () => api.getStudentMembership(id!).then((r: any) => {
    setMembership(r);
    // Prefill the inline controls to reflect the current grant.
    const t = r?.effective?.tier || 'free';
    const allowed: string[] = r?.allowed_tiers?.length ? r.allowed_tiers : ['free', 't50', 't250', 't500'];
    const reasons: string[] = r?.grant_reasons?.length ? r.grant_reasons : ['comp', 'paid', 'sale', 'discount', 'trial', 'other'];
    setPlanForm({
      tier: allowed.includes(t) ? t : (allowed[0] || 'free'),
      reason: r?.item?.grant_reason && reasons.includes(r.item.grant_reason) ? r.item.grant_reason : 'comp',
      until: toDateInputIST(r?.effective?.current_period_end),
    });
  }).catch(() => { /* non-super or unavailable → free fallback */ });
  useEffect(() => { loadMembership(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox e={error} />;
  const d = data!;
  // Membership panel — reads whatever the detail payload carries (membership/entitlement); falls back
  // to the free plan when the payments feature isn't wired on this environment yet.
  const TIER_LABEL: Record<string, string> = { free: 'Free plan', t50: '$50 · Practice', t250: '$100 · +Exam', t500: '$200 · All access' };
  const TIER_FULL: Record<string, string> = {
    free: 'free — demo sets only',
    t50: '$50 (Standard) — all practice (Exam/Combine locked)',
    t250: '$100 (Plus) — practice + Exam + Combine (Weekly locked)',
    t500: '$200 (Premium) — everything incl. Weekly',
  };
  const REASON_LABEL: Record<string, string> = { comp: 'Comp (free access)', paid: 'Paid', sale: 'Sale', discount: 'Discount', trial: 'Trial', other: 'Other' };
  const eff = membership?.effective;
  const memItem = membership?.item;
  const effTier = eff?.tier || 'free';
  const planLabel = TIER_LABEL[effTier] || effTier;
  const memStatus = memItem?.status || (effTier === 'free' ? 'Free' : 'Active');
  const memRenews = eff?.current_period_end || null;
  const memSource = eff?.source || null;
  const allowedTiers: string[] = membership?.allowed_tiers?.length ? membership.allowed_tiers : ['free', 't50', 't250', 't500'];
  const grantReasons: string[] = membership?.grant_reasons?.length ? membership.grant_reasons : ['comp', 'paid', 'sale', 'discount', 'trial', 'other'];
  const savePlan = async () => {
    try { await api.setStudentMembership(id!, { tier: planForm.tier as any, grant_reason: planForm.reason, until: istMidnightIso(planForm.until) }); toast('Membership updated.'); loadMembership(); }
    catch (e) { toast((e as Error).message); }
  };

  const exportDsar = () => {
    try {
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `dsar_${d.username || d.id}.json`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast('DSAR export downloaded (data held by this console).');
    } catch (e) { toast((e as Error).message); }
  };
  const requestDeletion = async () => {
    setDelErr('');
    try { await api.requestDeletion(id!, delRef.trim() || undefined); setDel(false); toast('Deletion requested — 30-day restore window opened.'); reload(); }
    catch (e) { setDelErr((e as Error).message); }
  };
  // Cancel a pending deletion — restore the account to active (within the 30-day window).
  const cancelDeletion = async () => {
    try { await api.restoreStudent(id!); toast('Deletion cancelled — account restored to active.'); reload(); }
    catch (e) { toast((e as Error).message); }
  };
  // Purge (§7.2 override): anonymize + tombstone. Irreversible; append-only ledgers/audit are kept.
  const doPurge = async () => {
    setPurgeErr(''); setPurging(true);
    try { await api.purgeStudent(id!, purgeRef.trim() || undefined); setPurge(false); toast('Account purged — PII erased; audit history retained.'); reload(); }
    catch (e) { setPurgeErr((e as Error).message); } finally { setPurging(false); }
  };

  // Open the edit modal, prefilling from the current record and loading the grade catalog once.
  const openEdit = async () => {
    setEditErr('');
    setEditForm({ display_name: d.display_name, grade_id: '' });
    setEdit(true);
    try {
      const g = await api.grades();
      const items = (g.items || []).map((x: any) => ({ id: x.id, grade_number: x.grade_number, name: x.name }));
      setGrades(items);
      // Prefill grade_id from the student's current grade_number (detail carries the number, not the id).
      const cur = items.find((x) => x.grade_number === d.grade_number);
      setEditForm((f) => ({ ...f, grade_id: cur?.id ?? '' }));
    } catch (e) { setEditErr((e as Error).message); }
  };
  const saveEdit = async () => {
    setEditErr('');
    const name = editForm.display_name.trim();
    if (!name) { setEditErr('Name is required.'); return; }
    const patch: { display_name?: string; grade_id?: string } = {};
    if (name !== d.display_name) patch.display_name = name;
    const curGrade = grades.find((x) => x.grade_number === d.grade_number);
    if (editForm.grade_id && editForm.grade_id !== curGrade?.id) patch.grade_id = editForm.grade_id;
    if (patch.display_name === undefined && patch.grade_id === undefined) { setEdit(false); return; }
    try { await api.editStudent(id!, d.version, patch); setEdit(false); toast('Student updated — audited. Progress and history are unchanged.'); reload(); }
    catch (e) { setEditErr((e as Error).message); }
  };
  const approveGrade = async (reqId: string) => { try { await api.approveGradeRequest(id!, reqId); toast('Grade change approved — grade updated, history preserved.'); reload(); } catch (e) { toast((e as Error).message); } };
  const rejectGrade = async (reqId: string) => { try { await api.rejectGradeRequest(id!, reqId); toast('Grade change rejected — grade unchanged.'); reload(); } catch (e) { toast((e as Error).message); } };

  const doAdjust = async () => {
    if (!form.reason.trim() || !form.reference.trim()) { setErr('Reason and reference required'); return; }
    try { await api.rewardAdjust(id!, form.kind, Number(form.delta), form.reason.trim(), form.reference.trim()); setAdjust(false); toast('Reward adjusted'); reload(); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <>
      <div className="toolbar"><h2>{d.display_name} <span className="muted" style={{ fontSize: 15 }}>@{d.username}</span></h2>
        <div className="rowactions">
          {can('student.update') && <button className="btn sm" onClick={openEdit}>✎ Edit student</button>}
          {can('student.update') && <button className="btn sm" onClick={() => setPinReset(true)}>🔑 Reset PIN</button>}
          {can('deletion.support') && <button className="btn ghost sm" onClick={exportDsar}>⬇ Export data (DSAR)</button>}
          {can('deletion.support') && d.status !== 'pending_deletion' && <button className="btn danger sm" onClick={() => { setDelRef(''); setDelErr(''); setDel(true); }}>Request deletion</button>}
          <button className="btn ghost sm" onClick={() => nav('/students')}>← Directory</button>
        </div></div>
      {d.status === 'pending_deletion' && <div className="aihint" style={{ background: 'var(--tint, #FDECE6)', color: '#C2321C', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ flex: 1 }}>🗑️ Deletion requested — the account is in the 30-day restore window before permanent purge.</span>
        {can('deletion.support') && <button className="btn sm" onClick={cancelDeletion}>♻️ Cancel deletion</button>}
        {can('student.deletion.override') && <button className="btn danger sm" onClick={() => { setPurgeRef(''); setPurgeErr(''); setPurge(true); }}>Purge now (permanent)</button>}
      </div>}
      {d.grade_change_request && <div className="aihint" style={{ background: 'var(--tint, #E6F0FD)', color: '#1C4D8C', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ flex: 1 }}>🎓 Grade-change requested — Grade {d.grade_change_request.current_grade_number} → <b>Grade {d.grade_change_request.requested_grade_number}</b>{d.grade_change_request.reason ? ` · “${d.grade_change_request.reason}”` : ''}. Approving updates the grade and keeps all progress and history.</span>
        {can('student.update') && <>
          <button className="btn sm" onClick={() => approveGrade(d.grade_change_request.id)}>Approve</button>
          <button className="btn ghost sm" onClick={() => rejectGrade(d.grade_change_request.id)}>Reject</button>
        </>}
      </div>}
      <div className="stats">
        <Stat n={<StatusPill status={d.status} />} label="Status" />
        <Stat n={`Grade ${d.grade_number}`} label="Grade" />
        <Stat n={d.age_years} label="Age (computed)" />
        <Stat n={d.xp_total} label="XP" color="var(--green)" />
        <Stat n={d.coins} label="Coins" color="var(--purple)" />
        <Stat n={d.readiness?.insufficient_data ? '—' : (d.readiness?.readiness_pct ?? '—') + '%'} label="Readiness" />
        <Stat n={d.streak ? `🔥 ${d.streak.current}d` : '—'} label={`Streak · best ${d.streak?.longest ?? 0}d`} color="var(--amber)" />
      </div>

      <style>{`
        .sdbento{--sd-card:#fff;--sd-line:#e7e8f2;--sd-card2:#f7f7fb;display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:190px;gap:14px;grid-auto-flow:row dense;margin-top:16px}
        @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .sdbento{--sd-card:#1c1e2b;--sd-line:#2b2e40;--sd-card2:#181a25}}
        :root[data-theme="dark"] .sdbento{--sd-card:#1c1e2b;--sd-line:#2b2e40;--sd-card2:#181a25}
        .sdtile{background:var(--sd-card);border:1px solid var(--sd-line);border-radius:16px;box-shadow:0 1px 2px rgba(31,35,64,.05),0 8px 22px rgba(31,35,64,.06);padding:15px;display:flex;flex-direction:column;overflow:hidden}
        .sdtile.sdbig{grid-column:span 2;grid-row:span 2;box-shadow:0 6px 30px rgba(31,35,64,.13)}
        .sdhead{display:flex;align-items:center;gap:8px;margin-bottom:9px}
        .sdhead .sdic{width:27px;height:27px;border-radius:8px;display:grid;place-items:center;font-size:14px;flex:none;color:#fff}
        .sdhead h3{font-size:12.5px;font-weight:800;letter-spacing:.03em;flex:1;margin:0}
        .sdbody{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:7px}
        .sdfoot{margin-top:11px;display:flex;align-items:center;gap:8px}
        .sdexp{margin-left:auto;border:1px solid var(--sd-line);background:var(--sd-card2);color:var(--purple,#6d4dd6);font-weight:700;font-size:11.5px;padding:5px 11px;border-radius:999px;cursor:pointer}
        .sdexp[disabled]{cursor:default;opacity:.75}
        .sd-green .sdic{background:var(--green,#1f9d6b)} .sd-blue .sdic{background:#2f6fd0}
        .sd-amber .sdic{background:var(--amber,#c9820e)} .sd-purple .sdic{background:var(--purple,#6d4dd6)} .sd-coral .sdic{background:var(--coral,#e0533d)}
        .sdbignum{font-weight:800;font-size:26px;line-height:1}
        .sdmember{--m-card:#fff;--m-line:#e7e8f2;display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:15px 18px;border:1px solid var(--m-line);border-radius:16px;background:var(--m-card);box-shadow:0 1px 2px rgba(31,35,64,.05);margin-top:16px}
        @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .sdmember{--m-card:#1c1e2b;--m-line:#2b2e40}}
        :root[data-theme="dark"] .sdmember{--m-card:#1c1e2b;--m-line:#2b2e40}
        .sdmember .sdm-badge{width:42px;height:42px;border-radius:12px;background:var(--purple,#6d4dd6);color:#fff;display:grid;place-items:center;font-size:19px;flex:none}
        .sdmember .sdm-l{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted,#6b6f8a);font-weight:700}
        .sdmember .sdm-v{font-weight:800;font-size:16px}
        .sdmember .sdm-sub{font-size:12px;color:var(--muted,#6b6f8a);margin-top:3px}
        .sdmember .sdm-controls{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-left:auto}
        .sdmember .sdm-fld{display:flex;flex-direction:column;gap:3px}
        .sdmember .sdm-fld > span{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted,#6b6f8a)}
        .sdmember .sdm-controls .input{font-size:13px}
        .sdmember .sdm-controls select.input{min-width:150px}
        @media (max-width:900px){.sdbento{grid-template-columns:repeat(2,1fr)}.sdtile.sdbig{grid-column:span 2}}
        @media (max-width:560px){.sdbento{grid-template-columns:1fr;grid-auto-rows:auto}.sdtile,.sdtile.sdbig{grid-column:span 1;grid-row:auto}.sdbody{overflow:visible}}
      `}</style>
      <div className="sdmember">
        <span className="sdm-badge">⭐</span>
        <div>
          <div className="sdm-l">Membership</div>
          <div className="sdm-v">{planLabel}</div>
          <div className="sdm-sub">
            <span style={{ color: String(memStatus).toLowerCase() === 'active' ? 'var(--green)' : undefined, fontWeight: 700 }}>{memStatus}</span>
            {memSource ? ` · source ${memSource}` : ''} · {memRenews ? `expires ${new Date(memRenews).toLocaleDateString()}` : 'no expiry'}
          </div>
        </div>
        {can('config.global') ? (
          <div className="sdm-controls">
            <label className="sdm-fld"><span>Tier</span>
              <select className="input" value={planForm.tier} onChange={e => setPlanForm({ ...planForm, tier: e.target.value })}>
                {allowedTiers.map((t) => <option key={t} value={t}>{TIER_FULL[t] || t}</option>)}
              </select>
            </label>
            <label className="sdm-fld"><span>Reason</span>
              <select className="input" value={planForm.reason} onChange={e => setPlanForm({ ...planForm, reason: e.target.value })}>
                {grantReasons.map((r) => <option key={r} value={r}>{REASON_LABEL[r] || r}</option>)}
              </select>
            </label>
            <label className="sdm-fld"><span>Expiry</span>
              <input className="input" type="date" value={planForm.until} onChange={e => setPlanForm({ ...planForm, until: e.target.value })} />
            </label>
            <button className="btn" onClick={savePlan}>Save grant</button>
          </div>
        ) : (
          <div className="sdm-controls" style={{ alignItems: 'center', color: 'var(--muted)', fontSize: 12.5 }}>Membership is set by a Super-Admin.</div>
        )}
      </div>
      {can('config.global') && membership?.guardian_email && (
        <div className="muted" style={{ fontSize: 11.5, margin: '6px 2px 0' }}>Applies to the guardian ({membership.guardian_email}) — all children on that guardian. Expiry blank = no expiry (12:00 am IST). “Paid” records a real payment; the rest are non-paying access.</div>
      )}

      <div className="sdbento">
        {(() => {
          const ExpBtn = ({ k }: { k: typeof openPanel }) => (
            <button className="sdexp" disabled={openPanel === k} onClick={() => setOpenPanel(k)}>{openPanel === k ? '● Expanded' : '⤢ Expand'}</button>
          );
          const O = (k: typeof openPanel) => openPanel === k;
          const s0 = d.recent_sessions[0];
          const g0 = d.guardians[0];
          const h0 = d.status_history[0];
          const activeDev = d.devices.find((x: any) => x.status === 'active');
          return <>
            {/* Recent sessions */}
            <div className={`sdtile sd-blue ${O('sessions') ? 'sdbig' : ''}`}>
              <div className="sdhead"><span className="sdic">🎯</span><h3>RECENT SESSIONS</h3></div>
              <div className="sdbody">
                {d.recent_sessions.length === 0 ? <div className="muted">None yet.</div> : O('sessions') ? (
                  <div className="tablewrap"><table><thead><tr><th>Mode</th><th>State</th><th>Score</th><th>XP</th></tr></thead>
                    <tbody>{d.recent_sessions.map((s: any) => (<tr key={s.id}><td>{s.mode}</td><td><StatusPill status={s.state} /></td>
                      <td className="tabnum">{s.score_total != null ? `${s.score_correct}/${s.score_total}` : '—'}</td><td className="tabnum">{s.xp_awarded ?? '—'}</td></tr>))}</tbody></table></div>
                ) : (
                  <div><div style={{ fontSize: 13 }}>Last: {s0 ? `${s0.mode} · ${s0.score_total != null ? `${s0.score_correct}/${s0.score_total}` : '—'}` : 'None yet'}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>{d.recent_sessions.length} recent</div></div>
                )}
              </div>
              <div className="sdfoot"><ExpBtn k="sessions" /></div>
            </div>

            {/* Guardians */}
            <div className={`sdtile sd-amber ${O('guardians') ? 'sdbig' : ''}`}>
              <div className="sdhead"><span className="sdic">👪</span><h3>GUARDIANS</h3></div>
              <div className="sdbody">
                {d.guardians.length === 0 ? <div className="muted">None on file.</div> : O('guardians') ? (
                  d.guardians.map((g: any, i: number) => (
                    <div key={i} className="kvs" style={{ marginBottom: 8 }}>
                      <span className="k">Email</span><span>{g.email || '—'} {g.email_verified_at && <span className="tag">verified</span>}</span>
                      <span className="k">Phone</span><span>{g.phone || '—'} {g.phone_verified_at && <span className="tag">verified</span>}</span>
                      <span className="k">Relationship</span><span>{g.relationship || '—'}{g.is_primary ? ' · primary' : ''}</span>
                    </div>
                  ))
                ) : (
                  <div><div style={{ fontSize: 13 }}>{g0.email || g0.phone || '—'}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>{g0.relationship || 'guardian'}{g0.is_primary ? ' · primary' : ''}</div></div>
                )}
              </div>
              <div className="sdfoot"><ExpBtn k="guardians" /></div>
            </div>

            {/* Devices */}
            <div className={`sdtile sd-purple ${O('devices') ? 'sdbig' : ''}`}>
              <div className="sdhead"><span className="sdic">📱</span><h3>DEVICES</h3></div>
              <div className="sdbody">
                {O('devices') ? (<>
                  {d.devices.length === 0 ? <div className="muted">No devices.</div> : (
                    <div className="tablewrap"><table><thead><tr><th>Platform</th><th>Status</th><th>Enrolled</th></tr></thead>
                      <tbody>{d.devices.map((v: any) => (<tr key={v.id}><td>{v.platform || 'device'}</td><td><StatusPill status={v.status} /></td>
                        <td className="muted">{v.enrolled_at ? new Date(v.enrolled_at).toLocaleDateString() : '—'}</td></tr>))}</tbody></table></div>
                  )}
                </>) : (
                  <div><div style={{ fontSize: 13 }}>{activeDev ? `${activeDev.platform || 'device'} · active` : (d.devices.length ? `${d.devices.length} device(s)` : 'No devices')}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>{activeDev ? 'Active device enrolled' : 'No active device'}</div></div>
                )}
              </div>
              <div className="sdfoot"><ExpBtn k="devices" /></div>
            </div>

            {/* Rewards */}
            <div className={`sdtile sd-green ${O('rewards') ? 'sdbig' : ''}`}>
              <div className="sdhead"><span className="sdic">✦</span><h3>REWARDS</h3></div>
              <div className="sdbody">
                <div style={{ display: 'flex', gap: 18 }}>
                  <div><div className="sdbignum" style={{ color: 'var(--green)' }}>{d.xp_total}</div><div className="muted" style={{ fontSize: 11, letterSpacing: '.06em' }}>XP</div></div>
                  <div><div className="sdbignum" style={{ color: 'var(--purple)' }}>{d.coins}</div><div className="muted" style={{ fontSize: 11, letterSpacing: '.06em' }}>COINS</div></div>
                </div>
                {O('rewards') && (<>
                  <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>Adjustments create compensating ledger entries (§19.3), never overwrites.</div>
                  {can('reward.adjust') && <button className="btn sm" style={{ marginTop: 10, alignSelf: 'flex-start' }} onClick={() => { setForm({ kind: 'coins', delta: '10', reason: '', reference: '' }); setErr(''); setAdjust(true); }}>Adjust reward</button>}
                </>)}
              </div>
              <div className="sdfoot"><ExpBtn k="rewards" /></div>
            </div>

            {/* Status history */}
            <div className={`sdtile sd-coral ${O('history') ? 'sdbig' : ''}`}>
              <div className="sdhead"><span className="sdic">🧾</span><h3>STATUS HISTORY</h3></div>
              <div className="sdbody">
                {d.status_history.length === 0 ? <div className="muted">No changes.</div> : O('history') ? (
                  <div className="tablewrap"><table><thead><tr><th>Change</th><th>Reason</th><th>By</th></tr></thead>
                    <tbody>{d.status_history.map((h: any, i: number) => (<tr key={i}><td>{h.from_status}→{h.to_status}</td><td className="muted">{h.reason_code}</td><td>{h.actor || 'system'}</td></tr>))}</tbody></table></div>
                ) : (
                  <div><div style={{ fontSize: 13 }}>{h0.from_status}→{h0.to_status}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>{h0.reason_code}</div></div>
                )}
              </div>
              <div className="sdfoot"><ExpBtn k="history" /></div>
            </div>
          </>;
        })()}
      </div>

      {adjust && (
        <Modal title={`Adjust reward — ${d.display_name}`} onClose={() => setAdjust(false)}
          footer={<><button className="btn ghost grow" onClick={() => setAdjust(false)}>Cancel</button><button className="btn grow" onClick={doAdjust}>Apply</button></>}>
          <div className="row"><div className="grow"><label>Kind</label><select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}><option value="coins">Coins</option><option value="xp">XP</option></select></div>
            <div className="grow"><label>Delta (+/−)</label><input type="number" value={form.delta} onChange={e => setForm({ ...form, delta: e.target.value })} /></div></div>
          <label>Reason</label><input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
          <label>Reference (support/case)</label><input value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} />
          <div className="err">{err}</div>
        </Modal>
      )}
      {edit && (
        <Modal title={`Edit student — ${d.display_name}`} onClose={() => setEdit(false)}
          footer={<><button className="btn ghost grow" onClick={() => setEdit(false)}>Cancel</button><button className="btn grow" onClick={saveEdit}>Save changes</button></>}>
          <div className="aihint" style={{ background: 'var(--tint, #E6F0FD)', color: '#1C4D8C' }}>Editing the grade re-levels the student's catalog only — it never deletes sessions, results, achievements or streaks. Changes are audited.</div>
          <label>Display name</label>
          <input value={editForm.display_name} maxLength={40} onChange={e => setEditForm({ ...editForm, display_name: e.target.value })} />
          <label>Grade</label>
          <select value={editForm.grade_id} onChange={e => setEditForm({ ...editForm, grade_id: e.target.value })}>
            {grades.length === 0 && <option value="">Loading grades…</option>}
            {grades.map((g) => <option key={g.id} value={g.id}>{g.name || `Grade ${g.grade_number}`}</option>)}
          </select>
          {editErr && <div className="err" style={{ marginTop: 8 }}>{editErr}</div>}
        </Modal>
      )}
      {pinReset && <ResetPinModal studentName={d.display_name} onClose={() => setPinReset(false)}
        onDone={(msg) => { setPinReset(false); toast(msg); reload(); }}
        submit={(new_pin, reference) => api.resetPin(id!, new_pin, reference)} />}
      {del && (
        <Modal title={`Request account deletion — ${d.display_name}`} onClose={() => setDel(false)}
          footer={<><button className="btn ghost grow" onClick={() => setDel(false)}>Cancel</button><button className="btn danger grow" onClick={requestDeletion}>Request deletion</button></>}>
          <div className="aihint" style={{ background: 'var(--tint, #FDECE6)', color: '#C2321C' }}>This moves the account to <b>pending deletion</b> and opens a 30-day restore window before permanent purge. Guardian-authorized deletion is the default path; this admin-recorded request is audited.</div>
          <label>Ticket / case reference (optional)</label>
          <input value={delRef} onChange={e => setDelRef(e.target.value)} placeholder="e.g. CASE-1042" />
          {delErr && <div className="err" style={{ marginTop: 8 }}>{delErr}</div>}
        </Modal>
      )}
      {purge && (
        <Modal title={`Purge account — ${d.display_name}`} onClose={() => setPurge(false)}
          footer={<><button className="btn ghost grow" onClick={() => setPurge(false)}>Cancel</button><button className="btn danger grow" disabled={purging} onClick={doPurge}>{purging ? 'Purging…' : 'Purge permanently'}</button></>}>
          <div className="aihint" style={{ background: 'var(--tint, #FDECE6)', color: '#C2321C' }}><b>Irreversible.</b> This erases the student's personal data (name, login, guardian contacts, device credentials) and tombstones the account as <b>purged</b>. The append-only reward ledgers, consent records and audit history are retained under an anonymized ID for integrity — they contain no restorable PII.</div>
          <label>Legal / case reference (optional)</label>
          <input value={purgeRef} onChange={e => setPurgeRef(e.target.value)} placeholder="e.g. CASE-1042" />
          {purgeErr && <div className="err" style={{ marginTop: 8 }}>{purgeErr}</div>}
        </Modal>
      )}
    </>
  );
}

function ResetPinModal({ studentName, onClose, onDone, submit }: { studentName: string; onClose: () => void; onDone: (msg: string) => void; submit: (new_pin: string, reference?: string) => Promise<any> }) {
  const [pin, setPin] = useState('');
  const [show, setShow] = useState(false);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ready = /^\d{4}$/.test(pin);
  const gen = () => { setPin(String(Math.floor(1000 + Math.random() * 9000))); setShow(true); };
  const run = async () => {
    if (!ready) { setErr('Enter a 4-digit PIN, or tap Generate.'); return; }
    setBusy(true); setErr('');
    try { await submit(pin, reference.trim() || undefined); onDone(`PIN reset to ${pin} — the student must sign in again. Audited.`); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`🔑 Reset PIN — ${studentName}`} onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button>
        <button className="btn grow" disabled={busy || !ready} onClick={run}>{busy ? 'Resetting…' : 'Reset PIN'}</button></>}>
      <div className="aihint" style={{ background: 'var(--tint, #E6F0FD)', color: '#1C4D8C' }}>Sets a new 4-digit login PIN, clears any lockout, and signs the student out everywhere — they sign back in with the new PIN. Share it with the guardian securely. Guardians can also self-reset from the login screen.</div>
      <label>New 4-digit PIN</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type={show ? 'text' : 'password'} inputMode="numeric" maxLength={4} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="4-digit PIN" style={{ width: 130, letterSpacing: 4, fontFamily: 'ui-monospace,Menlo,monospace' }} />
        <button type="button" className="btn ghost sm" onClick={() => setShow(v => !v)}>{show ? '🙈 Hide' : '👁️ Show'}</button>
        <button type="button" className="btn sm" onClick={gen}>Generate</button>
      </div>
      <label style={{ marginTop: 10 }}>Ticket / case reference (optional)</label>
      <input value={reference} onChange={e => setReference(e.target.value)} placeholder="e.g. CASE-1042" />
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}
