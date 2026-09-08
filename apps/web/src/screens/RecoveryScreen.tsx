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
  const [username, setUsername] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function guard<T>(fn: () => Promise<T>) {
    setBusy(true); setErr(null);
    try { return await fn(); } catch (e) { setErr(e instanceof ApiError ? e.message : (e as Error).message); return null; } finally { setBusy(false); }
  }
  // The reset code is always emailed to the parent on file. SMS is temporarily disabled — when it
  // returns, restore the Email/SMS toggle and pass the chosen channel to pinResetStart.
  async function start() {
    setBusy(true); setErr(null);
    try {
      const r = await client.pinResetStart(username, 'email');
      setChallengeId(r.challenge_id); setDevCode((r as any)._dev_code ?? null); setStep('complete');
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setErr(code === 'RATE_LIMITED'
        ? "Too many requests. Please wait a few minutes and try again."
        : "We couldn't email your reset code right now. Please try again in a few minutes, or contact support.");
    } finally { setBusy(false); }
  }
  async function complete() {
    if (!challengeId) return;
    const r = await guard(() => client.pinResetComplete(challengeId, code, newPin));
    if (r) { flash('PIN reset — log in with your new PIN.'); nav('/login', { replace: true }); }
  }

  return (
    <>
      <AppBar title="Recover PIN" sub="Verify with a parent code" back />
      <div className="content center-narrow stack">
        {err && <div className="err" role="alert">{err}</div>}
        {step === 'start' && (
          <>
            <Field label="Username"><input className="input" value={username} autoCapitalize="none" onChange={(e) => setUsername(e.target.value.toLowerCase())} /></Field>
            <p className="hint">We'll email a reset code to the parent on file.</p>
            <button className="btn" disabled={!username || busy} onClick={start}>Send reset code</button>
          </>
        )}
        {step === 'complete' && (
          <>
            <p className="muted">Enter the code sent to the parent.{devCode ? ` (dev code: ${devCode})` : ''}</p>
            <Field label="Code"><input className="input" value={code} inputMode="numeric" onChange={(e) => setCode(e.target.value)} /></Field>
            <Field label="New PIN"><input className="input" value={newPin} inputMode="numeric" maxLength={4} placeholder="••••" onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
            <button className="btn" disabled={code.length < 4 || newPin.length !== 4 || busy} onClick={complete}>Set new PIN</button>
          </>
        )}
      </div>
    </>
  );
}
