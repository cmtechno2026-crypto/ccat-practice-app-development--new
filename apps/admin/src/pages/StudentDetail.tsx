import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync, Panel, StatusPill, Stat, Modal, Loading, ErrorBox, useToast } from '../components/ui';
import { PAYMENTS_ENABLED } from '../lib/payments';

export function StudentDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, me } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => api.studentDetail(id!), [id]);
  const [adjust, setAdjust] = useState(false);
  const [form, setForm] = useState({ kind: 'coins', delta: '10', reason: '', reference: '' });
  const [err, setErr] = useState('');
  const [bg, setBg] = useState(false);
  const [del, setDel] = useState(false);
  const [delRef, setDelRef] = useState('');
  const [delErr, setDelErr] = useState('');
  const [purge, setPurge] = useState(false);
  const [purgeRef, setPurgeRef] = useState('');
  const [purgeErr, setPurgeErr] = useState('');
  const [purging, setPurging] = useState(false);

  if (loading) return <Loading />;
  if (error) return <ErrorBox e={error} />;
  const d = data!;
  const isSuper = me?.role === 'super_admin';

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
  // Purge (§7.2 override): anonymize + tombstone. Irreversible; append-only ledgers/audit are kept.
  const doPurge = async () => {
    setPurgeErr(''); setPurging(true);
    try { await api.purgeStudent(id!, purgeRef.trim() || undefined); setPurge(false); toast('Account purged — PII erased; audit history retained.'); reload(); }
    catch (e) { setPurgeErr((e as Error).message); } finally { setPurging(false); }
  };

  const revoke = async () => { if (!confirm('Revoke this device and end the student\'s sessions?')) return; try { await api.revokeDevice(id!, 'admin console'); toast('Device revoked'); reload(); } catch (e) { toast((e as Error).message); } };
  const approveBg = async (reqId: string) => { try { await api.approveBreakGlass(id!, reqId); toast('Device enrolled — audited'); reload(); } catch (e) { toast((e as Error).message); } };
  const denyBg = async (reqId: string) => { try { await api.denyBreakGlass(id!, reqId); toast('Request denied'); reload(); } catch (e) { toast((e as Error).message); } };
  const doAdjust = async () => {
    if (!form.reason.trim() || !form.reference.trim()) { setErr('Reason and reference required'); return; }
    try { await api.rewardAdjust(id!, form.kind, Number(form.delta), form.reason.trim(), form.reference.trim()); setAdjust(false); toast('Reward adjusted'); reload(); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <>
      <div className="toolbar"><h2>{d.display_name} <span className="muted" style={{ fontSize: 15 }}>@{d.username}</span></h2>
        <div className="rowactions">
          {can('deletion.support') && <button className="btn ghost sm" onClick={exportDsar}>⬇ Export data (DSAR)</button>}
          {can('deletion.support') && d.status !== 'pending_deletion' && <button className="btn danger sm" onClick={() => { setDelRef(''); setDelErr(''); setDel(true); }}>Request deletion</button>}
          <button className="btn ghost sm" onClick={() => nav('/students')}>← Directory</button>
        </div></div>
      {d.status === 'pending_deletion' && <div className="aihint" style={{ background: 'var(--tint, #FDECE6)', color: '#C2321C', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ flex: 1 }}>🗑️ Deletion requested — the account is in the 30-day restore window before permanent purge.</span>
        {can('student.deletion.override') && <button className="btn danger sm" onClick={() => { setPurgeRef(''); setPurgeErr(''); setPurge(true); }}>Purge now (permanent)</button>}
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

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Panel title="Guardians">
          {d.guardians.length === 0 ? <div className="muted">None on file.</div> : d.guardians.map((g: any, i: number) => (
            <div key={i} className="kvs" style={{ marginBottom: 8 }}>
              <span className="k">Email</span><span>{g.email || '—'} {g.email_verified_at && <span className="tag">verified</span>}</span>
              <span className="k">Phone</span><span>{g.phone || '—'} {g.phone_verified_at && <span className="tag">verified</span>}</span>
              <span className="k">Relationship</span><span>{g.relationship || '—'}{g.is_primary ? ' · primary' : ''}</span>
            </div>
          ))}
        </Panel>
        <Panel title="Devices" right={<div className="rowactions">
          {can('device.break_glass') && <button className="btn gold sm" onClick={() => setBg(true)} title="Enroll a device out-of-band when guardian channels are unreachable">🔑 {isSuper ? 'Break-glass enroll' : 'Request break-glass'}</button>}
          {can('device.revoke') && d.devices.some((x: any) => x.status === 'active') ? <button className="btn danger sm" onClick={revoke}>Revoke active device</button> : null}
        </div>}>
          {d.devices.length === 0 ? <div className="muted">No devices.</div> : (
            <div className="tablewrap"><table><thead><tr><th>Platform</th><th>Status</th><th>Enrolled</th></tr></thead>
              <tbody>{d.devices.map((v: any) => (<tr key={v.id}><td>{v.platform || 'device'}</td><td><StatusPill status={v.status} /></td>
                <td className="muted">{v.enrolled_at ? new Date(v.enrolled_at).toLocaleDateString() : '—'}</td></tr>))}</tbody></table></div>
          )}
          {(d.break_glass_requests?.length ?? 0) > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>Pending break-glass co-sign</div>
              {d.break_glass_requests.map((r: any) => (
                <div className="minirow" key={r.id} style={{ background: 'var(--tint, #FFF3DB)' }}>
                  <div className="grow"><div style={{ fontSize: 13 }}>{r.platform || 'device'} · <span style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}>{String(r.device_hash).slice(0, 10)}…</span></div>
                    <div className="muted" style={{ fontSize: 12 }}>by {r.requested_by} · {r.verification_note}</div></div>
                  {isSuper ? <><button className="btn sm" onClick={() => approveBg(r.id)}>Approve &amp; enroll</button><button className="btn ghost sm" onClick={() => denyBg(r.id)}>Deny</button></>
                    : <span className="tag">awaits Super-Admin</span>}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Rewards" right={can('reward.adjust') ? <button className="btn sm" onClick={() => { setForm({ kind: 'coins', delta: '10', reason: '', reference: '' }); setErr(''); setAdjust(true); }}>Adjust reward</button> : undefined}>
        <div className="muted">XP {d.xp_total} · Coins {d.coins}. Adjustments create compensating ledger entries (§19.3), never overwrites.</div>
      </Panel>

      {PAYMENTS_ENABLED && <MembershipSection studentId={id!} canEdit={can('config.global')} />}

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Panel title="Recent sessions">
          {d.recent_sessions.length === 0 ? <div className="muted">None yet.</div> : (
            <div className="tablewrap"><table><thead><tr><th>Mode</th><th>State</th><th>Score</th><th>XP</th></tr></thead>
              <tbody>{d.recent_sessions.map((s: any) => (<tr key={s.id}><td>{s.mode}</td><td><StatusPill status={s.state} /></td>
                <td className="tabnum">{s.score_total != null ? `${s.score_correct}/${s.score_total}` : '—'}</td><td className="tabnum">{s.xp_awarded ?? '—'}</td></tr>))}</tbody></table></div>
          )}
        </Panel>
        <Panel title="Status history">
          {d.status_history.length === 0 ? <div className="muted">No changes.</div> : (
            <div className="tablewrap"><table><thead><tr><th>Change</th><th>Reason</th><th>By</th></tr></thead>
              <tbody>{d.status_history.map((h: any, i: number) => (<tr key={i}><td>{h.from_status}→{h.to_status}</td><td className="muted">{h.reason_code}</td><td>{h.actor || 'system'}</td></tr>))}</tbody></table></div>
          )}
        </Panel>
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
      {bg && <BreakGlassModal studentName={d.display_name} isSuper={isSuper} onClose={() => setBg(false)}
        onDone={(msg) => { setBg(false); toast(msg); reload(); }}
        submit={(body) => api.breakGlass(id!, body)} />}
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

function BreakGlassModal({ studentName, isSuper, onClose, onDone, submit }: { studentName: string; isSuper: boolean; onClose: () => void; onDone: (msg: string) => void; submit: (b: { platform?: string; device_hash: string; verification_note: string; reference?: string }) => Promise<any> }) {
  const [platform, setPlatform] = useState('ios');
  const [deviceHash, setDeviceHash] = useState('');
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [c1, setC1] = useState(false); const [c2, setC2] = useState(false); const [c3, setC3] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ready = c1 && c2 && c3 && deviceHash.trim().length >= 6 && note.trim().length >= 10;
  const run = async () => {
    if (!ready) { setErr('Complete the checklist, and give a device id and a verification note (≥10 chars).'); return; }
    setBusy(true); setErr('');
    try {
      const r = await submit({ platform, device_hash: deviceHash.trim(), verification_note: note.trim(), reference: reference.trim() || undefined });
      onDone(r?.enrolled ? 'Device enrolled out of band — audited.' : 'Sent to a Super-Admin for co-sign.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal wide title="🔑 Break-glass device enrollment" onClose={onClose}
      footer={<><button className="btn ghost grow" onClick={onClose}>Cancel</button>
        <button className={`btn grow ${isSuper ? '' : 'gold'}`} disabled={busy || !ready} onClick={run}>{isSuper ? 'Enroll device' : 'Request co-sign'}</button></>}>
      <div className="aihint" style={{ background: 'var(--tint, #FFF3DB)' }}>This bypasses guardian OTP. Use it only after verifying the guardian another way — it is the one path that can put a child account on a new device without the registered channels. {isSuper ? 'You are signing as Super-Admin.' : 'This sends to a Super-Admin for co-sign; nothing is enrolled until they approve.'}</div>
      <div className="editor"><div className="grid2">
        <div><label>Platform</label><select value={platform} onChange={e => setPlatform(e.target.value)}><option value="ios">iOS</option><option value="android">Android</option></select></div>
        <div><label>New device id / hash</label><input value={deviceHash} onChange={e => setDeviceHash(e.target.value)} placeholder="e.g. 4b71…c208" /></div>
      </div>
      <label>How was the guardian's identity verified? (required, audited)</label>
      <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Spoke to guardian on file number, confirmed DOB and last session." />
      <label>Ticket / case reference (optional)</label>
      <input value={reference} onChange={e => setReference(e.target.value)} />
      </div>
      <label className="pickrow"><input type="checkbox" checked={c1} onChange={e => setC1(e.target.checked)} /><span>I spoke to the guardian and verified their identity out of band.</span></label>
      <label className="pickrow"><input type="checkbox" checked={c2} onChange={e => setC2(e.target.checked)} /><span>I have recorded how identity was verified in the ticket.</span></label>
      <label className="pickrow"><input type="checkbox" checked={c3} onChange={e => setC3(e.target.checked)} /><span>I understand this enrollment is audited and reviewed.</span></label>
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

// Payments — per-student Membership. Shows the guardian's EFFECTIVE tier + source + expiry and lets a
// Super-Admin set it with the same tier + reason + period controls as the Membership page, scoped by the
// student id (no email field). Rendered only when VITE_PAYMENTS_ENABLED (see caller).
const M_TIERS: { value: string; label: string }[] = [
  { value: 'free', label: 'free — demo sets only' },
  { value: 't50', label: 't50 ($50) — all practice' },
  { value: 't250', label: 't250 ($250) — practice + Exam + Combine' },
  { value: 't500', label: 't500 ($500) — everything incl. Weekly' },
];
const M_REASONS: { value: string; label: string }[] = [
  { value: 'comp', label: 'Comp (free access)' },
  { value: 'sale', label: 'Sale' },
  { value: 'discount', label: 'Discount' },
  { value: 'trial', label: 'Trial' },
  { value: 'other', label: 'Other' },
];
function mLocalInput(iso: string): string {
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function MembershipSection({ studentId, canEdit }: { studentId: string; canEdit: boolean }) {
  const toast = useToast();
  const [data, setData] = useState<any | null>(null);
  const [tier, setTier] = useState('free');
  const [reason, setReason] = useState('comp');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  const load = async () => {
    setLoadErr('');
    try {
      const r = await api.getStudentMembership(studentId);
      setData(r);
      const it = r.item;
      setTier(it && ['free', 't50', 't250', 't500'].includes(it.tier) ? it.tier : 'free');
      setReason(it && M_REASONS.some((x) => x.value === it.grant_reason) ? it.grant_reason : 'comp');
      setUntil(it?.current_period_end ? mLocalInput(it.current_period_end) : '');
    } catch (e) { setLoadErr((e as Error).message); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [studentId]);

  const save = async () => {
    setBusy(true);
    try {
      await api.setStudentMembership(studentId, { tier: tier as any, grant_reason: reason, until: until ? new Date(until).toISOString() : null });
      toast('Membership updated');
      await load();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };

  const eff = data?.effective;
  return (
    <Panel title="Membership">
      {loadErr && <div className="err" style={{ marginBottom: 8 }}>{loadErr}</div>}
      {!data ? <div className="muted">Loading…</div> : !data.guardian_email ? (
        <div className="muted">No guardian email on file — a membership can't be set for this student until a guardian email exists.</div>
      ) : (
        <div className="stack" style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            Effective plan: <strong>{eff?.tier}</strong> · source {eff?.source}
            {eff?.current_period_end ? ` · expires ${new Date(eff.current_period_end).toLocaleString()}` : ' · no expiry'}
            {eff?.promo_active ? ` · promo active (default ${eff.default_tier})` : ''}
            <br />Guardian: {data.guardian_email}
            {data.item?.grant_reason === 'paid' && <> · <span className="tag">paid (Stripe)</span></>}
          </div>
          {data.item?.grant_reason === 'paid' && (
            <div className="muted" style={{ fontSize: 12.5, color: 'var(--amber, #a15c00)' }}>
              ⚠ This is a paid (Stripe) entitlement. Saving here overrides it with a non-paid grant — do this only to correct a mistake.
            </div>
          )}
          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Tier</div>
            <select className="input" value={tier} disabled={!canEdit} onChange={(e) => setTier(e.target.value)}>
              {M_TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Reason</div>
            <select className="input" value={reason} disabled={!canEdit} onChange={(e) => setReason(e.target.value)}>
              {M_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Until (optional — blank = no expiry)</div>
            <input className="input" type="datetime-local" value={until} disabled={!canEdit} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={save} disabled={!canEdit || busy}>{busy ? 'Saving…' : 'Save membership'}</button>
          </div>
          {!canEdit && <div className="muted" style={{ fontSize: 12 }}>Read-only — needs Super-Admin.</div>}
        </div>
      )}
    </Panel>
  );
}
