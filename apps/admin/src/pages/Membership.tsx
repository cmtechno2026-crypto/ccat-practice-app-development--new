import React, { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Panel, useToast } from '../components/ui';

// Payments Phase 2 — MANUAL membership grant (temporary bridge until Stripe/webhook exist). Set a
// guardian's tier by email so both states can be tested today with no payment: free (demo-only) vs
// t50 (all practice; Exam/Combine still locked). Super-Admin only (server enforces config.global).
// Only tiers reachable this phase are offered (free / t50) — $250/$500 have no grant path yet.
// No AI, no card fields, no bulk — a single grant control. Reached only when VITE_PAYMENTS_ENABLED.

const TIERS: { value: 'free' | 't50'; label: string }[] = [
  { value: 'free', label: 'free — demo sets only' },
  { value: 't50', label: 't50 ($50) — all practice (Exam/Combine still locked)' },
];
const STATUSES = ['active', 'canceled', 'expired', 'pending'] as const;

export function Membership() {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('config.global'); // Super-Admin (config.global is Super-Admin-only)

  const [email, setEmail] = useState('');
  const [tier, setTier] = useState<'free' | 't50'>('t50');
  const [status, setStatus] = useState<string>('active');
  const [expiry, setExpiry] = useState<string>(''); // datetime-local; empty = no expiry
  const [current, setCurrent] = useState<any | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const e = email.trim().toLowerCase();
    if (!e) { toast('Enter a guardian email'); return; }
    setBusy(true);
    try {
      const r = await api.getEntitlement(e);
      setCurrent(r.item);
      setLoaded(true);
      if (r.item) {
        setTier(r.item.tier === 't50' ? 't50' : 'free');
        setStatus(r.item.status ?? 'active');
        setExpiry(r.item.current_period_end ? toLocalInput(r.item.current_period_end) : '');
      } else {
        setTier('t50'); setStatus('active'); setExpiry('');
      }
    } catch (err) { toast((err as Error).message); }
    finally { setBusy(false); }
  };

  const save = async () => {
    const e = email.trim().toLowerCase();
    if (!e) { toast('Enter a guardian email'); return; }
    setBusy(true);
    try {
      const r = await api.setEntitlement({
        guardian_email: e,
        tier,
        status,
        current_period_end: expiry ? new Date(expiry).toISOString() : null,
      });
      setCurrent(r.item);
      setLoaded(true);
      toast(`Saved — ${e} → ${tier}`);
    } catch (err) { toast((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <h2>Membership</h2>
      <p className="lead">
        Manually set a guardian's membership tier by email. This is a temporary bridge for testing until
        Stripe is connected. {editable ? '' : 'Read-only — needs Super-Admin.'}
      </p>

      <Panel title="Set a guardian's tier">
        <div className="stack" style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Guardian email</div>
            <div className="row" style={{ gap: 8 }}>
              <input className="input" type="email" value={email} placeholder="guardian@example.com"
                onChange={(e) => { setEmail(e.target.value); setLoaded(false); setCurrent(null); }} style={{ flex: 1 }} />
              <button className="btn ghost" onClick={load} disabled={busy || !email.trim()}>Load current</button>
            </div>
          </label>

          {loaded && (
            <div className="muted" style={{ fontSize: 13 }}>
              {current
                ? <>Current: <strong>{current.tier}</strong> · {current.status}{current.current_period_end ? ` · expires ${new Date(current.current_period_end).toLocaleString()}` : ' · no expiry'} · source {current.source}</>
                : <>No entitlement yet for this email — saving will create one (defaults to free elsewhere).</>}
            </div>
          )}

          <label>
            <div className="muted" style={{ marginBottom: 4 }}>Tier</div>
            <select className="input" value={tier} disabled={!editable} onChange={(e) => setTier(e.target.value as 'free' | 't50')}>
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
            Only free and t50 are grantable this phase. Exam and Battery Combine stay locked for every tier
            until the $250/$500 phases ship.
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
