import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { Field } from '../components/ui';
import { isWeakPin, WEAK_PIN_HINT, passwordRules, PW_MIN, PW_MAX } from '../lib/pin';
import cmWordmark from '../assets/cm-wordmark.png';
import '../landing.css';

// Recover PIN (route "/recovery"). Navy split panel matching the login page. Two states: request a
// reset code by parent email, then enter the code + choose a new PIN.
export function RecoveryScreen() {
  const nav = useNavigate();
  const { flash } = useApp();
  const [step, setStep] = useState<'start' | 'complete'>('start');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showPin, setShowPin] = useState(false);
  const [devCodes, setDevCodes] = useState<{ username: string; code: string }[]>([]);

  async function start() {
    setBusy(true); setErr(null);
    try {
      const r = await client.pinResetStart(email.trim());
      setDevCodes(((r as any)?._dev_codes as { username: string; code: string }[] | undefined) ?? []);
      setStep('complete');
    } catch (e) {
      const c = e instanceof ApiError ? e.code : '';
      setErr(c === 'RATE_LIMITED'
        ? "Too many requests. Please wait a few minutes and try again."
        : "We couldn't email your reset code right now. Please try again in a few minutes, or contact support.");
    } finally { setBusy(false); }
  }

  async function complete() {
    if (!email.trim()) { setErr('Please start again and enter your parent email.'); setStep('start'); return; }
    if (!rules.all) { setErr(`Choose a valid password — ${PW_MIN}–${PW_MAX} characters, and not too easy to guess.`); return; }
    if (newPin !== confirmPin) { setErr("Those passwords don't match — please re-enter."); return; }
    setBusy(true); setErr(null);
    try {
      await client.pinResetComplete(email.trim(), code.trim(), newPin);
      flash('Password reset — log in with your new password.');
      nav('/login', { replace: true });
    } catch (e) {
      const c = e instanceof ApiError ? e.code : '';
      setErr(c === 'RATE_LIMITED'
        ? "Too many attempts. Please wait a few minutes and try again."
        : "That code didn't work. Check the code from your email — codes expire after a few minutes.");
    } finally { setBusy(false); }
  }

  // New-password (6–8 char) rules. No child DOB is available on this screen, so only the blocklist +
  // all-same + sequential rules apply; the server additionally checks the birthday.
  const rules = passwordRules(newPin);
  const newPinWeak = newPin.length >= PW_MIN && isWeakPin(newPin);
  const pwMatch = newPin.length > 0 && newPin === confirmPin;
  const pwOk = rules.all && pwMatch;

  return (
    <div className="a2-split">
      <aside className="a2-brand">
        <span className="a2-circ" style={{ width: 260, height: 260, top: -90, right: -70 }} />
        <span className="a2-circ" style={{ width: 150, height: 150, bottom: 20, left: -50 }} />
        <div className="a2-logochip"><img src={cmWordmark} alt="Concept Mastery — Quality Education" /></div>
        <div className="a2-quote">Forgot your password? <span>We'll help.</span></div>
        <ul className="a2-trust">
          <li>✔ Reset with a code emailed to the parent</li>
          <li>✔ Codes expire after a few minutes</li>
          <li>✔ PIPEDA-compliant</li>
        </ul>
        <div className="a2-by">— CCAT Practice by Concept Mastery</div>
      </aside>
      <div className="a2-form">
        <div className="a2-inner">
          <button type="button" className="a2-back" onClick={() => nav(-1)}>‹ Back</button>
          <h1>Recover password</h1>
          <p className="a2-sub">Reset with a code emailed to the parent.</p>
          {err && <div className="err" role="alert">{err}</div>}
          {step === 'start' && (
            <>
              <Field label="Parent email"><input className="input" type="email" value={email} autoCapitalize="none" onChange={(e) => setEmail(e.target.value)} /></Field>
              <p className="hint">Enter the parent email on the account. If it's registered, we'll email the username and a reset code.</p>
              <button className="a2-btn gold" disabled={!email || busy} onClick={start}>{busy ? 'Sending…' : 'Send reset code'}</button>
            </>
          )}
          {step === 'complete' && (
            <>
              <p className="muted">If that email is registered, we've emailed the username and a reset code. Enter the code and choose a new password ({PW_MIN}–{PW_MAX} characters).</p>
              {devCodes.length > 0 && <div className="hint">dev codes: {devCodes.map((d) => `${d.username}:${d.code}`).join(', ')}</div>}
              <Field label="Reset code"><input className="input" value={code} inputMode="numeric" onChange={(e) => setCode(e.target.value)} /></Field>
              <Field label="New password" hint={newPinWeak ? WEAK_PIN_HINT : undefined} hintKind={newPinWeak ? 'bad' : undefined}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input className={`input ${newPin ? (rules.all ? 'ok' : 'bad') : ''}`} style={{ flex: 1 }} type={showPin ? 'text' : 'password'} autoComplete="new-password" maxLength={PW_MAX} placeholder={`${PW_MIN}–${PW_MAX} characters`} value={newPin} onChange={(e) => setNewPin(e.target.value.slice(0, PW_MAX))} />
                  <button type="button" onClick={() => setShowPin((v) => !v)} aria-label={showPin ? 'Hide password' : 'Show password'} title={showPin ? 'Hide password' : 'Show password'} style={{ background: 'transparent', border: 0, cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 6 }}>{showPin ? '🙈' : '👁️'}</button>
                </div>
              </Field>
              {newPin.length > 0 && (
                <ul style={{ listStyle: 'none', padding: '8px 12px', margin: '0 0 4px', background: '#eef3fc', border: '1px solid #d6e2f5', borderRadius: 11, fontSize: 12.5 }}>
                  <li style={{ color: rules.length ? '#1e7a46' : '#6b7180' }}>{rules.length ? '✓' : '•'} {PW_MIN}–{PW_MAX} characters</li>
                  <li style={{ color: '#6b7180' }}>• Letters, numbers or symbols — your choice</li>
                  <li style={{ color: rules.length ? (rules.notWeak ? '#1e7a46' : '#c8362f') : '#6b7180' }}>{rules.length ? (rules.notWeak ? '✓' : '✕') : '•'} Not an easy one (1234, repeats, or a birthday)</li>
                </ul>
              )}
              <Field label="Confirm new password" hint={confirmPin.length > 0 && !pwMatch ? "Passwords don't match" : undefined} hintKind={confirmPin.length > 0 && !pwMatch ? 'bad' : undefined}><input className={`input ${confirmPin ? (pwMatch ? 'ok' : 'bad') : ''}`} type={showPin ? 'text' : 'password'} autoComplete="new-password" maxLength={PW_MAX} placeholder="Re-enter password" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.slice(0, PW_MAX))} /></Field>
              <button className="a2-btn gold" disabled={code.trim().length < 4 || !pwOk || busy} onClick={complete}>{busy ? 'Setting…' : 'Set new password'}</button>
            </>
          )}
          <div className="a2-foot">Remembered it? <Link to="/login">Log in</Link></div>
        </div>
      </div>
    </div>
  );
}
