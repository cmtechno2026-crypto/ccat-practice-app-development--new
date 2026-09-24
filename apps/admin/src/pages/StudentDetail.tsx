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
  const { can, me } = useAuth();
  // Teachers get read-only student detail with guardian CONTACT info withheld (no email / phone).
  const hideContact = !!me?.is_teacher;
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
  // Set-review modal (Battery Practice → click a Set): { id: question_set id, label }.
  const [reviewSet, setReviewSet] = useState<{ id: string; label: string } | null>(null);
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
  useEffect(() => { if (!hideContact) loadMembership(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox e={error} />;
  const d = data!;
  // Membership panel — reads whatever the detail payload carries (membership/entitlement); falls back
  // to the free plan when the payments feature isn't wired on this environment yet.
  const TIER_LABEL: Record<string, string> = { free: 'Free plan', t50: '$49 · Practice', t250: '$99 · +Exam', t500: '$199 · All access' };
  // Teachers see the plan by NAME only (no price, no billing source/expiry).
  const TIER_WORD: Record<string, string> = { free: 'Free', t50: 'Standard', t250: 'Plus', t500: 'Premium' };
  const TIER_FULL: Record<string, string> = {
    free: 'free — demo sets only',
    t50: '$49 (Standard) — all practice (Exam/Combine locked)',
    t250: '$99 (Plus) — practice + Exam + Combine (Weekly locked)',
    t500: '$199 (Premium) — everything incl. Weekly',
  };
  const REASON_LABEL: Record<string, string> = { comp: 'Comp (free access)', paid: 'Paid', sale: 'Sale', discount: 'Discount', trial: 'Trial', other: 'Other' };
  const eff = membership?.effective;
  const memItem = membership?.item;
  const effTier = (hideContact ? (data?.membership_tier as string | undefined) : eff?.tier) || 'free';
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
        <Stat n={d.progress_totals ? `${d.progress_totals.practiceSetsDone} / ${d.progress_totals.practiceSetsTotal}` : '—'} label="Practice sets done" color="var(--blue, #2f6fd0)" />
        <Stat n={d.progress_totals ? `${d.progress_totals.examPapersDone} / ${d.progress_totals.examPapersTotal}` : '—'} label="Exam sets done" color="var(--blue, #2f6fd0)" />
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
        .sdmember{--m-card:#fff;--m-line:#e7e8f2;display:flex;align-items:center;gap:16px;flex-wrap:nowrap;padding:14px 18px;border:1px solid var(--m-line);border-radius:16px;background:var(--m-card);box-shadow:0 1px 2px rgba(31,35,64,.05);margin-top:16px}
        @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .sdmember{--m-card:#1c1e2b;--m-line:#2b2e40}}
        :root[data-theme="dark"] .sdmember{--m-card:#1c1e2b;--m-line:#2b2e40}
        .sdmember .sdm-badge{width:42px;height:42px;border-radius:12px;background:var(--purple,#6d4dd6);color:#fff;display:grid;place-items:center;font-size:19px;flex:none}
        .sdmember .sdm-l{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted,#6b6f8a);font-weight:700}
        .sdmember .sdm-v{font-weight:800;font-size:16px}
        .sdmember .sdm-sub{font-size:12px;color:var(--muted,#6b6f8a);margin-top:3px}
        .sdmember .sdm-controls{display:flex;align-items:flex-end;gap:10px;flex-wrap:nowrap;margin-left:auto}
        .sdmember .sdm-info{min-width:0}
        .sdmember .sdm-fld{display:flex;flex-direction:column;gap:3px}
        .sdmember .sdm-fld > span{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted,#6b6f8a)}
        .sdmember .sdm-controls .input{font-size:13px}
        .sdmember .sdm-controls select.input{min-width:128px}
        @media (max-width:900px){.sdbento{grid-template-columns:repeat(2,1fr)}.sdtile.sdbig{grid-column:span 2}
          .sdmember{flex-wrap:wrap}.sdmember .sdm-controls{flex-wrap:wrap;margin-left:0}.sdmember .sdm-controls select.input{min-width:150px}}
        @media (max-width:560px){.sdbento{grid-template-columns:1fr;grid-auto-rows:auto}.sdtile,.sdtile.sdbig{grid-column:span 1;grid-row:auto}.sdbody{overflow:visible}}
      `}</style>
      <div className="sdmember">
        <span className="sdm-badge">⭐</span>
        <div className="sdm-info">
          <div className="sdm-l">Membership</div>
          <div className="sdm-v">{hideContact ? (TIER_WORD[effTier] || 'Free') : planLabel}</div>
          <div className="sdm-sub">
            <span style={{ color: String(memStatus).toLowerCase() === 'active' ? 'var(--green)' : undefined, fontWeight: 700 }}>{memStatus}</span>
            {!hideContact && (<>{memSource ? ` · source ${memSource}` : ''} · {memRenews ? `expires ${new Date(memRenews).toLocaleDateString()}` : 'no expiry'}</>)}
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
        <div className="muted" style={{ fontSize: 11.5, margin: '6px 2px 0' }}>Applies to the guardian ({membership.guardian_email}) — all children on that guardian. Expiry blank = 1 year from today for paid plans (12:00 am IST). “Paid” records a real payment; the rest are non-paying access.</div>
      )}

      <AssignmentPanel studentId={id!} onOpenSet={(sid, label) => setReviewSet({ id: sid, label })} />
      <AdminProgressSections studentId={id!} onOpenSet={(sid, label) => setReviewSet({ id: sid, label })} />
      {reviewSet && <SetReviewModal studentId={id!} setId={reviewSet.id} label={reviewSet.label} studentName={d.display_name} onClose={() => setReviewSet(null)} />}

      {/* Recent sessions / Guardians / Devices / Rewards / Status history cards removed per request. */}

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

// ---- Progress panels (Battery Practice + Exam Progress) — read-only, per-student ----------------------
// Best-effort plain-text from a rich prompt/option block array (admin review is text-level; images noted).
// Plain text from a rich block array. Blocks store text as { type:'text', value:'…' } (same as the
// student Progress page's blocksText) — images are separate { type:'image', url } blocks (see image_url).
function blockText(blocks: any): string {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : '';
  return blocks.filter((b: any) => b && b.type === 'text' && typeof b.value === 'string').map((b: any) => b.value).join(' ').trim();
}
const CAT_VIS: Record<string, { name: string; color: string }> = {
  verbal: { name: 'Verbal', color: '#2f6fd0' },
  quantitative: { name: 'Quantitative', color: '#1f9d6b' },
  non_verbal: { name: 'Non-verbal', color: '#6d4dd6' },
};
const catVis = (k: string) => CAT_VIS[k] || { name: k, color: '#2f6fd0' };
const fmtMMSS = (secs: number | null | undefined) => {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
};

function AdminProgressSections({ studentId, onOpenSet }: { studentId: string; onOpenSet: (setId: string, label: string) => void }) {
  const { data, loading, error } = useAsync(() => api.getStudentProgress(studentId), [studentId]);
  const batteries: any[] = data?.batteries ?? [];
  const [battery, setBattery] = useState<string>('');
  const activeKey = battery || batteries[0]?.key || '';
  const activeBattery = batteries.find((b: any) => b.key === activeKey);
  const [sub, setSub] = useState<string>('all');
  const setsAsync = useAsync(
    async () => (activeKey ? await api.getStudentProgressSets(studentId, activeKey, sub) : []),
    [studentId, activeKey, sub],
  );
  const sets: any[] = setsAsync.data ?? [];
  const subOptions: any[] = activeBattery?.subcategories ?? [];

  // Exam papers (finished attempts) for the Exam Progress panel.
  const examAsync = useAsync(() => api.getStudentExamHistory(studentId), [studentId]);
  const papers: any[] = examAsync.data ?? [];
  const [examBattery, setExamBattery] = useState<string>('verbal');
  const examPapers = papers.filter((p: any) => (p.battery_key ?? 'verbal') === examBattery);

  return (
    <>
      <style>{`
        .apx-h{font-size:16px;font-weight:800;color:var(--blue,#2f6fd0);margin:22px 0 10px}
        .apx-card{background:var(--sd-card,#fff);border:1px solid var(--sd-line,#e7e8f2);border-radius:16px;padding:16px 18px;margin-bottom:6px}
        @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .apx-card{background:#1c1e2b;border-color:#2b2e40}}
        :root[data-theme="dark"] .apx-card{background:#1c1e2b;border-color:#2b2e40}
        .apx-boxes{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
        .apx-box{border:1px solid var(--sd-line,#e7e8f2);border-radius:12px;padding:14px;background:var(--sky,#eef4fd);text-align:center;cursor:pointer;transition:border-color .1s,box-shadow .1s}
        .apx-box.on{border-color:var(--blue,#2f6fd0);box-shadow:inset 0 0 0 1px var(--blue,#2f6fd0)}
        .apx-box.static{cursor:default}
        .apx-box .fr{font-size:22px;font-weight:800;color:var(--blue,#2f6fd0)}
        .apx-box .fr small{font-size:12px;color:var(--muted,#6b6f8a);font-weight:600}
        .apx-box .lb{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted,#6b6f8a);margin-top:6px;font-weight:700}
        .apx-box .bar{height:5px;background:#d7e4f5;border-radius:3px;margin-top:9px;overflow:hidden}
        .apx-box .bar i{display:block;height:100%;background:var(--blue,#2f6fd0)}
        .apx-box .apx-acc{font-size:11.5px;font-weight:700;color:var(--muted,#6b6f8a);margin-top:7px}
        .apx-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 10px}
        .apx-tab{border:1px solid var(--sd-line,#e7e8f2);background:transparent;border-radius:999px;padding:6px 14px;font-size:12.5px;font-weight:700;color:var(--muted,#6b6f8a);cursor:pointer}
        .apx-tab.on{border-color:var(--blue,#2f6fd0);color:var(--blue,#2f6fd0)}
        .apx-setlink{color:var(--blue,#2f6fd0);font-weight:700;background:none;border:none;cursor:pointer;padding:0;font-size:13px}
        .apx-hint{font-size:11px;color:var(--muted,#6b6f8a);margin:2px 2px 0}
      `}</style>

      <div className="apx-h">Battery Practice</div>
      <div className="apx-card">
        {loading ? <Loading /> : error ? <ErrorBox e={error} /> : batteries.length === 0 ? (
          <div className="muted">No practice yet — nothing to show.</div>
        ) : (<>
          <div className="apx-boxes">
            {batteries.map((b: any) => {
              const total = b.setsTotal || 0; const done = b.setsDone || 0;
              const w = total > 0 ? Math.min(100, Math.round((100 * done) / total)) : 0;
              return (
                <button className={`apx-box ${activeKey === b.key ? 'on' : ''}`} key={b.key} onClick={() => { setBattery(b.key); setSub('all'); }} style={{ font: 'inherit' }}>
                  <div className="fr">{done} <small>/ {total}</small></div>
                  <div className="lb">{b.name}</div>
                  <div className="bar"><i style={{ width: `${w}%` }} /></div>
                  <div className="apx-acc">{b.accuracyPct != null ? `${b.accuracyPct}% accuracy` : 'No attempts yet'}</div>
                </button>
              );
            })}
          </div>
          <div className="apx-hint">Click a battery box to see its subcategories and sets below.</div>

          <div className="apx-tabs">
            <button className={`apx-tab ${sub === 'all' ? 'on' : ''}`} onClick={() => setSub('all')}>All subcategories</button>
            {subOptions.map((sc: any) => (
              <button key={sc.key} className={`apx-tab ${sub === sc.key ? 'on' : ''}`} onClick={() => setSub(sc.key)}>{sc.name}</button>
            ))}
          </div>

          {setsAsync.loading ? <Loading /> : setsAsync.error ? <ErrorBox e={setsAsync.error} /> : sets.length === 0 ? (
            <div className="muted">No finished sets for this selection yet.</div>
          ) : (
            <div className="tablewrap"><table>
              <thead><tr><th>Set</th><th>Subcategory</th><th>Score</th><th>Accuracy</th><th>Avg time/q</th><th></th></tr></thead>
              <tbody>{sets.map((row: any) => (
                <tr key={row.setId}>
                  <td><button className="apx-setlink" onClick={() => onOpenSet(row.setId, row.name)}>{row.name}</button></td>
                  <td className="muted">{row.subcategory?.name || '—'}</td>
                  <td className="tabnum">{row.score?.total > 0 ? `${row.score.correct}/${row.score.total}` : '—'}</td>
                  <td className="tabnum">{row.accuracyPct != null ? `${row.accuracyPct}%` : '—'}</td>
                  <td className="tabnum">{row.avgSecondsPerQuestion != null ? `${row.avgSecondsPerQuestion}s` : '—'}</td>
                  <td><button className="btn ghost sm" onClick={() => onOpenSet(row.setId, row.name)}>⬇ Review / Download</button></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </>)}
      </div>

      <div className="apx-h">Exam Progress</div>
      <div className="apx-card">
        {loading ? null : error ? null : (
          <div className="apx-boxes" style={{ marginBottom: 14 }}>
            <div className="apx-box static">
              <div className="fr">{data?.exam?.papersDone ?? 0} <small>/ {data?.exam?.papersTotal ?? 0}</small></div>
              <div className="lb">Exam papers done</div>
              <div className="bar"><i style={{ width: `${data?.exam?.papersTotal > 0 ? Math.min(100, Math.round((100 * (data.exam.papersDone || 0)) / data.exam.papersTotal)) : 0}%` }} /></div>
            </div>
          </div>
        )}

        <div className="apx-tabs">
          {['verbal', 'quantitative', 'non_verbal'].map((k) => (
            <button key={k} className={`apx-tab ${examBattery === k ? 'on' : ''}`} onClick={() => setExamBattery(k)}>{catVis(k).name}</button>
          ))}
        </div>

        {examAsync.loading ? <Loading /> : examAsync.error ? <ErrorBox e={examAsync.error} /> : examPapers.length === 0 ? (
          <div className="muted">No {catVis(examBattery).name} exam papers finished yet.</div>
        ) : (
          <div className="tablewrap"><table>
            <thead><tr><th>Paper</th><th>Score</th><th>Accuracy</th><th>Time</th><th>Status</th><th></th></tr></thead>
            <tbody>{examPapers.map((p: any) => {
              const noEngagement = (p.attempted_count ?? 0) === 0 && !p.time_spent_seconds;
              const status = noEngagement ? 'Not attempted' : (p.end_reason === 'AUTO_SUBMITTED' ? 'Timed out' : 'Completed');
              const clickable = !noEngagement && !!p.set_id;
              return (
                <tr key={p.session_id}>
                  <td>{clickable
                    ? <button className="apx-setlink" onClick={() => onOpenSet(p.set_id, p.set_name || 'Exam paper')}>{p.set_name || 'Exam paper'}</button>
                    : <span className="muted">{p.set_name || 'Exam paper'}</span>}</td>
                  <td className="tabnum">{p.score_total > 0 ? `${p.score_correct}/${p.score_total}` : '—'}</td>
                  <td className="tabnum">{p.score_total > 0 ? `${p.accuracy_pct}%` : '—'}</td>
                  <td className="tabnum">{fmtMMSS(p.time_spent_seconds)}</td>
                  <td className="muted">{status}</td>
                  <td>{clickable ? <button className="btn ghost sm" onClick={() => onOpenSet(p.set_id, p.set_name || 'Exam paper')}>⬇ Review / Download</button> : null}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

// Full-screen set/paper review — fills the content area (to the right of the sidebar). Shows real
// questions + options with correct/selected marks and images, filter checkboxes (Correct / Wrong &
// unattempted / Explanations), and a Download (opens a print-friendly page → Save as PDF).
function SetReviewModal({ studentId, setId, label, studentName, onClose }: { studentId: string; setId: string; label: string; studentName: string; onClose: () => void }) {
  const { me } = useAuth();
  const { data, loading, error } = useAsync(() => api.getStudentSetReview(studentId, setId), [studentId, setId]);
  const rv: any = data;
  const [showCorrect, setShowCorrect] = useState(true);
  const [showWrong, setShowWrong] = useState(true);
  const [showExpl, setShowExpl] = useState(true);
  const [leftPx, setLeftPx] = useState(0);

  useEffect(() => {
    const measure = () => {
      const el = document.querySelector('.content') as HTMLElement | null;
      setLeftPx(el ? Math.round(el.getBoundingClientRect().left) : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';   // lock the page so only ONE scrollbar (this panel) remains
    return () => { window.removeEventListener('resize', measure); document.body.style.overflow = ''; document.documentElement.style.overflow = ''; };
  }, []);

  const all: any[] = rv?.questions ?? [];
  // "Wrong" covers unanswered (anything not correct).
  const shown = all.filter((q: any) => (q.correct ? showCorrect : showWrong));

  const download = () => {
    if (!rv?.found) return;
    const esc = (s: string) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c]);
    const qHtml = all.map((q: any, i: number) => {
      const opts = (q.options || []).map((o: any) => {
        const style = o.correct ? 'background:#dcfce7;border-color:#86efac' : (o.selected ? 'background:#fee2e2;border-color:#fca5a5' : '');
        const img = o.image_url ? `<img src="${o.image_url}" style="max-width:180px;display:block;margin:4px 0">` : '';
        return `<span style="display:inline-block;border:1px solid #d0d0d0;border-radius:8px;padding:4px 10px;margin:0 6px 6px 0;${style}">${esc(blockText(o.content))}${img}</span>`;
      }).join('');
      const qImg = q.image_url ? `<img src="${q.image_url}" style="max-width:340px;display:block;margin:6px 0">` : '';
      const expl = blockText(q.explanation_blocks);
      const status = q.correct ? '✓ Correct' : (q.answered ? '✗ Incorrect' : 'Not answered');
      const correctTxt = (q.options || []).filter((o: any) => o.correct).map((o: any) => esc(blockText(o.content) || o.option_id)).join(', ');
      return `<div style="padding:12px 0;border-bottom:1px solid #eee"><div style="font-weight:700">Q${i + 1}. ${esc(blockText(q.prompt_blocks))} <span style="color:#666;font-weight:400">(${status})</span></div>${qImg}<div style="margin-top:6px">${opts}</div>${correctTxt ? `<div style="margin-top:6px;font-weight:700;color:#166534">Correct: ${correctTxt}</div>` : ''}${expl ? `<div style="margin-top:8px;background:#eef3fc;border:1px solid #d9e4f7;border-radius:8px;padding:8px 10px;font-size:13px"><b>Why:</b> ${esc(expl)}</div>` : ''}</div>`;
    }).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(studentName)} — ${esc(rv.setName || label)}</title>
      <style>body{font-family:Arial,sans-serif;color:#1a1a1a;max-width:780px;margin:24px auto;padding:0 16px}
      h1{color:#1A5EAB;font-size:20px} .meta{color:#666;font-size:13px;margin-bottom:14px}</style></head>
      <body><h1>${esc(rv.setName || label)}</h1>
      <div class="meta">${esc(studentName)} · Score ${rv.score?.correct ?? 0}/${rv.score?.total ?? 0} · Accuracy ${rv.accuracyPct != null ? rv.accuracyPct + '%' : '—'} · Time ${rv.timeSeconds != null ? Math.round(rv.timeSeconds / 60) + 'm' : '—'}</div>
      ${qHtml}
      <script>window.onload=function(){window.print()}<\/script></body></html>`;
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
  };

  const chk = (checked: boolean, onChange: () => void, labelTxt: string) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ width: 15, height: 15 }} />{labelTxt}
    </label>
  );

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: leftPx, background: 'var(--bg, #f4f6fc)', zIndex: 60, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: 'var(--blue, #1A5EAB)', color: '#fff', flexShrink: 0 }}>
        <button className="btn ghost sm" style={{ background: 'rgba(255,255,255,.15)', color: '#fff', border: '1px solid rgba(255,255,255,.4)' }} onClick={onClose}>← Back</button>
        <div style={{ fontSize: 16, fontWeight: 800 }}>{label} — review</div>
        <button aria-label="Close" onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#fff', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>✕</button>
      </div>

      {rv?.found && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 18px', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid var(--line, #e6e6ef)', background: 'var(--card, #fff)', flexShrink: 0 }}>
          <span style={{ fontSize: 13, color: 'var(--muted, #6b6f8a)' }}>Score <b>{rv.score?.correct ?? 0}/{rv.score?.total ?? 0}</b> · Accuracy <b>{rv.accuracyPct != null ? `${rv.accuracyPct}%` : '—'}</b> · Time <b>{rv.timeSeconds != null ? `${Math.round(rv.timeSeconds / 60)}m` : '—'}</b></span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 18, flexWrap: 'wrap' }}>
            {chk(showCorrect, () => setShowCorrect(v => !v), 'Correct')}
            {chk(showWrong, () => setShowWrong(v => !v), 'Wrong / unattempted')}
            {chk(showExpl, () => setShowExpl(v => !v), 'Explanations')}
          </span>
          {!me?.is_teacher && <button className="btn" onClick={download}>⬇ Download (PDF)</button>}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px', maxWidth: 900, width: '100%', margin: '0 auto' }}>
        {loading ? <Loading /> : error ? <ErrorBox e={error} /> : !rv?.found ? (
          <div className="muted">No submitted attempt found for this set.</div>
        ) : shown.length === 0 ? (
          <div className="muted">Nothing to show — adjust the filters above.</div>
        ) : shown.map((q: any) => {
          const n = all.indexOf(q) + 1;
          const expl = blockText(q.explanation_blocks);
          return (
            <div key={q.question_version_id ?? n} style={{ padding: '14px 0', borderBottom: '1px solid var(--line, #e6e6ef)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 800, fontSize: 14 }}>Question {n}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: q.correct ? '#1e7a46' : (q.answered ? '#b3261e' : 'var(--muted,#6b6f8a)') }}>
                  {q.correct ? '✓ Correct' : (q.answered ? '✗ Incorrect' : 'Not answered')}
                </span>
              </div>
              {blockText(q.prompt_blocks) && <div style={{ marginTop: 6, fontSize: 14.5, lineHeight: 1.5 }}>{blockText(q.prompt_blocks)}</div>}
              {q.image_url && <img src={q.image_url} alt="" style={{ maxWidth: 340, display: 'block', margin: '8px 0', borderRadius: 8 }} />}
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(q.options || []).map((o: any, j: number) => (
                  <span key={o.option_id ?? j} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--line, #d0d0d0)', borderRadius: 9, padding: '6px 11px', fontSize: 13,
                    background: o.correct ? '#dcfce7' : (o.selected ? '#fee2e2' : 'var(--card, #fff)'),
                    color: o.correct ? '#166534' : (o.selected ? '#991b1b' : 'inherit'),
                    fontWeight: (o.correct || o.selected) ? 700 : 400,
                  }}>
                    {o.image_url ? <img src={o.image_url} alt="" style={{ maxWidth: 90, display: 'block' }} /> : (blockText(o.content) || o.option_id)}
                    {o.correct ? ' ✓' : (o.selected ? ' ✗' : '')}
                  </span>
                ))}
              </div>
              {showExpl && expl && (
                <div style={{ marginTop: 10, background: 'var(--sky, #eef3fc)', border: '1px solid #d9e4f7', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: '#2f62c8', marginBottom: 3 }}>💡 Why</div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{expl}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ---- Assignment Panel (teacher -> student SET assignments) -----------------------------------------
// Teacher assigns published sets/papers to a student; each row shows live status (Assigned / In progress
// / Done). Done shows the same figures as a Battery-Practice set (score / accuracy / avg time) and opens
// the shared set-review drawer. Newest first.
const ASG_BCHIP: Record<string, { bg: string; fg: string; label: string }> = {
  verbal: { bg: '#eaf0ff', fg: '#3e7bee', label: 'Verbal' },
  quantitative: { bg: '#e8f7f1', fg: '#12a67f', label: 'Quantitative' },
  non_verbal: { bg: '#f3ecfb', fg: '#8b5cf6', label: 'Non-verbal' },
};
function bChip(key: string, isExam: boolean) {
  if (isExam) return { bg: '#fdf3e2', fg: '#b7791f', label: 'Exam' };
  return ASG_BCHIP[key] || { bg: '#eef2f9', fg: '#475569', label: key };
}
function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString();
}

function AssignmentPanel({ studentId, onOpenSet }: { studentId: string; onOpenSet: (setId: string, label: string) => void }) {
  const [tick, setTick] = useState(0);
  const { data, loading, error } = useAsync(() => api.getStudentAssignments(studentId), [studentId, tick]);
  const items: any[] = data?.assignments ?? [];
  const [assignOpen, setAssignOpen] = useState(false);
  const toast = useToast();

  const remove = async (aid: string) => {
    try { await api.removeStudentAssignment(studentId, aid); setTick(t => t + 1); toast('Assignment removed.'); }
    catch (e) { toast((e as Error).message); }
  };

  return (
    <>
      <style>{`
        .asgp-h{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:800;color:var(--blue,#2f6fd0);margin:22px 0 10px}
        .asgp-h .count{background:var(--sky,#eef4fd);color:var(--blue,#2f6fd0);border-radius:999px;padding:2px 10px;font-size:12px;font-weight:800}
        .asgp-h .btn{margin-left:auto}
        .asgp-card{background:var(--sd-card,#fff);border:1px solid var(--sd-line,#e7e8f2);border-radius:14px;padding:14px 16px;margin-bottom:10px}
        @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .asgp-card{background:#1c1e2b;border-color:#2b2e40}}
        :root[data-theme="dark"] .asgp-card{background:#1c1e2b;border-color:#2b2e40}
        .asgp-top{display:flex;align-items:flex-start;gap:12px}
        .asgp-nm{font-weight:800;font-size:14.5px}
        .asgp-meta{font-size:12.5px;color:var(--muted,#6b6f8a);margin-top:3px}
        .asgp-chip{display:inline-block;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:800;margin-right:6px}
        .asgp-sub{display:inline-block;background:var(--sky,#eef2f9);color:#475569;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:700;margin-right:6px}
        .asgp-status{margin-left:auto;font-size:12px;font-weight:800;border-radius:999px;padding:5px 12px;white-space:nowrap}
        .st-assigned{background:#efeaff;color:#7c5cff}
        .st-progress{background:#fdf3e2;color:#b7791f}
        .st-done{background:#e5f5ec;color:#0f9d58}
        .asgp-bar{height:7px;border-radius:6px;background:#eef2f9;overflow:hidden;width:170px;margin-top:9px}
        .asgp-bar i{display:block;height:100%;background:var(--blue,#2f6fd0)}
        .asgp-res{display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;margin-top:11px;padding-top:11px;border-top:1px dashed var(--sd-line,#e7e8f2)}
        .asgp-res .rv{font-size:12.5px;color:var(--muted,#6b6f8a)}
        .asgp-res .rv b{color:var(--ink,#0f172a);font-weight:800}
        .asgp-link{color:var(--blue,#2f6fd0);font-weight:800;font-size:12.5px;background:none;border:none;cursor:pointer;padding:0}
        .asgp-x{background:none;border:none;color:var(--muted,#9aa1b4);cursor:pointer;font-size:15px;line-height:1;padding:2px 4px}
      `}</style>
      <div className="asgp-h">Assignments {items.length > 0 && <span className="count">{items.length}</span>}
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setAssignOpen(true)}>+ Assign set</button>
      </div>
      {loading ? <Loading /> : error ? <ErrorBox e={error} /> : items.length === 0 ? (
        <div className="asgp-card"><span className="muted">No sets assigned yet. Use “Assign set” to give this student practice or exam papers.</span></div>
      ) : items.map((a: any) => {
        const ch = bChip(a.category_key, a.is_exam);
        const acc = a.result?.accuracyPct;
        const accCol = acc == null ? 'inherit' : acc >= 70 ? '#0f9d58' : acc >= 45 ? '#b7791f' : '#e4574f';
        const pctW = a.progress && a.progress.total > 0 ? Math.min(100, Math.round((100 * a.progress.answered) / a.progress.total)) : 0;
        return (
          <div className="asgp-card" key={a.id}>
            <div className="asgp-top">
              <div style={{ minWidth: 0 }}>
                <div className="asgp-nm">{a.name}</div>
                <div className="asgp-meta">
                  <span className="asgp-chip" style={{ background: ch.bg, color: ch.fg }}>{ch.label}</span>
                  {a.subcategory && <span className="asgp-sub">{a.subcategory}</span>}
                  {a.is_exam && a.duration_minutes ? <span className="asgp-sub">{a.duration_minutes} min</span> : null}
                  {a.question_count != null ? `· ${a.question_count} question${a.question_count === 1 ? '' : 's'} ` : ''}
                  · assigned {timeAgo(a.assigned_at)}{a.assigned_by_name ? ` by ${a.assigned_by_name}` : ''}
                </div>
              </div>
              <span className={`asgp-status ${a.status === 'done' ? 'st-done' : a.status === 'in_progress' ? 'st-progress' : 'st-assigned'}`}>
                {a.status === 'done' ? 'Done' : a.status === 'in_progress' ? 'In progress' : 'Assigned'}
              </span>
              {a.status === 'assigned' && <button className="asgp-x" title="Remove assignment" onClick={() => remove(a.id)}>✕</button>}
            </div>
            {a.status === 'in_progress' && <div className="asgp-bar"><i style={{ width: `${pctW}%` }} /></div>}
            {a.status === 'done' && a.result && (
              <div className="asgp-res">
                <span className="rv">Score <b>{a.result.score.correct}/{a.result.score.total}</b></span>
                <span className="rv">Accuracy <b style={{ color: accCol }}>{acc != null ? `${acc}%` : '—'}</b></span>
                <span className="rv">Avg time/q <b>{a.result.avgSecondsPerQuestion != null ? `${a.result.avgSecondsPerQuestion}s` : '—'}</b></span>
                <span className="rv">Finished <b>{timeAgo(a.result.finishedAt)}</b></span>
                <button className="asgp-link" style={{ marginLeft: 'auto' }} onClick={() => onOpenSet(a.question_set_id, a.name)}>View set →</button>
              </div>
            )}
          </div>
        );
      })}
      {assignOpen && <AssignModal studentId={studentId} onClose={() => setAssignOpen(false)} onAssigned={() => { setAssignOpen(false); setTick(t => t + 1); }} />}
    </>
  );
}

function AssignModal({ studentId, onClose, onAssigned }: { studentId: string; onClose: () => void; onAssigned: () => void }) {
  const { data, loading, error } = useAsync(() => api.getStudentAssignmentsCatalog(studentId), [studentId]);
  const catalog: any[] = data ?? [];
  const [battery, setBattery] = useState<string>('');
  const [sub, setSub] = useState<string>('all');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const batteries = Array.from(new Set(catalog.map((c: any) => c.category_key)));
  const activeBattery = battery || batteries[0] || '';
  const subs = Array.from(new Set(catalog.filter((c: any) => c.category_key === activeBattery && c.subcategory).map((c: any) => c.subcategory)));
  const shown = catalog.filter((c: any) => c.category_key === activeBattery && (sub === 'all' || c.subcategory === sub));
  const count = Object.values(picked).filter(Boolean).length;

  const toggle = (svid: string) => setPicked(p => ({ ...p, [svid]: !p[svid] }));
  const assign = async () => {
    const ids = Object.keys(picked).filter(k => picked[k]);
    if (ids.length === 0) return;
    setBusy(true);
    try { const r = await api.addStudentAssignments(studentId, ids); toast(`Assigned ${r.added} set${r.added === 1 ? '' : 's'}.`); onAssigned(); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal title="Assign sets" wide onClose={onClose}
      footer={<>
        <span className="muted" style={{ marginRight: 'auto', fontSize: 12.5 }}>{count} selected · already-assigned sets are hidden</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || count === 0} onClick={assign}>{busy ? 'Assigning…' : `Assign ${count || ''} set${count === 1 ? '' : 's'}`}</button>
      </>}>
      {loading ? <Loading /> : error ? <ErrorBox e={error} /> : catalog.length === 0 ? (
        <div className="muted">No unassigned published sets for this student’s grade.</div>
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <label style={{ fontSize: 12.5, fontWeight: 700 }}>Battery
              <select value={activeBattery} onChange={e => { setBattery(e.target.value); setSub('all'); }}
                style={{ display: 'block', marginTop: 5, border: '1px solid var(--line,#e4e9f2)', borderRadius: 9, padding: '7px 10px', fontWeight: 600 }}>
                {batteries.map((b: string) => <option key={b} value={b}>{bChip(b, false).label}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12.5, fontWeight: 700 }}>Subcategory
              <select value={sub} onChange={e => setSub(e.target.value)}
                style={{ display: 'block', marginTop: 5, border: '1px solid var(--line,#e4e9f2)', borderRadius: 9, padding: '7px 10px', fontWeight: 600 }}>
                <option value="all">All subcategories</option>
                {subs.map((sName: string) => <option key={sName} value={sName}>{sName}</option>)}
              </select>
            </label>
          </div>
          <div style={{ border: '1px solid var(--line,#e4e9f2)', borderRadius: 12, maxHeight: 300, overflow: 'auto' }}>
            {shown.length === 0 ? <div className="muted" style={{ padding: 14 }}>Nothing here.</div> : shown.map((c: any) => (
              <label key={c.set_version_id}
                style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px', borderBottom: '1px solid var(--line,#eef1f7)', cursor: 'pointer', background: picked[c.set_version_id] ? 'var(--sky,#eef4fd)' : 'transparent' }}>
                <input type="checkbox" checked={!!picked[c.set_version_id]} onChange={() => toggle(c.set_version_id)} style={{ width: 16, height: 16 }} />
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{c.name}</span>
                {c.subcategory && <span className="tag" style={{ fontSize: 11 }}>{c.subcategory}</span>}
                {c.allowed_modes?.includes('exam') && <span className="tag" style={{ fontSize: 11, background: '#fdf3e2', color: '#b7791f' }}>Exam</span>}
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted,#6b6f8a)' }}>{c.question_count} q{c.duration_minutes ? ` · ${c.duration_minutes}m` : ''}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
