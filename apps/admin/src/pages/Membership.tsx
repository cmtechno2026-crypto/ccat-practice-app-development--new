import React, { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Panel, useToast } from '../components/ui';

// Payments Phase 2 — MANUAL membership grant (temporary bridge until Stripe/webhook exist). Set a
// guardian's tier by email so both states can be tested today with no payment: free (demo-only) vs
// t50 (all practice; Exam/Combine still locked). Super-Admin only (server enforces config.global).
// Only tiers reachable this phase are offered (free / t50) — $250/$500 have no grant path yet.
// Entering an email also shows the student(s) linked to that guardian so you grant the right family.

type Tier = 'free' | 't50' | 't250' | 't500';
const TIERS: { value: Tier; label: string }[] = [
  { value: 'free', label: 'free — demo sets only' },
  { value: 't50', label: 't50 ($50) — all practice (Exam/Combine locked)' },
  { value: 't250', label: 't250 ($250) — practice + Exam + Combine (Weekly locked)' },
  { value: 't500', label: 't500 ($500) — everything incl. Weekly' },
];
const STATUSES = ['active', 'canceled', 'expired', 'pending'] as const;

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
  const [status, setStatus] = useState<string>('active');
  const [expiry, setExpiry] = useState<string>(''); // datetime-local; empty = no expiry
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
        setStatus(r.item.status ?? 'active');
        setExpiry(r.item.current_period_end ? toLocalInput(r.item.current_period_end) : '');
      } else {
        setTier('t50'); setStatus('active'); setExpiry('');
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
        status,
        current_period_end: expiry ? new Date(expiry).toISOString() : null,
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
        Manually set a guardian's membership tier by email. This is a temporary bridge for testing until
        Stripe is connected. {editable ? '' : 'Read-only — needs Super-Admin.'}
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
            <div className="muted" style={{ marginBottom: 4 }}>Status</div>
            <select className="input" value={status} disabled={!editable} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Expiry (optional — blank = no expiry)</div>
            <input className="input" type="datetime-local" value={expiry} disabled={!editable} onChange={(e) => setExpiry(e.target.value)} />
          </label>

          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={save} disabled={!editable || busy || !email.trim()}>{busy ? 'Saving…' : 'Save grant'}</button>
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            All tiers are grantable (free / t50 / t250 / t500). t250 unlocks Exam + Battery Combine; t500 adds
            Weekly. Manual grants are for testing; real purchases flow through Stripe Checkout and the webhook.
          </p>
        </div>
      </Panel>
    </>
  );
}

// Convert an ISO timestamp to a value the <input type="datetime-local"> accepts (local wall-clock,
// no timezone, minute precision).
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
