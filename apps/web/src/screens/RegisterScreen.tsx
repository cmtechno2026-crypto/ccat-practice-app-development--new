import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@ccat/api-client';
import { parsePhone, type CountryCode } from '../lib/phone';
import { client, getDeviceHash } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Field } from '../components/ui';

// Registration funnel (Blueprint §4). Minors-only product → the account is ALWAYS guardian-owned: a
// guardian enters name + email + phone (validated server-side). When VITE_EMAIL_VERIFY_ENABLED is on the
// guardian must ALSO verify the email with a 6-digit code before Continue (server enforces via a signed
// token when EMAIL_VERIFY_REQUIRED is on). Then consent, then the child's userID + PIN create the student.
//
// Steps: details (child + guardian, with inline validation + optional email verify) → consent → account.

type Step = 'details' | 'consent' | 'account' | 'success';
const FUNNEL: Step[] = ['details', 'consent', 'account'];
const STEP_LABEL: Record<Step, string> = { details: 'Details', consent: 'Consent', account: 'Account', success: 'Done' };
const POLICY_VERSION = '2026-01';
// Off by default. Turn on (with the gateway's EMAIL_VERIFY_REQUIRED and migration 0045 applied) once
// email delivery is live.
const EMAIL_VERIFY_ENABLED = (import.meta as any).env?.VITE_EMAIL_VERIFY_ENABLED === 'true';

const COUNTRIES: { iso: CountryCode; label: string; dial: string; flag: string }[] = [
  { iso: 'CA', label: 'Canada', dial: '+1', flag: '🇨🇦' },
  { iso: 'US', label: 'United States', dial: '+1', flag: '🇺🇸' },
  { iso: 'GB', label: 'United Kingdom', dial: '+44', flag: '🇬🇧' },
  { iso: 'IN', label: 'India', dial: '+91', flag: '🇮🇳' },
  { iso: 'AU', label: 'Australia', dial: '+61', flag: '🇦🇺' },
  { iso: 'AE', label: 'UAE', dial: '+971', flag: '🇦🇪' },
  { iso: 'PK', label: 'Pakistan', dial: '+92', flag: '🇵🇰' },
  { iso: 'NG', label: 'Nigeria', dial: '+234', flag: '🇳🇬' },
  { iso: 'SG', label: 'Singapore', dial: '+65', flag: '🇸🇬' },
  { iso: 'ZA', label: 'South Africa', dial: '+27', flag: '🇿🇦' },
];

function CountrySelect({ value, onChange }: { value: CountryCode; onChange: (c: CountryCode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = COUNTRIES.find((c) => c.iso === value) ?? COUNTRIES[0]!;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="cc-select" ref={ref}>
      <button type="button" className="input cc-trigger" aria-haspopup="listbox" aria-expanded={open}
        aria-label={`Country code (${cur.dial} ${cur.label})`} onClick={() => setOpen((o) => !o)}>
        <span className="cc-dial-sel">{cur.dial}</span>
        <span className="cc-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <ul className="cc-menu" role="listbox" aria-label="Country">
          {COUNTRIES.map((c) => (
            <li key={c.iso} role="option" aria-selected={c.iso === value}
              className={`cc-item ${c.iso === value ? 'on' : ''}`}
              onClick={() => { onChange(c.iso); setOpen(false); }}>
              <span className="cc-flag" aria-hidden>{c.flag}</span>
              <span className="cc-dial">{c.dial}</span>
              <span className="cc-name">{c.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ageFrom(y: number, m: number, d: number): number {
  const now = new Date();
  let age = now.getFullYear() - y;
  const hadBirthday = now.getMonth() + 1 > m || (now.getMonth() + 1 === m && now.getDate() >= d);
  if (!hadBirthday) age -= 1;
  return age;
}
const emailValid = (s: string) => /^\S+@\S+\.\S+$/.test(s.trim());

export function RegisterScreen() {
  const nav = useNavigate();
  const { setProfile } = useApp();
  const referralCode = (() => { try { return new URLSearchParams(window.location.search).get('ref') || undefined; } catch { return undefined; } })();

  const [step, setStep] = useState<Step>('details');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // child details
  const [displayName, setDisplayName] = useState('');
  const [birthDay, setBirthDay] = useState(1);
  const [birthMonth, setBirthMonth] = useState(1);
  const [birthYear, setBirthYear] = useState(2016);
  const [gradeId, setGradeId] = useState('');
  const [gradeList, setGradeList] = useState<{ id: string; grade_number: number; name: string }[]>([]);
  const [gradesLoading, setGradesLoading] = useState(true);
  useEffect(() => {
    let ignore = false;
    setGradesLoading(true);
    client.grades()
      .then((g: any) => {
        if (ignore) return;
        const list = (Array.isArray(g) ? g : []).filter((x: any) => Number(x?.grade_number) <= 4);
        setGradeList(list);
        if (list[0]) setGradeId((cur) => cur || list[0].id);
      })
      .catch(() => { if (!ignore) setGradeList([]); })
      .finally(() => { if (!ignore) setGradesLoading(false); });
    return () => { ignore = true; };
  }, []);

  // guardian
  const [guardianName, setGuardianName] = useState('');
  const [guardianEmail, setGuardianEmail] = useState('');
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>('CA');
  const [phoneNational, setPhoneNational] = useState('');
  const [grant, setGrant] = useState('');

  // email verification (flag-gated)
  const [otp, setOtp] = useState('');
  const [verifyStage, setVerifyStage] = useState<'idle' | 'sent' | 'verified'>('idle');
  const [emailVerifyToken, setEmailVerifyToken] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [vBusy, setVBusy] = useState(false);
  const [vErr, setVErr] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState<boolean | null>(null); // null = unknown/checking
  const otpRef = useRef<HTMLInputElement>(null);

  // consent + account
  const [consentChecked, setConsentChecked] = useState(false);
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');

  const age = ageFrom(birthYear, birthMonth, birthDay);
  const usernameValid = /^[a-z][a-z0-9_]{2,19}$/.test(username);

  const phoneObj = useMemo(() => {
    const p = parsePhone(phoneNational, phoneCountry);
    return p && p.isValid() ? p : null;
  }, [phoneNational, phoneCountry]);
  const phoneE164 = phoneObj?.number ?? '';
  const emailOk = emailValid(guardianEmail);
  const emailVerifiedOk = !EMAIL_VERIFY_ENABLED || verifyStage === 'verified';
  const emailHint: string | undefined = !guardianEmail ? undefined
    : !emailOk ? 'Enter a valid email address'
    : emailTaken === true ? '⚠ Email already registered. Try a different one.'
    : emailTaken === null ? 'Checking…'
    : '✓ Looks good';
  const emailHintKind: 'ok' | 'bad' | undefined = !guardianEmail ? undefined
    : (!emailOk || emailTaken === true) ? 'bad' : emailTaken === false ? 'ok' : undefined;
  const emailBadVisual = !!guardianEmail && (!emailOk || emailTaken === true);
  const emailOkVisual = !!guardianEmail && emailOk && emailTaken === false;
  const detailsValid = displayName.trim().length > 0 && !!gradeId && guardianName.trim().length > 0 && emailOk && !!phoneObj && emailVerifiedOk && emailTaken !== true;

  // Changing the email invalidates any prior verification.
  function onEmailChange(v: string) {
    setGuardianEmail(v);
    setEmailTaken(null);
    if (verifyStage !== 'idle' || emailVerifyToken) { setVerifyStage('idle'); setEmailVerifyToken(''); setOtp(''); setVErr(null); }
  }

  // Resend countdown.
  useEffect(() => {
    if (verifyStage !== 'sent' || resendIn <= 0) return;
    const id = window.setInterval(() => setResendIn((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => window.clearInterval(id);
  }, [verifyStage, resendIn]);

  // Debounced: is this parent email already tied to a live account? Drives the inline note + gating.
  useEffect(() => {
    if (!emailOk) { setEmailTaken(null); return; }
    let ignore = false;
    const t = window.setTimeout(async () => {
      try { const r = await client.registrationEmailAvailable(guardianEmail.trim().toLowerCase()); if (!ignore) setEmailTaken(!r.available); }
      catch { if (!ignore) setEmailTaken(null); }
    }, 450);
    return () => { ignore = true; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardianEmail, emailOk]);

  async function requestCode() {
    setVBusy(true); setVErr(null);
    try {
      await client.registrationEmailRequest(guardianEmail.trim().toLowerCase());
      setVerifyStage('sent'); setOtp(''); setResendIn(45);
      setTimeout(() => otpRef.current?.focus(), 50);
    } catch (e) {
      // Already-registered email: show the standard banner and do NOT proceed to the code step.
      if (e instanceof ApiError && e.code === 'EMAIL_IN_USE') { setEmailTaken(true); setVErr(null); setVerifyStage('idle'); }
      else setVErr(e instanceof ApiError ? (e.code === 'RATE_LIMITED' ? 'Too many requests — wait a few minutes.' : "Couldn't send the code right now. Try again shortly.") : (e as Error).message);
    } finally { setVBusy(false); }
  }
  async function confirmCode() {
    setVBusy(true); setVErr(null);
    try {
      const r = await client.registrationEmailConfirm(guardianEmail.trim().toLowerCase(), otp.trim());
      setEmailVerifyToken(r.token); setVerifyStage('verified');
    } catch (e) {
      setVErr(e instanceof ApiError ? (e.code === 'RATE_LIMITED' ? 'Too many attempts — wait a few minutes.' : 'That code is wrong or expired. Check your email or resend.') : (e as Error).message);
    } finally { setVBusy(false); }
  }

  async function guard<T>(fn: () => Promise<T>) {
    setBusy(true); setErr(null);
    try { return await fn(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : (e as Error).message); return null; }
    finally { setBusy(false); }
  }

  async function submitDetails() {
    if (!phoneE164) { setErr('Enter a valid phone number including its country code.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await client.registrationContact({ guardianName, email: guardianEmail.trim().toLowerCase(), phone: phoneE164, grant: grant || undefined, emailVerifyToken: emailVerifyToken || undefined });
      setGrant(r.registration_grant); setStep('consent');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'EMAIL_IN_USE') setEmailTaken(true); // show inline under the email, not the top banner
      else setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally { setBusy(false); }
  }
  async function acceptConsent() {
    const r = await guard(() => client.registrationConsent(grant, POLICY_VERSION, `consent:${POLICY_VERSION}`));
    if (r) { setGrant(r.registration_grant); setStep('account'); }
  }
  async function finish() {
    if (pin.length !== 4 || pin !== pin2) { setErr("PINs don't match."); return; }
    const created = await guard(() => client.registrationStudent({
      registration_grant: grant, display_name: displayName.trim(), username, grade_id: gradeId,
      birth_month: birthMonth, birth_year: birthYear, pin, device_hash: getDeviceHash(), referral_code: referralCode,
    }));
    if (!created) return;
    const me = await guard(async () => { await client.login(username, pin, getDeviceHash()); return client.profile(); });
    if (me) { setProfile(me); setStep('success'); }
  }

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return (
    <>
      <AppBar title="Create account" back />
      <div className="content center-narrow">
        <div className="stack">
          {FUNNEL.includes(step) && (
            <div className="funnel-steps" aria-label={`Step ${FUNNEL.indexOf(step) + 1} of ${FUNNEL.length}`}>
              {FUNNEL.map((s, i) => {
                const cur = FUNNEL.indexOf(step);
                return (
                  <div key={s} className={`fstep ${i < cur ? 'done' : i === cur ? 'on' : ''}`}>
                    <span className="fdot">{i < cur ? '✓' : i + 1}</span>
                    <span className="flabel">{STEP_LABEL[s]}</span>
                  </div>
                );
              })}
            </div>
          )}
          {err && <div className="err" role="alert">{err}</div>}

          {step === 'details' && (
            <>
              <div className="eyebrow">About the learner</div>
              <Field label="Child's first name"><input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Aisha" /></Field>
              <Field label="Grade">
                <select className="input" value={gradeId} onChange={(e) => setGradeId(e.target.value)} disabled={gradesLoading || gradeList.length === 0}>
                  {gradeList.length === 0 && <option value="">{gradesLoading ? 'Loading grades…' : 'No grades available'}</option>}
                  {gradeList.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </Field>
              <Field label="Date of birth">
                <div className="row">
                  <select className="input" aria-label="Birth day" value={birthDay} onChange={(e) => setBirthDay(+e.target.value)}>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <select className="input" aria-label="Birth month" value={birthMonth} onChange={(e) => setBirthMonth(+e.target.value)}>
                    {monthNames.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                  <select className="input" aria-label="Birth year" value={birthYear} onChange={(e) => setBirthYear(+e.target.value)}>
                    {Array.from({ length: 101 }, (_, i) => new Date().getFullYear() - i).map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
              </Field>
              <div className="pill" style={{ background: 'var(--tint-green)', color: 'var(--green)' }}>🎂 {Math.max(0, age)} years old</div>

              <div className="eyebrow" style={{ marginTop: 8 }}>Parent</div>
              <Field label="Parent name"><input className="input" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} placeholder="Parent full name" /></Field>
              <Field label="Parent email" hint={emailHint} hintKind={emailHintKind}>
                <input className={`input ${emailBadVisual ? 'bad' : emailOkVisual ? 'ok' : ''}`} type="email" inputMode="email"
                  value={guardianEmail} onChange={(e) => onEmailChange(e.target.value)} placeholder="parent@email.com" />
              </Field>

              {EMAIL_VERIFY_ENABLED && emailOk && (
                <div className="stack" style={{ gap: 8 }}>
                  {vErr && <div className="err" role="alert">{vErr}</div>}
                  {verifyStage === 'idle' && (
                    <button type="button" className="btn secondary" disabled={vBusy || emailTaken === true} onClick={requestCode}>{vBusy ? 'Sending…' : 'Verify email'}</button>
                  )}
                  {verifyStage === 'sent' && (
                    <div className="verify-panel stack" style={{ gap: 10 }}>
                      <div className="hint">Enter the code we emailed to <strong>{guardianEmail.trim().toLowerCase()}</strong></div>
                      <div className="otp-entry" onClick={() => otpRef.current?.focus()}>
                        <div className="otp-boxes">
                          {[0, 1, 2, 3, 4, 5].map((i) => (
                            <div key={i} className={`otp-box${otp.length > i ? ' on' : ''}${otp.length === i ? ' active' : ''}`}>{otp[i] ?? ''}</div>
                          ))}
                        </div>
                        <input ref={otpRef} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp}
                          aria-label="6-digit code" onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
                      </div>
                      <button type="button" className="btn" disabled={otp.length !== 6 || vBusy} onClick={confirmCode}>{vBusy ? 'Verifying…' : 'Verify code'}</button>
                      <div className="between">
                        <span className="hint">{resendIn > 0 ? `Resend in 0:${String(resendIn).padStart(2, '0')}` : "Didn't get it?"}</span>
                        <button type="button" disabled={resendIn > 0 || vBusy} onClick={requestCode}
                          style={{ background: 'none', border: 'none', fontWeight: 800, fontSize: 12, color: resendIn > 0 ? 'var(--muted)' : 'var(--primary)', cursor: resendIn > 0 ? 'default' : 'pointer' }}>Resend</button>
                      </div>
                    </div>
                  )}
                  {verifyStage === 'verified' && <span className="verify-chip">✓ Email verified</span>}
                </div>
              )}

              <Field label="Parent phone (with country code)"
                hint={phoneNational ? (phoneObj ? `✓ ${phoneE164}` : 'Enter a valid number for the selected country') : 'Pick a country, then enter the number'}
                hintKind={phoneNational ? (phoneObj ? 'ok' : 'bad') : undefined}>
                <div className="row" style={{ gap: 8 }}>
                  <CountrySelect value={phoneCountry} onChange={setPhoneCountry} />
                  <input className={`input ${phoneNational ? (phoneObj ? 'ok' : 'bad') : ''}`} inputMode="tel" style={{ flex: 1 }}
                    value={phoneNational} onChange={(e) => setPhoneNational(e.target.value)} placeholder="416 555 0132" />
                </div>
              </Field>
              <button className="btn" disabled={!detailsValid || busy} onClick={submitDetails}>{busy ? 'Checking…' : 'Continue →'}</button>
              <p className="hint" style={{ textAlign: 'center' }}>Already have an account? <a href="/login">Log in</a></p>
            </>
          )}

          {step === 'consent' && (
            <>
              <h2>Parent consent 📝</h2>
              <div className="card">
                <p><strong>What we collect</strong> — your child's username, name, grade, age and practice progress. Parent contact is used only to secure and recover the account.</p>
                <p><strong>What we never do</strong> — no ads, no selling data, no in-app purchases.</p>
                <p><strong>Your rights</strong> — export or delete your child's data anytime. Data residency: Canada (PIPEDA). Policy version {POLICY_VERSION}.</p>
              </div>
              <button type="button" className="consent-check" aria-pressed={consentChecked} onClick={() => setConsentChecked((c) => !c)}>
                <span className={`bm-box ${consentChecked ? 'on' : ''}`} aria-hidden>{consentChecked ? '✓' : ''}</span>
                I'm {guardianName || 'the parent'} and I agree to the above.
              </button>
              <button className="btn" disabled={busy || !consentChecked} onClick={acceptConsent}>I agree — continue</button>
            </>
          )}

          {step === 'account' && (
            <>
              <h2>Create the sign-in 🔐</h2>
              <p className="muted">Pick a username and a secret 4-digit PIN for {displayName || 'your child'}.</p>
              <Field label="Username" hint={!username ? 'Use 3–20 lowercase letters, numbers or _' : (usernameValid ? '✓ Nice — that one works!' : 'Start with a letter; 3–20 chars, lowercase only')} hintKind={username ? (usernameValid ? 'ok' : 'bad') : undefined}>
                <input className={`input ${username ? (usernameValid ? 'ok' : 'bad') : ''}`} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} placeholder="e.g. aisha_k" />
              </Field>
              <Field label="4-digit PIN"><input className="input" value={pin} inputMode="numeric" maxLength={4} placeholder="••••" onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
              <Field label="Confirm PIN"><input className="input" value={pin2} inputMode="numeric" maxLength={4} placeholder="••••" onChange={(e) => setPin2(e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
              <button className="btn" disabled={!usernameValid || pin.length !== 4 || pin2.length !== 4 || busy} onClick={finish}>{busy ? 'Creating…' : 'Create account 🎉'}</button>
            </>
          )}

          {step === 'success' && (
            <div className="stack" style={{ textAlign: 'center', gap: 16, paddingTop: 12 }}>
              <div style={{ fontSize: 72 }}>🎉</div>
              <h1>You're all set, {displayName || 'champ'}!</h1>
              <p className="muted">The account is ready and you're signed in. Let's start practising and build your first streak.</p>
              <div className="row" style={{ justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="pill" style={{ background: 'var(--tint-lilac)', color: 'var(--purple)' }}>⭐ Earn XP as you practise</span>
                <span className="pill" style={{ background: 'var(--amber-tint)', color: 'var(--amber)' }}>🔥 Start your streak today</span>
              </div>
              <button className="btn" onClick={() => nav('/home', { replace: true })}>Enter the app 🎉</button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
