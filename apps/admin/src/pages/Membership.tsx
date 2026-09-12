import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Panel, useToast } from '../components/ui';

// Payments Phase 2 — MANUAL membership grant (temporary bridge until Stripe/webhook exist). Set a
// guardian's tier by email so both states can be tested today with no payment: free (demo-only) vs
// t50 (all practice; Exam/Combine still locked). Super-Admin only (server enforces config.global).
// All four tiers are grantable here (free / $50 / $100 / $200) — prices match the web CCAT plans.
// Entering an email also shows the student(s) linked to that guardian so you grant the right family.

type Tier = 'free' | 't50' | 't250' | 't500';
const TIERS: { value: Tier; label: string }[] = [
  { value: 'free', label: 'free — demo sets only' },
  { value: 't50', label: '$50 (Standard) — all practice (Exam/Combine locked)' },
  { value: 't250', label: '$100 (Plus) — practice + Exam + Combine (Weekly locked)' },
  { value: 't500', label: '$200 (Premium) — everything incl. Weekly' },
];
const REASONS: { value: string; label: string }[] = [
  { value: 'comp', label: 'Comp (free access)' },
  { value: 'paid', label: 'Paid' },
  { value: 'sale', label: 'Sale' },
  { value: 'discount', label: 'Discount' },
  { value: 'trial', label: 'Trial' },
  { value: 'other', label: 'Other' },
];

interface LinkedStudent {
  display_name: string; username: string; status: string;
  grade_number?: number | null; grade_name?: string | null;
  is_primary?: boolean; relationship?: string | null;
}

export function Membership() {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('config.global'); // Super-Admin (config.global is Super-Admin-only)

  const [email, setEmail] = useState('');
  const [tier, setTier] = useState<Tier>('t50');
  const [reason, setReason] = useState<string>('comp');
  const [expiry, setExpiry] = useState<string>(''); // date (YYYY-MM-DD); empty = no expiry. Saved as 00:00 IST.
  const [current, setCurrent] = useState<any | null>(null);
  const [students, setStudents] = useState<LinkedStudent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastLoadedEmail, setLastLoadedEmail] = useState('');

  const load = async (opts: { silent?: boolean } = {}) => {
    const e = email.trim().toLowerCase();
    if (!e) { if (!opts.silent) toast('Enter a guardian email'); return; }
    setBusy(true);
    try {
      const r = await api.getEntitlement(e);
      setCurrent(r.item);
      setStudents(r.students ?? []);
      setLoaded(true);
      setLastLoadedEmail(e);
      if (r.item) {
        setTier((['free', 't50', 't250', 't500'] as const).includes(r.item.tier) ? r.item.tier : 'free');
        setExpiry(r.item.current_period_end ? toISTDate(r.item.current_period_end) : '');
        setReason(REASONS.some((x) => x.value === r.item.grant_reason) ? r.item.grant_reason : 'comp');
      } else {
        setTier('t50'); setExpiry(''); setReason('comp');
      }
    } catch (err) { if (!opts.silent) toast((err as Error).message); }
    finally { setBusy(false); }
  };

  // Auto-lookup when the admin leaves the email field (still keep the explicit button).
  const onEmailBlur = () => { const e = email.trim().toLowerCase(); if (e && e !== lastLoadedEmail) load({ silent: true }); };

  const save = async () => {
    const e = email.trim().toLowerCase();
    if (!e) { toast('Enter a guardian email'); return; }
    setBusy(true);
    try {
      await api.setEntitlement({
        guardian_email: e,
        tier,
        status: 'active',
        current_period_end: istMidnightIso(expiry),
        grant_reason: reason,
      });
      // Refresh so the "Current" line + linked students reflect the saved state consistently.
      const g = await api.getEntitlement(e);
      setCurrent(g.item);
      setStudents(g.students ?? []);
      setLoaded(true);
      setLastLoadedEmail(e);
      toast(`Saved — ${e} → ${tier}`);
    } catch (err) { toast((err as Error).message); }
    finally { setBusy(false); }
  };

  const gradeLabel = (s: LinkedStudent) =>
    s.grade_name || (s.grade_number != null ? `Grade ${s.grade_number}` : '—');

  return (
    <>
      <h2>Membership</h2>
      <p className="lead">
        Manually set a guardian's membership tier by email. Real purchases flow through PayPal; use this to
        grant or adjust access manually. {editable ? '' : 'Read-only — needs Super-Admin.'}
      </p>

      <Panel title="Set a guardian's tier">
        <div className="stack" style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Guardian email</div>
            <div className="row" style={{ gap: 8 }}>
              <input className="input" type="email" value={email} placeholder="guardian@example.com"
                onChange={(e) => { setEmail(e.target.value); setLoaded(false); setCurrent(null); setStudents([]); }}
                onBlur={onEmailBlur}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); load(); } }}
                style={{ flex: 1 }} />
              <button className="btn ghost" onClick={() => load()} disabled={busy || !email.trim()}>Look up</button>
            </div>
          </label>

          {/* Who is this email — the linked student(s), so you grant the right family. */}
          {loaded && (
            <div className="panel" style={{ padding: 12, background: 'var(--tint, rgba(127,127,127,.06))' }}>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Linked {students.length === 1 ? 'student' : 'students'}
              </div>
              {students.length === 0 ? (
                <div className="muted" style={{ fontSize: 13 }}>No student is linked to this guardian email.</div>
              ) : (
                <div className="stack" style={{ display: 'grid', gap: 8 }}>
                  {students.map((s, i) => (
                    <div key={i} className="between" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <div>
                        <strong>{s.display_name}</strong>{' '}
                        <span className="muted">@{s.username}</span>
                        <div className="muted" style={{ fontSize: 12.5 }}>
                          {gradeLabel(s)} · {s.relationship || 'guardian'}{s.is_primary ? ' · primary' : ''}
                        </div>
                      </div>
                      <span className={`pill dotted s-${s.status} st-${s.status}`}>{s.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {loaded && (
            <div className="muted" style={{ fontSize: 13 }}>
              {current
                ? <>Current entitlement: <strong>{current.tier}</strong> · {current.status}{current.current_period_end ? ` · expires ${new Date(current.current_period_end).toLocaleString()}` : ' · no expiry'} · source {current.source}</>
                : <>No entitlement yet for this email — saving will create one (a guardian with no row is treated as free).</>}
            </div>
          )}

          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Tier</div>
            <select className="input" value={tier} disabled={!editable} onChange={(e) => setTier(e.target.value as Tier)}>
              {TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>

          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Reason</div>
            <select className="input" value={reason} disabled={!editable} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              "Paid" records a real payment (normally set by PayPal); the rest are non-paying access.
            </div>
          </label>

          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Expiry (optional — blank = no expiry)</div>
            <input className="input" type="date" value={expiry} disabled={!editable} onChange={(e) => setExpiry(e.target.value)} />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Expires at 12:00 am IST on this date.</div>
          </label>

          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={save} disabled={!editable || busy || !email.trim()}>{busy ? 'Saving…' : 'Save grant'}</button>
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            All tiers are grantable (free / t50 / t250 / t500). t250 unlocks Exam + Battery Combine; t500 adds
            Weekly. Manual grants are for admin use; real purchases flow through PayPal checkout and the webhook.
          </p>
        </div>
      </Panel>

      <UnclaimedPaidPanel />

      <DefaultPlanPanel editable={editable} />
    </>
  );
}

// Landing Case 2 — parents who PAID before creating an account. No student exists yet, so they don't
// appear on the Students page; their plan is reserved on the email and activates automatically once they
// sign up with it. This list is how ops can see and chase abandoned post-payment signups. Rows disappear
// on their own once the account is created.
const PLAN_NAME: Record<string, string> = { free: 'Free', t50: 'Standard', t250: 'Plus', t500: 'Premium' };
function UnclaimedPaidPanel() {
  const toast = useToast();
  const [items, setItems] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try { const r = await api.unclaimedPaid(); setItems(r.items ?? []); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const daysSince = (iso?: string) => {
    if (!iso) return null;
    const d = new Date(iso); if (isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  };

  return (
    <Panel title="Paid — awaiting account">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <p className="lead" style={{ margin: 0, maxWidth: 680 }}>
          Parents who paid on the website before creating an account. They aren't in Students yet — access is
          reserved on their email and activates automatically when they sign up with that same email.
        </p>
        <button className="btn ghost" onClick={load} disabled={busy}>{busy ? 'Loading…' : 'Refresh'}</button>
      </div>

      {items == null ? (
        <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
      ) : items.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>None — every paid purchase has an account.</div>
      ) : (
        <div className="stack" style={{ display: 'grid', gap: 8 }}>
          {items.map((it, i) => {
            const days = daysSince(it.created_at);
            return (
              <div key={i} className="between" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '10px 12px', border: '1px solid var(--line, rgba(127,127,127,.18))', borderRadius: 10 }}>
                <div>
                  <strong>{it.guardian_email}</strong>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {PLAN_NAME[it.tier] ?? it.tier} plan
                    {it.current_period_end ? ` · expires ${new Date(it.current_period_end).toLocaleDateString()}` : ''}
                    {it.created_at ? ` · paid ${new Date(it.created_at).toLocaleDateString()}` : ''}
                  </div>
                </div>
                <span className="pill dotted" style={days != null && days >= 3 ? { color: 'var(--amber, #a15c00)' } : undefined}>
                  {days != null ? `waiting ${days}d` : 'awaiting account'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// Site-wide DEFAULT plan (promo lever). Setting this to a non-free tier grants that tier to every
// non-paying user until the (optional) expiry; setting it back to Free instantly returns them to demo.
// Paid users are unaffected either way.
function DefaultPlanPanel({ editable }: { editable: boolean }) {
  const toast = useToast();
  const [tier, setTier] = useState<Tier>('free');
  const [until, setUntil] = useState<string>('');
  const [current, setCurrent] = useState<{ default_tier: string; default_until: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { const r = await api.getDefaultPlan(); setCurrent(r); setTier((['free', 't50', 't250', 't500'] as const).includes(r.default_tier as Tier) ? (r.default_tier as Tier) : 'free'); setUntil(r.default_until ? toISTDate(r.default_until) : ''); }
    catch (e) { toast((e as Error).message); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.setDefaultPlan({ tier, until: istMidnightIso(until) });
      setCurrent(r);
      toast(`Default plan → ${r.default_tier}${r.default_until ? ` until ${new Date(r.default_until).toLocaleString()}` : ' (no expiry)'}`);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Panel title="Default plan (applies to all non-paying users)">
      <div className="stack" style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
        {current && (
          <div className="muted" style={{ fontSize: 13 }}>
            Current default: <strong>{current.default_tier}</strong>
            {current.default_until ? ` · until ${new Date(current.default_until).toLocaleString()}` : ' · no expiry'}
            {current.default_tier === 'free' ? ' · (no promo — non-paying users get demo only)' : ''}
          </div>
        )}
        <label>
          <div className="muted" style={{ marginBottom: 4 }}>Default tier</div>
          <select className="input" value={tier} disabled={!editable} onChange={(e) => setTier(e.target.value as Tier)}>
            {TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label>
          <div className="muted" style={{ marginBottom: 4 }}>Until (optional — blank = no expiry)</div>
          <input className="input" type="date" value={until} disabled={!editable} onChange={(e) => setUntil(e.target.value)} />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Ends at 12:00 am IST on this date.</div>
        </label>
        {tier === 'free' && (
          <div className="muted" style={{ fontSize: 12.5, color: 'var(--amber, #a15c00)' }}>
            ⚠ Setting this to Free removes the site-wide default: users WITHOUT an explicit grant return to the demo. Existing comp/paid grants stay active until you cancel or expire them.
          </div>
        )}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={save} disabled={!editable || busy}>{busy ? 'Saving…' : 'Save default plan'}</button>
        </div>
      </div>
    </Panel>
  );
}

// Expiry is entered as a date only; it means 12:00 am IST (Asia/Kolkata, UTC+5:30) on that date.
// istMidnightIso turns a YYYY-MM-DD value into the matching UTC ISO timestamp (empty → null).
const IST_OFFSET = '+05:30';
export function istMidnightIso(date: string): string | null {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00${IST_OFFSET}`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
// Convert a stored UTC ISO timestamp back to the IST calendar date for the <input type="date">.
export function toISTDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000); // shift to IST wall clock, read UTC parts
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}
