import { useEffect, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import type { EntitlementTier } from '@ccat/api-client';
import { useApp } from '../lib/store';
import { client } from '../lib/api';
import { AppBar, Card, Loader } from '../components/ui';
import { PAYMENTS_ENABLED, TIER_CATALOG, TIER_SEQUENCE, tierIndex } from '../lib/entitlements';

// My Plan — 4-tier pricing page (Free / Standard / Plus / Premium). Upgrades run through PayPal in-app:
// a plan's button opens the confirm modal (pay with the registered email), which creates a PayPal order
// on the gateway and redirects to PayPal. On return (?checkout=success&token=<orderId>) the page captures
// the order; the gateway grants the tier (idempotent with the webhook). The page then POLLs
// /v1/entitlements/me until the new tier unlocks. Prices here are display-only; the gateway owns the
// real PayPal amount + the eligibility decision.

const POLL_INTERVAL_MS = 1800;
const POLL_MAX_TRIES = 12; // ~22s

export function MyPlanScreen() {
  if (!PAYMENTS_ENABLED) return <Navigate to="/home" replace />;

  const { entitlements, refreshEntitlements, flash } = useApp();
  const [params] = useSearchParams();
  const checkout = params.get('checkout'); // 'success' | 'cancel' | null

  const [phase, setPhase] = useState<'idle' | 'activating' | 'done' | 'timeout' | 'canceled'>(
    checkout === 'success' ? 'activating' : checkout === 'cancel' ? 'canceled' : 'idle',
  );
  const [busyTier, setBusyTier] = useState<EntitlementTier | null>(null);
  const [confirmTier, setConfirmTier] = useState<EntitlementTier | null>(null);
  const [acctEmail, setAcctEmail] = useState<string | null | undefined>(undefined);
  const baseline = useRef<number | null>(null);

  useEffect(() => { if (!entitlements) refreshEntitlements(); }, [entitlements, refreshEntitlements]);

  const captured = useRef(false);
  useEffect(() => {
    if (checkout !== 'success' || captured.current) return;
    const orderId = params.get('token');
    if (!orderId) return;
    captured.current = true;
    client.paypalCapture(orderId).catch(() => { /* poll still runs; webhook is the backstop */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout]);

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

  useEffect(() => {
    if (phase === 'activating' && baseline.current != null && entitlements
        && tierIndex(entitlements.tier) > baseline.current) {
      setPhase('done');
    }
  }, [entitlements, phase]);

  async function openConfirm(tier: EntitlementTier) {
    if (tier === 'free' || busyTier) return;
    setConfirmTier(tier);
    if (acctEmail === undefined) {
      try { const a = await client.account(); setAcctEmail(a.guardian?.email ?? null); }
      catch { setAcctEmail(null); }
    }
  }

  async function proceedToPayPal() {
    const tier = confirmTier;
    if (!tier || tier === 'free' || busyTier) return;
    setBusyTier(tier);
    try {
      const order = await client.paypalCreateOrder(tier as 't50' | 't250' | 't500');
      window.location.href = order.url;
    } catch (e) {
      setBusyTier(null);
      setConfirmTier(null);
      flash((e as Error).message || 'Could not start checkout. Please try again.');
    }
  }

  const current: EntitlementTier = entitlements?.tier ?? 'free';
  const curIdx = tierIndex(current);
  const confirmInfo = confirmTier ? TIER_CATALOG[confirmTier] : null;

  return (
    <>
      <AppBar title="My Plan" sub="Your membership & upgrades" back wide />
      <div className="plan-wrap stack">
        <div className="stack" style={{ maxWidth: 760, width: '100%', margin: '0 auto' }}>
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
          <Card className="stack"><strong>🎉 You're upgraded!</strong>
            <div className="muted" style={{ fontSize: 13 }}>Your new plan is active. Enjoy your unlocked practice.</div>
          </Card>
        )}
        {phase === 'timeout' && (
          <Card className="stack"><strong>Almost there…</strong>
            <div className="muted" style={{ fontSize: 13 }}>Your payment is being confirmed. This can take a moment.</div>
            <button className="btn small secondary" onClick={() => { baseline.current = null; setPhase('activating'); }}>Check again</button>
          </Card>
        )}
        {phase === 'canceled' && (
          <Card className="stack"><strong>Checkout canceled</strong>
            <div className="muted" style={{ fontSize: 13 }}>No payment was made. You can pick a plan again whenever you're ready.</div>
          </Card>
        )}
        </div>

        {/* Pricing page (indigo/Inter design, namespaced 'pp-'). */}
        <div className="planpage">
          <header className="pp-header">
            <div className="pp-eyebrow">Concept Mastery Membership</div>
            <h1 className="pp-h1">Choose the right plan for your child</h1>
            <p className="pp-subtitle">Start free, choose Standard for individual practice, upgrade to Plus for full battery tests and timed exams, or choose Premium for everything plus live 1-on-1 mentoring.</p>
          </header>

          <section className="pp-plans" aria-label="Membership plans">
            {TIER_SEQUENCE.map((t) => {
              const info = TIER_CATALOG[t];
              const ti = tierIndex(t);
              const isCurrent = t === current;
              const isUpgrade = ti > curIdx;
              return (
                <article key={t} className={`pp-card${info.badge ? ' premium' : ''}`}>
                  {info.badge && <div className="pp-badge">{info.badge}</div>}
                  <div className="pp-name">{info.name}</div>
                  <div className="pp-price-row"><span className="pp-price">{info.price}</span><span className="pp-currency">CAD</span></div>
                  {info.accessTerm && <p className="pp-term">{info.accessTerm}</p>}
                  {info.desc && <p className="pp-desc">{info.desc}</p>}
                  <div className="pp-divider" />
                  <ul className="pp-list">
                    {info.features.map((f) => (
                      <li key={f} className="pp-li"><span className="pp-check">✓</span><span>{f}</span></li>
                    ))}
                  </ul>
                  {isCurrent ? (
                    <button className="pp-btn secondary" type="button" disabled>Current Plan</button>
                  ) : isUpgrade ? (
                    <button className="pp-btn primary" type="button" disabled={busyTier != null} onClick={() => openConfirm(t)}>
                      {busyTier === t ? 'Redirecting…' : `Get ${info.name} — ${info.priceLabel}`}
                    </button>
                  ) : (
                    <button className="pp-btn secondary" type="button" disabled>Included</button>
                  )}
                </article>
              );
            })}
          </section>

          <p className="pp-foot">Prices shown in CAD. Standard, Plus and Premium include 12 months of access from the date of purchase. Mentoring sessions are scheduled separately by Concept Mastery.</p>
        </div>
      </div>

      {/* Confirm-email modal (between a plan click and PayPal). */}
      {confirmTier && confirmInfo && (
        <div
          role="dialog" aria-modal="true" aria-label="Confirm your plan"
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
            <h3 style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 21, margin: '0 0 8px', textAlign: 'center' }}>Confirm your plan</h3>
            <p style={{ fontSize: 14, fontWeight: 700, color: '#4a4f66', lineHeight: 1.55, margin: '0 0 14px', textAlign: 'center' }}>
              You're purchasing this plan for{acctEmail ? <> <strong style={{ color: '#3e7bee' }}>{acctEmail}</strong></> : ' your account'}.
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
                {busyTier ? 'Redirecting…' : 'Pay Now'}
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
