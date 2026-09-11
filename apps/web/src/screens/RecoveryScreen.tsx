import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { Field } from '../components/ui';
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
    if (newPin !== confirmPin) { setErr("Those PINs don't match — please re-enter."); return; }
    setBusy(true); setErr(null);
    try {
      await client.pinResetComplete(email.trim(), code.trim(), newPin);
      flash('PIN reset — log in with your new PIN.');
      nav('/login', { replace: true });
    } catch (e) {
      const c = e instanceof ApiError ? e.code : '';
      setErr(c === 'RATE_LIMITED'
        ? "Too many attempts. Please wait a few minutes and try again."
        : "That code didn't work. Check the code from your email — codes expire after a few minutes.");
    } finally { setBusy(false); }
  }

  const pinOk = newPin.length === 4 && confirmPin.length === 4;

  return (
    <div className="a2-split">
      <aside className="a2-brand">
        <span className="a2-circ" style={{ width: 260, height: 260, top: -90, right: -70 }} />
        <span className="a2-circ" style={{ width: 150, height: 150, bottom: 20, left: -50 }} />
        <div className="a2-logochip"><img src={cmWordmark} alt="Concept Mastery — Quality Education" /></div>
        <div className="a2-quote">Forgot your PIN? <span>We'll help.</span></div>
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
          <h1>Recover PIN</h1>
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
              <p className="muted">If that email is registered, we've emailed the username and a reset code. Enter the code and choose a new PIN.</p>
              {devCodes.length > 0 && <div className="hint">dev codes: {devCodes.map((d) => `${d.username}:${d.code}`).join(', ')}</div>}
              <Field label="Reset code"><input className="input" value={code} inputMode="numeric" onChange={(e) => setCode(e.target.value)} /></Field>
              <Field label="Create new PIN"><input className="input" value={newPin} inputMode="numeric" maxLength={4} placeholder="••••" onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
              <Field label="Confirm new PIN"><input className="input" value={confirmPin} inputMode="numeric" maxLength={4} placeholder="••••" onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
              <button className="a2-btn gold" disabled={code.trim().length < 4 || !pinOk || busy} onClick={complete}>{busy ? 'Setting…' : 'Set new PIN'}</button>
            </>
          )}
          <div className="a2-foot">Remembered it? <Link to="/login">Log in</Link></div>
        </div>
      </div>
    </div>
  );
}
