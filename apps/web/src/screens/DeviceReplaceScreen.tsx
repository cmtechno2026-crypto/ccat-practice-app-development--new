import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Channel } from '@ccat/api-client';
import { ApiError } from '@ccat/api-client';
import { client, getDeviceHash } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Field } from '../components/ui';

// Single-device model (Blueprint §5): enrol THIS browser as the student's active device by
// verifying a guardian code. The previous device is superseded server-side.
export function DeviceReplaceScreen() {
  const nav = useNavigate();
  const { setProfile, flash } = useApp();
  const [step, setStep] = useState<'start' | 'verify'>('start');
  const [username, setUsername] = useState('');
  const [channel, setChannel] = useState<Channel>('email');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function guard<T>(fn: () => Promise<T>) {
    setBusy(true); setErr(null);
    try { return await fn(); } catch (e) { setErr(e instanceof ApiError ? e.message : (e as Error).message); return null; } finally { setBusy(false); }
  }
  async function start() {
    const r = await guard(() => client.deviceReplacementStart(username, getDeviceHash(), channel));
    if (r) { setChallengeId(r.challenge_id); setDevCode((r as any)._dev_code ?? null); setStep('verify'); }
  }
  async function verify() {
    if (!challengeId) return;
    const ok = await guard(async () => { await client.deviceReplacementVerify(challengeId, code); return client.profile(); });
    if (ok) { setProfile(ok); flash('This device is now enrolled.'); nav('/home', { replace: true }); }
  }

  return (
    <>
      <AppBar title="New device" sub="Enrol this browser" back />
      <div className="content center-narrow stack">
        {err && <div className="err" role="alert">{err}</div>}
        {step === 'start' && (
          <>
            <p className="muted">Moving to a new device? Verify with a parent code to enrol it.</p>
            <Field label="Username"><input className="input" value={username} autoCapitalize="none" onChange={(e) => setUsername(e.target.value.toLowerCase())} /></Field>
            <div className="row">
              <button className={`btn small ${channel === 'email' ? '' : 'secondary'}`} onClick={() => setChannel('email')}>Email</button>
              <button className={`btn small ${channel === 'sms' ? '' : 'secondary'}`} onClick={() => setChannel('sms')}>SMS</button>
            </div>
            <button className="btn" disabled={!username || busy} onClick={start}>Send code</button>
          </>
        )}
        {step === 'verify' && (
          <>
            <p className="muted">Enter the parent code.{devCode ? ` (dev code: ${devCode})` : ''}</p>
            <Field label="Code"><input className="input" value={code} inputMode="numeric" onChange={(e) => setCode(e.target.value)} /></Field>
            <button className="btn" disabled={code.length < 4 || busy} onClick={verify}>Enrol device</button>
          </>
        )}
      </div>
    </>
  );
}
