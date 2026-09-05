import { useEffect, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import type { EntitlementTier } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Card, Loader } from '../components/ui';
import {
  PAYMENTS_ENABLED, TIER_CATALOG, eligibleUpgradeTiers, tierIndex,
} from '../lib/entitlements';

// Payments Phase 1 — My Plan. Shows the student's current membership + what each higher plan unlocks,
// and starts a Stripe Checkout for an UPGRADE (never a downgrade). The app collects NO card details —
// payment happens on Stripe's hosted page; we only redirect there and back. The entitlement is granted
// server-side by the webhook after Stripe confirms payment, so on return we POLL until it unlocks.

const POLL_INTERVAL_MS = 1800;
const POLL_MAX_TRIES = 12; // ~22s

export function MyPlanScreen() {
  // Flag OFF → no My Plan (true no-op). Route guard mirrors the sidebar visibility.
  if (!PAYMENTS_ENABLED) return <Navigate to="/home" replace />;

  const { entitlements, refreshEntitlements, flash } = useApp();
  const [params] = useSearchParams();
  const checkout = params.get('checkout'); // 'success' | 'cancel' | null

  const [phase, setPhase] = useState<'idle' | 'activating' | 'done' | 'timeout' | 'canceled'>(
    checkout === 'success' ? 'activating' : checkout === 'cancel' ? 'canceled' : 'idle',
  );
  const [busyTier, setBusyTier] = useState<EntitlementTier | null>(null);
  const baseline = useRef<number | null>(null);

  // Load the entitlement if we don't have it yet.
  useEffect(() => { if (!entitlements) refreshEntitlements(); }, [entitlements, refreshEntitlements]);

  // On return from a successful Checkout, poll the entitlement until the tier goes up (webhook applied).
  useEffect(() => {
    if (phase !== 'activating') return;
    if (baseline.current == null) baseline.current = tierIndex(entitlements?.tier ?? 'free');
    let tries = 0;
    const id = window.setInterval(async () => {
      tries++;
      await refreshEntitlements();
      if (tries >= POLL_MAX_TRIES) { window.clearInterval(id); setPhase((p) => (p === 'activating' ? 'timeout' : p)); }
    }, POLL_INTERVAL_MS);
    refreshEntitlements();
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Detect the unlock: the effective tier rose above where it was when we returned.
  useEffect(() => {
    if (phase === 'activating' && baseline.current != null && entitlements
        && tierIndex(entitlements.tier) > baseline.current) {
      setPhase('done');
    }
  }, [entitlements, phase]);

  async function upgrade(tier: EntitlementTier) {
    if (tier === 'free') return;
    setBusyTier(tier);
    try {
      const r = await client.checkoutSession(tier as 't50' | 't250' | 't500');
      if (r.url) window.location.href = r.url;
      else flash('Could not start checkout — please try again.');
    } catch (e) {
      flash((e as Error).message || 'Could not start checkout.');
    } finally {
      setBusyTier(null);
    }
  }

  const current: EntitlementTier = entitlements?.tier ?? 'free';
  const cur = TIER_CATALOG[current];
  const upgrades = eligibleUpgradeTiers(current);

  return (
    <>
      <AppBar title="My Plan" sub="Your membership & upgrades" back />
      <div className="content stack">
        {phase === 'activating' && (
          <Card className="stack">
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <Loader />
              <div><strong>Activating your upgrade…</strong>
                <div className="muted" style={{ fontSize: 13 }}>Payment confirmed — unlocking your new plan. This takes a few seconds.</div>
              </div>
            </div>
          </Card>
        )}
        {phase === 'done' && (
          <Card className="stack">
            <strong>🎉 You're upgraded!</strong>
            <div className="muted" style={{ fontSize: 13 }}>Your new plan is active. Enjoy your unlocked practice.</div>
          </Card>
        )}
        {phase === 'timeout' && (
          <Card className="stack">
            <strong>Almost there…</strong>
            <div className="muted" style={{ fontSize: 13 }}>Your payment is being confirmed. This can take a moment.</div>
            <button className="btn small secondary" onClick={() => { baseline.current = null; setPhase('activating'); }}>Check again</button>
          </Card>
        )}
        {phase === 'canceled' && (
          <Card className="stack">
            <strong>Checkout canceled</strong>
            <div className="muted" style={{ fontSize: 13 }}>No payment was made. You can pick a plan again whenever you're ready.</div>
          </Card>
        )}

        {/* Current plan */}
        <Card className="stack">
          <div className="muted" style={{ fontSize: 12.5, textTransform: 'uppercase', letterSpacing: '.04em' }}>Current plan</div>
          <div className="row" style={{ alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 20 }}>{cur.name}</strong>
            <span className="pill">{cur.priceLabel}</span>
          </div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {cur.features.map((f) => <li key={f} className="muted" style={{ fontSize: 13 }}>{f}</li>)}
          </ul>
        </Card>

        {/* Upgrades */}
        {upgrades.length === 0 ? (
          <Card><div className="muted">You're on the top plan — everything is unlocked. 🎉</div></Card>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 12.5, textTransform: 'uppercase', letterSpacing: '.04em' }}>Upgrade</div>
            {upgrades.map((t) => {
              const info = TIER_CATALOG[t];
              return (
                <Card key={t} className="stack">
                  <div className="row" style={{ alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 18 }}>{info.name}</strong>
                    <span className="pill">{info.priceLabel}</span>
                  </div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {info.features.map((f) => <li key={f} className="muted" style={{ fontSize: 13 }}>{f}</li>)}
                  </ul>
                  <button className="btn" disabled={busyTier === t} onClick={() => upgrade(t)}>
                    {busyTier === t ? 'Starting…' : `Upgrade to ${info.label}`}
                  </button>
                </Card>
              );
            })}
            <div className="muted" style={{ fontSize: 12.5 }}>
              Payment is completed securely on Stripe — the app never sees your card. Ask a grown-up to complete it.
            </div>
          </>
        )}
      </div>
    </>
  );
}
