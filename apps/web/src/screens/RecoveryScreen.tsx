import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Field } from '../components/ui';

export function RecoveryScreen() {
  const nav = useNavigate();
  const { flash } = useApp();
  const [step, setStep] = useState<'start' | 'complete'>('start');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
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
    setBusy(true); setErr(null);
    try {
      await client.pinResetComplete(username.trim(), code.trim(), newPin);
      flash('PIN reset — log in with your new PIN.');
      nav('/login', { replace: true });
    } catch (e) {
      const c = e instanceof ApiError ? e.code : '';
      setErr(c === 'RATE_LIMITED'
        ? "Too many attempts. Please wait a few minutes and try again."
        : "That code didn't work. Check the username and code from your email — they expire after a few minutes.");
    } finally { setBusy(false); }
  }

  return (
    <>
      <AppBar title="Recover PIN" sub="Reset with a code emailed to the parent" back />
      <div className="content center-narrow stack">
        {err && <div className="err" role="alert">{err}</div>}
        {step === 'start' && (
          <>
            <Field label="Parent email"><input className="input" type="email" value={email} autoCapitalize="none" onChange={(e) => setEmail(e.target.value)} /></Field>
            <p className="hint">Enter the parent email on the account. If it's registered, we'll email the username and a reset code.</p>
            <button className="btn" disabled={!email || busy} onClick={start}>Send reset code</button>
          </>
        )}
        {step === 'complete' && (
          <>
            <p className="muted">If that email is registered, we've emailed the username and a reset code. Enter them below.</p>
            {devCodes.length > 0 && <div className="hint">dev codes: {devCodes.map((d) => `${d.username}:${d.code}`).join(', ')}</div>}
            <Field label="Username"><input className="input" value={username} autoCapitalize="none" onChange={(e) => setUsername(e.target.value.toLowerCase())} /></Field>
            <Field label="Reset code"><input className="input" value={code} inputMode="numeric" onChange={(e) => setCode(e.target.value)} /></Field>
            <Field label="New PIN"><input className="input" value={newPin} inputMode="numeric" maxLength={4} placeholder="••••" onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
            <button className="btn" disabled={!username || code.length < 4 || newPin.length !== 4 || busy} onClick={complete}>Set new PIN</button>
          </>
        )}
      </div>
    </>
  );
}
