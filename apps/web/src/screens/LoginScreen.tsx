import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '@ccat/api-client';
import { client, getDeviceHash } from '../lib/api';
import { useApp } from '../lib/store';
import cmLogo from '../assets/cm-logo.jpg';

// Login (route "/login"). Split brand panel matching the gateway. The 4-digit PIN is shown as four
// boxes backed by ONE hidden numeric input, so `pin` stays the single source of truth for submit.
export function LoginScreen() {
  const nav = useNavigate();
  const { setProfile, flash } = useApp();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await client.login(username, pin, getDeviceHash());
      const me = await client.profile();
      setProfile(me);
      flash('Welcome back! 👋');
      // Always land on Home after a fresh sign-in (history replace so login/old page aren't in the back-stack).
      nav('/home', { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? (e.code === 'UNAUTHORIZED' ? 'Wrong username or PIN.' : e.message) : (e as Error).message);
    } finally { setBusy(false); }
  }

  const canSubmit = !!username && pin.length === 4 && !busy;

  return (
    <div className="auth-split">
      <div className="auth-brand">
        <span className="b-circ" style={{ width: 260, height: 260, top: -90, right: -70 }} />
        <span className="b-circ" style={{ width: 150, height: 150, bottom: 20, left: -50 }} />
        <div className="b-logo"><img src={cmLogo} alt="Concept Mastery" /></div>
        <div className="b-quote">Welcome back, <span>champion.</span></div>
        <div className="b-by">— CCAT Practice by Concept Mastery</div>
      </div>
      <div className="auth-form">
        <div className="af-inner">
          <h1>Welcome back 👋</h1>
          <p className="af-sub">Enter your username and 4-digit PIN.</p>
          {err && <div className="err" role="alert">{err}</div>}
          <div className="field">
            <label>Username</label>
            <input className="input" value={username} autoCapitalize="none" onChange={(e) => setUsername(e.target.value.toLowerCase())} />
          </div>
          <div className="field">
            <label>Secret PIN</label>
            <div className="pin-entry" onClick={() => pinRef.current?.focus()}>
              <div className="boxes">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className={`pin-box${pin.length > i ? ' filled' : ''}${pin.length === i ? ' active' : ''}`}>{pin[i] ? '•' : ''}</div>
                ))}
              </div>
              <input
                ref={pinRef}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={4}
                value={pin}
                aria-label="4-digit PIN"
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) submit(); }}
              />
            </div>
          </div>
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>Let me in! 🔓</button>
          <div className="auth-links"><Link to="/recovery">Forgot PIN?</Link><Link to="/device">New device?</Link></div>
          <div className="auth-foot">New here? <Link to="/register">Create an account</Link></div>
        </div>
      </div>
    </div>
  );
}
