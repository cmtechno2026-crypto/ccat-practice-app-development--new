import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@ccat/api-client';
import { client, getDeviceHash } from '../lib/api';
import { useApp } from '../lib/store';
import { TIER_CATALOG, tierIndex } from '../lib/entitlements';
import { PAYPAL_INCONTEXT } from '../lib/paypal';
import { usePromo, discountPrice, withHstDisplay } from '../lib/promo';
import { PayPalButtonsBox } from './PayPalButtonsBox';

// Landing-page checkout modal. Opened by a "Get <plan>" button on the public landing (WelcomeScreen).
// Fewest-clicks flow that guarantees the plan activates in both cases:
//
//  Step 1 (email): the parent enters their email. We branch on whether it already has an account.
//   • Case 1 — account exists → show the userID(s) prefilled + PIN. On login we hold a session, create the
//     AUTHED PayPal order, and redirect. Return lands on /plan?checkout=success (captures + shows upgraded).
//   • Case 2 — no account → email OTP → verify → create a PUBLIC order for the verified email → redirect.
//     Return lands on /register?checkout=success, which captures and prefills the verified email so the
//     parent just finishes the account. The entitlement is written against the email and attaches on signup.
//
// The gateway owns the amount, eligibility and return URLs; the client sends only tier / email / OTP token.

type Sellable = 't50' | 't250' | 't500';
type Step = 'email' | 'login' | 'otp' | 'pay';
// Which PayPal order to create on the 'pay' step: an AUTHED order (Case 1, after login) or a PUBLIC
// order tied to the OTP-verified email (Case 2). Only used when PAYPAL_INCONTEXT is on.
type PayFlow = { kind: 'auth' } | { kind: 'public'; email: string; token: string };

const CK_EMAIL = 'cmCheckoutEmail';
const CK_TOKEN = 'cmCheckoutEmailToken';
const CK_TIER = 'cmCheckoutTier';

export function PlanCheckoutModal({ tier, onClose }: { tier: Sellable; onClose: () => void }) {
  const { setProfile } = useApp();
  const nav = useNavigate();
  const info = TIER_CATALOG[tier];
  // Live site promo: when active, show (and charge) the discounted price everywhere this modal shows a
  // price. disc.newStr is the discounted amount; disc.oldStr the struck original. The gateway independently
  // charges the same discounted amount, so this display matches what PayPal bills.
  const promo = usePromo();
  const disc = promo.active ? discountPrice(info.price, promo.percent) : null;
  // Effective pre-tax price (after any live promo), then + 13% HST. hst.total is what PayPal actually
  // charges, so every "pay" label and the box total use it; the gateway computes the same number.
  const subtotalStr = disc ? disc.newStr : info.price;
  const hst = withHstDisplay(subtotalStr);
  const payLabel = hst ? `${hst.total} CAD` : (disc ? `${disc.newStr} CAD` : info.priceLabel);

  const [step, setStep] = useState<Step>('email');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [payFlow, setPayFlow] = useState<PayFlow | null>(null);

  const [email, setEmail] = useState('');
  const [usernames, setUsernames] = useState<string[]>([]);
  const [username, setUsername] = useState('');
  const [currentTier, setCurrentTier] = useState<'free' | 't50' | 't250' | 't500'>('free');
  // The account already has this tier or higher → nothing to sell; the button becomes "Log in".
  const alreadyHas = tierIndex(currentTier) >= tierIndex(tier);
  const [pin, setPin] = useState('');
  const [otp, setOtp] = useState('');
  const [otpErr, setOtpErr] = useState<string | null>(null); // inline error under the code field
  const [resendIn, setResendIn] = useState(0);

  const emailValid = /^\S+@\S+\.\S+$/.test(email.trim());
  const normEmail = email.trim().toLowerCase();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  useEffect(() => {
    if (step !== 'otp' || resendIn <= 0) return;
    const id = window.setInterval(() => setResendIn((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => window.clearInterval(id);
  }, [step, resendIn]);

  function msg(e: unknown, fallback: string): string {
    if (e instanceof ApiError) {
      if (e.code === 'RATE_LIMITED') return 'Too many attempts — wait a few minutes.';
      if (e.code === 'UNAUTHORIZED') return step === 'login' ? 'Wrong username or password.' : e.message;
      return e.message || fallback;
    }
    return (e as Error)?.message || fallback;
  }

  // Step 1 → branch on account existence.
  async function continueFromEmail() {
    if (!emailValid || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await client.accountByEmail(normEmail);
      if (r.exists && r.usernames.length > 0) {
        setUsernames(r.usernames);
        setUsername(r.usernames[0] ?? '');
        setCurrentTier(r.currentTier ?? 'free');
        setStep('login');
      } else {
        await client.registrationEmailRequest(normEmail);
        setResendIn(45);
        setStep('otp');
      }
    } catch (e) {
      // An email tied to a live account can't be code-verified (Case 2) — send them to log in.
      if (e instanceof ApiError && e.code === 'EMAIL_IN_USE') {
        try {
          const r = await client.accountByEmail(normEmail);
          setUsernames(r.usernames); setUsername(r.usernames[0] ?? ''); setCurrentTier(r.currentTier ?? 'free'); setStep('login');
        } catch { setErr('This email already has an account — please log in.'); }
      } else {
        setErr(msg(e, "Couldn't continue. Please try again."));
      }
    } finally { setBusy(false); }
  }

  // Case 1 — log in. If the account already has this plan (or higher) there's nothing to buy: set the
  // profile so the landing routes into the app (/home). Otherwise go STRAIGHT to PayPal — we deliberately
  // do NOT set the profile here, because that would redirect the landing to /home before the PayPal
  // redirect fires (the "visits home in between" flash the user saw).
  async function loginSubmit() {
    if (!username || pin.length < 4 || pin.length > 8 || busy) return;
    setBusy(true); setErr(null);
    try {
      await client.login(username, pin, getDeviceHash());
      if (alreadyHas) {
        const me = await client.profile();
        setProfile(me);
        return; // landing sees a profile and navigates to /home; keep busy while it unmounts
      }
      // In-context popup: stay in the modal and render the PayPal buttons (session is now held).
      if (PAYPAL_INCONTEXT) {
        setPayFlow({ kind: 'auth' });
        setStep('pay');
        setBusy(false);
        return;
      }
      // Fallback (no client id): full redirect. Return straight to Home after PayPal (capture happens there).
      const order = await client.paypalCreateOrder(tier, 'home');
      window.location.href = order.url; // leaves the page; keep busy so the button stays disabled
    } catch (e) {
      setErr(msg(e, 'Could not start checkout. Please try again.'));
      setBusy(false);
    }
  }

  // Case 2 — verify the code, then create the public order for the verified email and redirect to PayPal.
  async function verifyAndPay() {
    if (otp.length !== 6 || busy) return;
    setBusy(true); setErr(null); setOtpErr(null);
    // Step A: confirm the OTP. A wrong/expired code shows inline under the code field, not the top banner.
    let conf: { email: string; token: string };
    try {
      conf = await client.registrationEmailConfirm(normEmail, otp);
    } catch (e) {
      setOtpErr(e instanceof ApiError && e.code === 'RATE_LIMITED'
        ? 'Too many attempts — wait a few minutes.'
        : 'Invalid OTP');
      setBusy(false);
      return;
    }
    // Step B: persist the verified email/token so /register can prefill after payment, then pay.
    try {
      sessionStorage.setItem(CK_EMAIL, conf.email);
      sessionStorage.setItem(CK_TOKEN, conf.token);
      sessionStorage.setItem(CK_TIER, tier);
    } catch { /* private mode — register can still capture via the URL order id */ }

    // In-context popup: stay in the modal and render the PayPal buttons for the public order.
    if (PAYPAL_INCONTEXT) {
      setPayFlow({ kind: 'public', email: conf.email, token: conf.token });
      setStep('pay');
      setBusy(false);
      return;
    }
    // Fallback (no client id): full redirect to PayPal.
    try {
      const order = await client.paypalCreateOrderPublic(conf.email, tier, conf.token);
      window.location.href = order.url; // leaves the page; keep busy so the button stays disabled
    } catch (e) {
      setErr(msg(e, 'Could not start checkout. Please try again.'));
      setBusy(false);
    }
  }

  // ---- In-context popup handlers (only used on the 'pay' step) --------------------------------------
  // Create the correct order for the current flow and hand PayPal the order id.
  async function createPayOrder(): Promise<string> {
    if (payFlow?.kind === 'public') {
      const o = await client.paypalCreateOrderPublic(payFlow.email, tier, payFlow.token);
      return o.id;
    }
    const o = await client.paypalCreateOrder(tier, 'home');
    return o.id;
  }

  // Capture the approved order, then continue: Case 1 → into the app (Home); Case 2 → account creation.
  async function onPayApproved(orderId: string) {
    setErr(null);
    if (payFlow?.kind === 'public') {
      await client.paypalCapturePublic(orderId);
      nav('/register?checkout=success'); // email is prefilled + verified from sessionStorage
      return;
    }
    await client.paypalCapture(orderId);
    const me = await client.profile();
    setProfile(me); // landing sees a profile and routes into the app (/home)
  }

  async function resend() {
    if (resendIn > 0 || busy) return;
    setBusy(true); setErr(null);
    try { await client.registrationEmailRequest(normEmail); setResendIn(45); setOtp(''); setOtpErr(null); }
    catch (e) { setErr(msg(e, "Couldn't resend the code.")); }
    finally { setBusy(false); }
  }

  const S = {
    overlay: { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(20,24,40,.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } as const,
    card: { position: 'relative', width: 'min(420px,94%)', background: '#fff', borderRadius: 18,
      boxShadow: '0 24px 60px -24px rgba(42,46,67,.55)', padding: '26px 24px',
      fontFamily: "'Nunito', system-ui, sans-serif", color: '#2a2e43' } as const,
    x: { position: 'absolute', right: 12, top: 8, background: 'transparent', border: 'none',
      color: '#8a90a6', fontSize: 20, fontWeight: 800, cursor: 'pointer' } as const,
    h3: { fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 21, margin: '2px 0 6px', textAlign: 'center' } as const,
    sub: { fontSize: 14, fontWeight: 700, color: '#4a4f66', lineHeight: 1.5, margin: '0 0 14px', textAlign: 'center' } as const,
    planRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: '#eaf1fb', borderRadius: 12, padding: '11px 14px', marginBottom: 16 } as const,
    label: { display: 'block', fontSize: 12.5, fontWeight: 800, color: '#4a4f66', margin: '0 0 5px' } as const,
    input: { width: '100%', padding: '12px 14px', border: '2px solid #dfe4ee', borderRadius: 12,
      font: 'inherit', fontWeight: 700, color: '#2a2e43', background: '#fff', boxSizing: 'border-box' } as const,
    code: { letterSpacing: 6, textAlign: 'center', fontSize: 20 } as const,
    payBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 16, border: 'none',
      borderRadius: 14, padding: '13px 18px', width: '100%', cursor: 'pointer',
      background: '#ffc439', color: '#003087' } as const,
    blueBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 16, border: 'none',
      borderRadius: 14, padding: '13px 18px', width: '100%', cursor: 'pointer',
      background: '#1A5EAB', color: '#fff' } as const,
    link: { background: 'transparent', border: 'none', color: '#8a90a6',
      fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 15, padding: 10, cursor: 'pointer' } as const,
    err: { background: '#fdecec', color: '#c0392b', borderRadius: 10, padding: '9px 12px',
      fontSize: 13, fontWeight: 700, margin: '0 0 12px' } as const,
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Checkout" style={S.overlay}
      onClick={() => { if (!busy) onClose(); }}>
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        <button aria-label="Close" style={S.x} onClick={() => { if (!busy) onClose(); }}>✕</button>
        <div style={{ width: 54, height: 54, borderRadius: 16, background: '#eaf1fb', display: 'flex',
          alignItems: 'center', justifyContent: 'center', fontSize: 28, margin: '0 auto 10px' }}>💳</div>

        <div style={S.planRow}>
          <span style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 15 }}>{info.name} plan</span>
          <span style={{ fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 15, color: '#1A5EAB' }}>
            {disc ? `${disc.newStr} CAD` : info.priceLabel}
            {disc && <span style={{ textDecoration: 'line-through', opacity: 0.5, fontWeight: 700, marginLeft: 6 }}>{disc.oldStr}</span>}
          </span>
        </div>

        {hst && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13,
              color: '#5b6b86', padding: '4px 2px 0' }}>
              <span>HST (13%)</span>
              <span>{hst.tax} CAD</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between',
              fontFamily: "'Baloo 2', sans-serif", fontWeight: 800, fontSize: 15, color: '#1A5EAB',
              borderTop: '1px solid #e7eaf3', marginTop: 6, paddingTop: 6 }}>
              <span>Total</span>
              <span>{hst.total} CAD</span>
            </div>
          </>
        )}

        {err && <div style={S.err} role="alert">{err}</div>}

        {step === 'email' && (
          <>
            <h3 style={S.h3}>Start your child’s plan</h3>
            <p style={S.sub}>Enter your email to log in or create an account.</p>
            <label style={S.label}>Parent email</label>
            <input style={S.input} type="email" inputMode="email" autoFocus value={email}
              placeholder="parent@email.com"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') continueFromEmail(); }} />
            <div style={{ height: 12 }} />
            <button style={{ ...S.blueBtn, opacity: emailValid && !busy ? 1 : 0.6 }}
              disabled={!emailValid || busy} onClick={continueFromEmail}>
              {busy ? 'Checking…' : 'Continue →'}
            </button>
          </>
        )}

        {step === 'login' && (
          <>
            <h3 style={S.h3}>Welcome back 👋</h3>
            <p style={S.sub}>{alreadyHas
              ? 'You already have this plan — just log in to continue.'
              : `Log in to buy the ${info.name} plan for your account.`}</p>
            <label style={S.label}>Username</label>
            {usernames.length > 1 ? (
              <select style={S.input} value={username} onChange={(e) => setUsername(e.target.value)}>
                {usernames.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            ) : (
              <input style={S.input} value={username} readOnly aria-readonly="true" />
            )}
            <div style={{ height: 12 }} />
            <label style={S.label}>Password</label>
            <input style={S.input} type="password" autoComplete="current-password"
              maxLength={8} autoFocus value={pin} placeholder="Your password"
              onChange={(e) => setPin(e.target.value.slice(0, 8))}
              onKeyDown={(e) => { if (e.key === 'Enter') loginSubmit(); }} />
            <div style={{ fontSize: 12, color: '#8a90a6', fontWeight: 700, marginTop: 6 }}>Existing families: your 4-digit PIN still works.</div>
            <div style={{ height: 14 }} />
            <button style={{ ...(alreadyHas ? S.blueBtn : S.payBtn), opacity: username && pin.length >= 4 && pin.length <= 8 && !busy ? 1 : 0.6 }}
              disabled={!username || pin.length < 4 || pin.length > 8 || busy} onClick={loginSubmit}>
              {busy ? 'Please wait…' : alreadyHas ? 'Log in' : `Log in & pay ${payLabel}`}
            </button>
            <div style={{ textAlign: 'center', marginTop: 6, fontSize: 12.5, color: '#8a90a6', fontWeight: 700 }}>
              Not you? <button style={{ ...S.link, display: 'inline', padding: 0, fontSize: 12.5, color: '#1A5EAB' }}
                onClick={() => { if (!busy) { setStep('email'); setPin(''); setErr(null); } }}>Use a different email</button>
            </div>
          </>
        )}

        {step === 'otp' && (
          <>
            <h3 style={S.h3}>Verify your email</h3>
            <p style={S.sub}>Enter the 6-digit code we sent to <strong>{normEmail}</strong>.</p>
            <label style={S.label}>Verification code</label>
            <input style={{ ...S.input, ...S.code, ...(otpErr ? { borderColor: '#c0392b' } : {}) }}
              inputMode="numeric" autoComplete="one-time-code"
              maxLength={6} autoFocus value={otp} placeholder="••••••"
              aria-invalid={otpErr ? true : undefined}
              onChange={(e) => { setOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); if (otpErr) setOtpErr(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') verifyAndPay(); }} />
            {otpErr && <div style={{ color: '#c0392b', fontSize: 12.5, fontWeight: 800, marginTop: 6 }}>{otpErr}</div>}
            <div style={{ height: 14 }} />
            <button style={{ ...S.payBtn, opacity: otp.length === 6 && !busy ? 1 : 0.6 }}
              disabled={otp.length !== 6 || busy} onClick={verifyAndPay}>
              {busy ? 'Please wait…' : `Verify & pay ${payLabel}`}
            </button>
            <div style={{ textAlign: 'center', marginTop: 8, fontSize: 12.5, color: '#8a90a6', fontWeight: 700 }}>
              {resendIn > 0 ? `Resend in 0:${String(resendIn).padStart(2, '0')}` : (
                <button style={{ ...S.link, display: 'inline', padding: 0, fontSize: 12.5, color: '#1A5EAB' }}
                  onClick={resend}>Resend code</button>
              )}
            </div>
          </>
        )}

        {step === 'pay' && (
          <>
            <h3 style={S.h3}>Complete your payment</h3>
            <p style={S.sub}>Pay securely with PayPal or a debit/credit card. A window will open on top of this page.</p>
            <PayPalButtonsBox
              createOrder={createPayOrder}
              onApprove={onPayApproved}
              onCancel={() => setErr('Payment was canceled. You can try again.')}
              onError={(m) => setErr(m || 'Payment could not be completed. Please try again.')}
            />
            <div style={{ textAlign: 'center', marginTop: 6 }}>
              <button style={{ ...S.link, fontSize: 12.5 }} onClick={() => { if (!busy) onClose(); }}>Cancel</button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
