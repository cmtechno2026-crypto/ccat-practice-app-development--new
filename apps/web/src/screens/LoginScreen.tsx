import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '@ccat/api-client';
import { client, getDeviceHash } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Field } from '../components/ui';

export function LoginScreen() {
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const { setProfile, flash } = useApp();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await client.login(username, pin, getDeviceHash());
      const me = await client.profile();
      setProfile(me);
      flash('Welcome back! 👋');
      nav(loc.state?.from ?? '/home', { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? (e.code === 'UNAUTHORIZED' ? 'Wrong username or PIN.' : e.message) : (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <>
      <AppBar title="Welcome back 👋" sub="Log in with your username and PIN" back />
      <div className="content center-narrow">
        <div className="stack">
          {err && <div className="err" role="alert">{err}</div>}
          <Field label="Username"><input className="input" value={username} autoCapitalize="none" onChange={(e) => setUsername(e.target.value.toLowerCase())} /></Field>
          <Field label="Secret PIN"><input className="input" type="password" inputMode="numeric" maxLength={4} value={pin} placeholder="••••" onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
          <button className="btn" disabled={!username || pin.length !== 4 || busy} onClick={submit}>Let me in! 🔓</button>
          <div className="between">
            <Link className="hint" to="/recovery">Forgot PIN?</Link>
            <Link className="hint" to="/device">New device?</Link>
          </div>
          <p className="hint">New here? <Link to="/register">Create an account</Link></p>
        </div>
      </div>
    </>
  );
}
