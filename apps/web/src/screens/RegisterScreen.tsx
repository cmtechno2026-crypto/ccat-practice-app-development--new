import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@ccat/api-client';
import { parsePhone, type CountryCode } from '../lib/phone';
import { client, getDeviceHash } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Field } from '../components/ui';

// Registration funnel (Blueprint §4), mockup: CCAT Onboarding.dc.html. Minors-only product → the
// account is ALWAYS guardian-owned: a guardian enters name + email + phone, which are VALIDATED
// server-side (email format + E.164 phone with a country code) — NO OTP is generated, sent, or
// verified. Then consent, then the child's userID + PIN create the student. Child-safety gating
// (consent) preserved; the gateway is authoritative and re-validates the contact.
//
// Steps: details (child + guardian, with inline email/phone validation) → consent → userID + PIN →
// create + login.

type Step = 'details' | 'consent' | 'account' | 'success';
const FUNNEL: Step[] = ['details', 'consent', 'account'];
const STEP_LABEL: Record<Step, string> = { details: 'Details', consent: 'Consent', account: 'Account', success: 'Done' };
const POLICY_VERSION = '2026-01';

// Common country calling codes for the phone selector (ISO country → dial code + flag). The full
// E.164 validation is done by libphonenumber-js against the chosen country, then re-checked server-side.
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
  // Load grades once, after mount, in a real effect (NOT useMemo — a memo is a render-phase perf hint
  // React may discard/re-run, so firing an async fetch + setState from it left the list intermittently
  // empty → the native <select> opened with zero options and "wouldn't scroll"). The ignore flag drops
  // a late resolution if the component unmounts first.
  useEffect(() => {
    let ignore = false;
    setGradesLoading(true);
    client.grades()
      .then((g: any) => {
        if (ignore) return;
        const list = Array.isArray(g) ? g : [];
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

  // consent + account
  const [consentChecked, setConsentChecked] = useState(false);
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');

  const age = ageFrom(birthYear, birthMonth, birthDay);
  const usernameValid = /^[a-z][a-z0-9_]{2,19}$/.test(username);

  // Phone: validate the national number against the selected country → E.164 (isomorphic with the server).
  const phoneObj = useMemo(() => {
    const p = parsePhone(phoneNational, phoneCountry);
    return p && p.isValid() ? p : null;
  }, [phoneNational, phoneCountry]);
  const phoneE164 = phoneObj?.number ?? '';
  const emailOk = emailValid(guardianEmail);
  const detailsValid = displayName.trim().length > 0 && !!gradeId && guardianName.trim().length > 0 && emailOk && !!phoneObj;

  async function guard<T>(fn: () => Promise<T>) {
    setBusy(true); setErr(null);
    try { return await fn(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : (e as Error).message); return null; }
    finally { setBusy(false); }
  }

  // Step 1 → validate + persist the guardian contact (server re-validates), then straight to consent.
  async function submitDetails() {
    if (!phoneE164) { setErr('Enter a valid phone number including its country code.'); return; }
    const r = await guard(() => client.registrationContact({ guardianName, email: guardianEmail.trim().toLowerCase(), phone: phoneE164, grant: grant || undefined }));
    if (r) { setGrant(r.registration_grant); setStep('consent'); }
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
      <AppBar title="Create account" sub="A grown-up sets this up" back />
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

          {/* STEP 1 — child details + guardian contact (validated, no OTP) */}
          {step === 'details' && (
            <>
              <div className="card" style={{ background: 'var(--tint-blue)' }}>
                <p>🧑‍👧 <strong>A parent or guardian sets this up.</strong> We ask for a grown-up's email and phone and for consent before creating the account — Canadian privacy rules (PIPEDA), no ads, no selling data.</p>
              </div>

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

              <div className="eyebrow" style={{ marginTop: 8 }}>Parent / guardian</div>
              <Field label="Guardian name"><input className="input" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} placeholder="Parent / guardian full name" /></Field>
              <Field label="Guardian email" hint={guardianEmail ? (emailOk ? '✓ Looks good' : 'Enter a valid email address') : undefined} hintKind={guardianEmail ? (emailOk ? 'ok' : 'bad') : undefined}>
                <input className={`input ${guardianEmail ? (emailOk ? 'ok' : 'bad') : ''}`} type="email" inputMode="email"
                  value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} placeholder="parent@email.com" />
              </Field>
              <Field label="Guardian phone (with country code)"
                hint={phoneNational ? (phoneObj ? `✓ ${phoneE164}` : 'Enter a valid number for the selected country') : 'Pick a country, then enter the number'}
                hintKind={phoneNational ? (phoneObj ? 'ok' : 'bad') : undefined}>
                <div className="row" style={{ gap: 8 }}>
                  <select className="input" style={{ maxWidth: 150 }} aria-label="Country code" value={phoneCountry} onChange={(e) => setPhoneCountry(e.target.value as CountryCode)}>
                    {COUNTRIES.map((c) => <option key={c.iso} value={c.iso}>{c.flag} {c.label} ({c.dial})</option>)}
                  </select>
                  <input className={`input ${phoneNational ? (phoneObj ? 'ok' : 'bad') : ''}`} inputMode="tel" style={{ flex: 1 }}
                    value={phoneNational} onChange={(e) => setPhoneNational(e.target.value)} placeholder="416 555 0132" />
                </div>
              </Field>
              <button className="btn" disabled={!detailsValid || busy} onClick={submitDetails}>{busy ? 'Checking…' : 'Continue →'}</button>
              <p className="hint" style={{ textAlign: 'center' }}>Already have an account? <a href="/login">Log in</a></p>
            </>
          )}

          {/* STEP 2 — CONSENT */}
          {step === 'consent' && (
            <>
              <h2>Parent consent 📝</h2>
              <div className="card">
                <p><strong>What we collect</strong> — your child's username, name, grade, age and practice progress. Guardian contact is used only to secure and recover the account.</p>
                <p><strong>What we never do</strong> — no ads, no selling data, no in-app purchases.</p>
                <p><strong>Your rights</strong> — export or delete your child's data anytime. Data residency: Canada (PIPEDA). Policy version {POLICY_VERSION}.</p>
              </div>
              <button type="button" className="consent-check" aria-pressed={consentChecked} onClick={() => setConsentChecked((c) => !c)}>
                <span className={`bm-box ${consentChecked ? 'on' : ''}`} aria-hidden>{consentChecked ? '✓' : ''}</span>
                I'm {guardianName || 'the parent/guardian'} and I agree to the above.
              </button>
              <button className="btn" disabled={busy || !consentChecked} onClick={acceptConsent}>I agree — continue</button>
            </>
          )}

          {/* STEP 3 — userID + PIN */}
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

          {/* STEP 4 — SUCCESS */}
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
