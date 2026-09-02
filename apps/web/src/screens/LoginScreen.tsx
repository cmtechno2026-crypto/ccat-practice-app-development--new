import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '@ccat/api-client';
import { client, getDeviceHash } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Field } from '../components/ui';

export function LoginScreen() {
  const nav = useNavigate();
  const { setProfile, flash } = useApp();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await client.login(username, pin, getDeviceHash());
      const me = await client.profile();
      setProfile(me);
      flash('Welcome back! 👋');
      // Always land on Home after a fresh sign-in — ignore any attempted/previous URL (history replace so
      // the login page and the old protected page are not left in the back-stack).
      nav('/home', { replace: true });
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
          <Field label="Secret PIN">
            <div style={{ position: 'relative' }}>
              <input className="input" type={showPin ? 'text' : 'password'} inputMode="numeric" maxLength={4} value={pin} placeholder="••••" style={{ paddingRight: 44 }} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} />
              <button type="button" onClick={() => setShowPin((s) => !s)} aria-label={showPin ? 'Hide PIN' : 'Show PIN'} aria-pressed={showPin} title={showPin ? 'Hide PIN' : 'Show PIN'}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 4 }}>
                {showPin ? '🙈' : '👁️'}
              </button>
            </div>
          </Field>
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
