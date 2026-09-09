import { useEffect, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import type { EntitlementTier } from '@ccat/api-client';
import { useApp } from '../lib/store';
import { client } from '../lib/api';
import { AppBar, Card, Loader } from '../components/ui';
import {
  PAYMENTS_ENABLED, TIER_CATALOG, eligibleUpgradeTiers, tierIndex,
} from '../lib/entitlements';

// My Plan. Shows the student's current membership + what each higher plan unlocks. Upgrades run through
// PayPal in-app: clicking Upgrade opens a confirm modal (pay with the REGISTERED email so the grant lands
// on this account), then creates a PayPal order on the gateway and redirects to PayPal to pay.
// On return (?checkout=success&token=<orderId>) the page captures the order; the gateway grants the tier
// (idempotent with the webhook). The page then POLLs /v1/entitlements/me until the new tier unlocks.

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
  const [confirmTier, setConfirmTier] = useState<EntitlementTier | null>(null);
  const [acctEmail, setAcctEmail] = useState<string | null | undefined>(undefined); // undefined = not loaded yet
  const baseline = useRef<number | null>(null);

  // Load the entitlement if we don't have it yet.
  useEffect(() => { if (!entitlements) refreshEntitlements(); }, [entitlements, refreshEntitlements]);

  // On return from PayPal approval, capture the order (PayPal appends ?token=<orderId>). The gateway
  // grants on a COMPLETED capture; the poll below then confirms. Runs once.
  const captured = useRef(false);
  useEffect(() => {
    if (checkout !== 'success' || captured.current) return;
    const orderId = params.get('token');
    if (!orderId) return;
    captured.current = true;
    client.paypalCapture(orderId).catch(() => { /* poll still runs; webhook is the backstop */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout]);

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

  // Open the confirm modal for a tier; lazily fetch the account email to show in it (best-effort).
  async function openConfirm(tier: EntitlementTier) {
    if (tier === 'free' || busyTier) return;
    setConfirmTier(tier);
    if (acctEmail === undefined) {
      try { const a = await client.account(); setAcctEmail(a.guardian?.email ?? null); }
      catch { setAcctEmail(null); }
    }
  }

  // Pay → create the PayPal order and redirect to PayPal approval.
  async function proceedToPayPal() {
    const tier = confirmTier;
    if (!tier || tier === 'free' || busyTier) return;
    setBusyTier(tier);
    try {
      const order = await client.paypalCreateOrder(tier as 't50' | 't250' | 't500');
      window.location.href = order.url; // redirect to PayPal approval
    } catch (e) {
      setBusyTier(null);
      setConfirmTier(null);
      flash((e as Error).message || 'Could not start checkout. Please try again.');
    }
  }

  const current: EntitlementTier = entitlements?.tier ?? 'free';
  const cur = TIER_CATALOG[current];
  const upgrades = eligibleUpgradeTiers(current);
  const confirmInfo = confirmTier ? TIER_CATALOG[confirmTier] : null;

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
                  <button
                    className="btn"
                    disabled={busyTier != null}
                    onClick={() => openConfirm(t)}
                  >
                    {busyTier === t ? 'Redirecting…' : `Upgrade to ${info.label}`}
                  </button>
                </Card>
              );
            })}
            <div className="muted" style={{ fontSize: 12.5 }}>
              Payment is handled securely by PayPal. Ask a grown-up to complete the purchase — your plan unlocks automatically once it's paid.
            </div>
          </>
        )}
      </div>

      {/* Confirm-email modal (shown between Upgrade and PayPal). */}
      {confirmTier && confirmInfo && (
        <div
          role="dialog" aria-modal="true" aria-label="Confirm payment email"
          onClick={() => { if (!busyTier) setConfirmTier(null); }}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(20,24,40,.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'relative', width: 'min(400px,92%)', background: '#fff', borderRadius: 18,
              boxShadow: '0 24px 60px -24px rgba(42,46,67,.55)', padding: '24px 22px' }}
          >
            <button aria-label="Close" onClick={() => { if (!busyTier) setConfirmTier(null); }}
              style={{ position: 'absolute', right: 12, top: 8, background: 'transparent', border: 'none',
                color: '#8a90a6', fontSize: 18, fontWeight: 800, cursor: 'pointer' }}>✕</button>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: '#eaf0ff', display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: 30, margin: '0 auto 12px' }}>💳</div>
            <h3 style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 21, margin: '0 0 8px', textAlign: 'center' }}>One quick check</h3>
            <p style={{ fontSize: 14, fontWeight: 700, color: '#4a4f66', lineHeight: 1.55, margin: '0 0 14px', textAlign: 'center' }}>
              On the next screen, pay with the same email you registered with
              {acctEmail ? <> — <strong style={{ color: '#3e7bee' }}>{acctEmail}</strong></> : ' '}
              {' '}so the plan unlocks on <strong>this</strong> account. A different PayPal email won't upgrade you here.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: '#eaf0ff', borderRadius: 12, padding: '11px 14px', marginBottom: 16 }}>
              <span style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 14, color: '#2a2e43' }}>{confirmInfo.name}</span>
              <span style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 14, color: '#3e7bee' }}>{confirmInfo.priceLabel}</span>
            </div>
            <div className="stack" style={{ gap: 9 }}>
              <button
                onClick={proceedToPayPal}
                disabled={busyTier != null}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 16, border: 'none',
                  borderRadius: 14, padding: '13px 18px', width: '100%', cursor: 'pointer',
                  background: '#ffc439', color: '#003087', opacity: busyTier ? 0.7 : 1 }}
              >
                {busyTier ? 'Redirecting…' : 'Pay with PayPal'}
              </button>
              <button onClick={() => { if (!busyTier) setConfirmTier(null); }}
                style={{ background: 'transparent', border: 'none', color: '#8a90a6',
                  fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 15, padding: 10, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
