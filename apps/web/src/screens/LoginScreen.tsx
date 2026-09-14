import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '@ccat/api-client';
import { client, getDeviceHash } from '../lib/api';
import { useApp } from '../lib/store';
import cmWordmark from '../assets/cm-wordmark.png';
import '../landing.css';

// Login (route "/login"). Navy split panel matching the landing page. The 4-digit PIN is shown as four
// boxes backed by ONE hidden numeric input, so `pin` stays the single source of truth for submit.
export function LoginScreen() {
  const nav = useNavigate();
  const { setProfile, flash } = useApp();
  const [username, setUsername] = useState(''); // holds a username OR a parent email
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const [showPin, setShowPin] = useState(false);
  // When an entered email maps to MORE THAN ONE child, offer a picker (PIN is per-child).
  const [pickList, setPickList] = useState<string[] | null>(null);
  const [chosen, setChosen] = useState<string>('');

  const isEmail = (v: string) => /^\S+@\S+\.\S+$/.test(v);

  // Typing in the identifier field invalidates any pending child pick.
  function onIdentifierChange(v: string) {
    setUsername(v.toLowerCase());
    if (pickList) { setPickList(null); setChosen(''); }
  }

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const id = username.trim();
      let uname = id;
      if (isEmail(id)) {
        if (chosen) {
          uname = chosen; // already picked from the multi-child list
        } else {
          const r = await client.accountByEmail(id);
          const first = r.usernames[0];
          if (!r.exists || !first) { setErr('No account found for that email.'); setBusy(false); return; }
          if (r.usernames.length > 1) { setPickList(r.usernames); setChosen(first); setBusy(false); return; }
          uname = first;
        }
      }
      await client.login(uname, pin, getDeviceHash());
      const me = await client.profile();
      setProfile(me);
      flash('Welcome back! 👋');
      let dest = '/home';
      try { const r = sessionStorage.getItem('cmPostAuthRedirect'); if (r) { dest = r; sessionStorage.removeItem('cmPostAuthRedirect'); } } catch { /* ignore */ }
      nav(dest, { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? (e.code === 'UNAUTHORIZED' ? 'Wrong username/email or PIN.' : e.message) : (e as Error).message);
    } finally { setBusy(false); }
  }

  const canSubmit = !!username && pin.length === 4 && !busy;

  return (
    <div className="a2-split">
      <aside className="a2-brand">
        <span className="a2-circ" style={{ width: 260, height: 260, top: -90, right: -70 }} />
        <span className="a2-circ" style={{ width: 150, height: 150, bottom: 20, left: -50 }} />
        <div className="a2-logochip"><img src={cmWordmark} alt="Concept Mastery — Quality Education" /></div>
        <div className="a2-quote">Welcome back, <span>champion.</span></div>
        <ul className="a2-trust">
          <li>✔ Grades 2–5 · CCAT / NGAT</li>
          <li>✔ Trusted by 500+ parents</li>
          <li>✔ PIPEDA-compliant</li>
        </ul>
        <div className="a2-by">— CCAT Practice by Concept Mastery</div>
      </aside>
      <div className="a2-form">
        <div className="a2-inner">
          <Link className="a2-back" to="/">← Back to home</Link>
          <h1>Welcome back 👋</h1>
          <p className="a2-sub">Enter your username or parent email, and the 4-digit PIN.</p>
          {err && <div className="err" role="alert">{err}</div>}
          <div className="field">
            <label>Username or email</label>
            <input className="input" value={username} autoCapitalize="none" inputMode="email"
              placeholder="childD  or  parent@email.com"
              onChange={(e) => onIdentifierChange(e.target.value)} />
          </div>
          {pickList && (
            <div className="field">
              <label>Who’s signing in?</label>
              <div style={{ background: '#eaf1fb', border: '1px solid #cfe0f6', borderRadius: 12, padding: 8 }}>
                {pickList.map((u) => (
                  <label key={u} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', background: chosen === u ? '#fff' : 'transparent',
                    border: `2px solid ${chosen === u ? '#1A5EAB' : 'transparent'}`, borderRadius: 10, cursor: 'pointer', marginBottom: 4, fontWeight: 700 }}>
                    <input type="radio" name="whichchild" checked={chosen === u} onChange={() => setChosen(u)} />
                    {u}
                  </label>
                ))}
              </div>
              <div className="a2-sub" style={{ marginTop: 6, fontSize: 12.5 }}>This email has more than one child — pick one, then enter that child’s PIN.</div>
            </div>
          )}
          <div className="field">
            <label>Secret PIN</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="pin-entry" onClick={() => pinRef.current?.focus()}>
                <div className="boxes">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className={`pin-box${pin.length > i ? ' filled' : ''}${pin.length === i ? ' active' : ''}`}>{pin[i] ? (showPin ? pin[i] : '•') : ''}</div>
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
              <button type="button" onClick={() => setShowPin((v) => !v)} aria-pressed={showPin} aria-label={showPin ? 'Hide PIN' : 'Show PIN'} title={showPin ? 'Hide PIN' : 'Show PIN'}
                style={{ background: 'transparent', border: 0, cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 6 }}>
                {showPin ? '🙈' : '👁️'}
              </button>
            </div>
          </div>
          <button className="a2-btn gold" disabled={!canSubmit} onClick={submit}>Let me in! 🔓</button>
          <div className="a2-links"><Link to="/recovery">Forgot PIN?</Link></div>
          <div className="a2-foot">New here? <Link to="/register">Create an account</Link></div>
        </div>
      </div>
    </div>
  );
}
