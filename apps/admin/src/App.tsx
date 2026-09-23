import React, { useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { ApiError, api } from './lib/api';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Health } from './pages/Health';
import { Students } from './pages/Students';
import { StudentDetail } from './pages/StudentDetail';
import { ImportQuestions } from './pages/ImportQuestions';
import { Content } from './pages/Content';
import { ExamPapers } from './pages/ExamPapers';
import { LearningPlans } from './pages/LearningPlans';
import { Achievements } from './pages/Achievements';
import { Customization } from './pages/Customization';
import { CoinsXp } from './pages/CoinsXp';
import { Announcements } from './pages/Announcements';
import { Teachers } from './pages/Teachers';
import { TeacherPractice, TeacherExam } from './pages/TeacherContent';
import { Grades } from './pages/Grades';
import { Flags } from './pages/Flags';
import { Admins } from './pages/Admins';
import { Audit } from './pages/Audit';
import { Membership } from './pages/Membership';
import { TeacherDashboard } from './pages/TeacherDashboard';
import { TeacherDirectory } from './pages/TeacherDirectory';
import { BookingLinks } from './pages/BookingLinks';
import { BookingRequests } from './pages/BookingRequests';
import { PAYMENTS_ENABLED } from './lib/payments';

function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [fails, setFails] = useState(0);
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const locked = fails >= 5;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (locked) return;
    setErr(''); setBusy(true);
    try {
      await login(email.trim(), password);
      // Always land on the admin default (Dashboard, "/") after a fresh sign-in — the routing tree only
      // mounts once authenticated, and the browser keeps whatever protected URL the user was logged out on,
      // so explicitly replace-navigate Home instead of re-rendering that stale page.
      nav('/', { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setFails(f => f + 1);
        setErr('Invalid email or password.');
      } else {
        setErr((e as Error).message);
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="login2">
      <div className="brandside">
        <div className="brandmark"><span className="logo">CM</span><b>Concept Mastery</b></div>
        <h2>The room where the content, the economy and the kids' safety are looked after.</h2>
        <p>Sign in to manage question sets, gamification and student accounts. Every change you make is audited.</p>
        <div className="chips">
          <span className="chip">PIPEDA · ca-central-1</span>
          <span className="chip">Every action audited</span>
        </div>
        <div className="accentline" />
      </div>

      <div className="formside">
        {mode === 'reset' ? (
          <ResetPasswordForm initialEmail={email} onBack={() => setMode('login')} />
        ) : (
        <form className="formcard" onSubmit={submit}>
          <h3>Welcome back</h3>
          <p className="sub">Admins sign in with their work email and password. Five failed attempts locks the account.</p>

          <label>Work email</label>
          <input type="email" name="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" placeholder="you@conceptmastery.com" disabled={locked} />
          <label>Password</label>
          <div style={{ position: 'relative' }}>
            <input type={showPw ? 'text' : 'password'} name="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" disabled={locked} style={{ paddingRight: 40 }} />
            <button type="button" onClick={() => setShowPw(v => !v)} aria-pressed={showPw} aria-label={showPw ? 'Hide password' : 'Show password'} title={showPw ? 'Hide password' : 'Show password'}
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 0, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 4 }}>
              {showPw ? '🙈' : '👁️'}
            </button>
          </div>

          <button className="btn" style={{ width: '100%', marginTop: 18, justifyContent: 'center' }} disabled={busy || locked}>
            {locked ? 'Account locked' : busy ? 'Signing in…' : 'Continue'}
          </button>
          <div className="err">{err}</div>

          {locked
            ? <div className="locknote">This account is locked — too many attempts. Contact a Super-Admin.</div>
            : fails > 0 && <div className="locknote">{fails} of 5 failed attempts</div>}

          <button type="button" onClick={() => setMode('reset')}
            style={{ background: 'transparent', border: 0, color: 'var(--primary, #1A5EAB)', fontWeight: 600, cursor: 'pointer', marginTop: 14, padding: 0, fontSize: 13.5 }}>
            Forgot password?
          </button>
        </form>
        )}
      </div>
    </div>
  );
}

// Self-service password reset (email OTP). Two steps: request a code to the login email, then enter the
// code + a new password. The gateway response is uniform (never reveals whether the email is an admin).
function ResetPasswordForm({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email');
  const [email, setEmail] = useState(initialEmail || '');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) { setErr('Enter your work email.'); return; }
    setBusy(true); setErr('');
    try { await api.requestPasswordReset(email.trim()); setStep('code'); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const complete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{4,10}$/.test(code.trim())) { setErr('Enter the code from your email.'); return; }
    if (pw.length < 10) { setErr('New password must be at least 10 characters.'); return; }
    if (pw !== pw2) { setErr('Passwords do not match.'); return; }
    setBusy(true); setErr('');
    try { await api.completePasswordReset(email.trim(), code.trim(), pw); setStep('done'); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const backLink = (
    <button type="button" onClick={onBack} style={{ background: 'transparent', border: 0, color: 'var(--primary, #1A5EAB)', fontWeight: 600, cursor: 'pointer', marginTop: 14, padding: 0, fontSize: 13.5 }}>← Back to sign in</button>
  );

  if (step === 'done') {
    return (
      <div className="formcard">
        <h3>Password reset</h3>
        <p className="sub">Your admin password has been changed. Sign in with your new password.</p>
        <button className="btn" style={{ width: '100%', marginTop: 14, justifyContent: 'center' }} onClick={onBack}>Back to sign in</button>
      </div>
    );
  }
  return step === 'email' ? (
    <form className="formcard" onSubmit={sendCode}>
      <h3>Reset your password</h3>
      <p className="sub">Enter your admin login email. If it belongs to an account, we’ll email a one-time code.</p>
      <label>Work email</label>
      <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" placeholder="you@conceptmastery.com" />
      <button className="btn" style={{ width: '100%', marginTop: 18, justifyContent: 'center' }} disabled={busy}>{busy ? 'Sending…' : 'Send reset code'}</button>
      <div className="err">{err}</div>
      {backLink}
    </form>
  ) : (
    <form className="formcard" onSubmit={complete}>
      <h3>Enter your code</h3>
      <p className="sub">If <b>{email}</b> is an admin account, a one-time code was emailed to it. Enter it and choose a new password.</p>
      <label>Reset code</label>
      <input inputMode="numeric" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="6-digit code" />
      <label>New password</label>
      <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" placeholder="At least 10 characters" />
      <label>Confirm new password</label>
      <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" />
      <button className="btn" style={{ width: '100%', marginTop: 18, justifyContent: 'center' }} disabled={busy}>{busy ? 'Resetting…' : 'Reset password'}</button>
      <div className="err">{err}</div>
      {backLink}
    </form>
  );
}

// Branded loading splash shown while the session resolves (api.me()). The gateway can cold-start on
// Render, so this can take a couple of seconds — a spinner reads as "loading", not a blank/broken page.
function LoadingSplash() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'var(--bg, #f4f6fb)', color: 'var(--ink, #1f2340)' }}>
      <style>{'@keyframes cmspin{to{transform:rotate(360deg)}}'}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 800, fontSize: 20 }}>
        <span style={{ display: 'inline-flex', width: 36, height: 36, borderRadius: 9, background: 'var(--primary,#1A5EAB)', color: '#fff', alignItems: 'center', justifyContent: 'center' }}>CM</span>
        Concept Mastery
      </div>
      <div style={{ width: 28, height: 28, border: '3px solid var(--line,#e3e7f0)', borderTopColor: 'var(--primary,#1A5EAB)', borderRadius: '50%', animation: 'cmspin .8s linear infinite' }} />
      <div style={{ color: 'var(--muted,#8a90a6)', fontSize: 13 }}>Loading admin…</div>
    </div>
  );
}

export function App() {
  const { me, ready } = useAuth();
  if (!ready) return <LoadingSplash />;
  if (!me) return <Login />;
  // Teacher accounts are LOCKED to the student directory + read-only student detail. Every other route
  // redirects to /students, so nothing they can't use is reachable (the gateway also enforces scope).
  if (me.is_teacher) {
    return (
      <Routes>
        <Route element={<Layout />}>
          <Route path="/students" element={<Students />} />
          <Route path="/students/:id" element={<StudentDetail />} />
          {/* Teachers can browse & preview published Practice / Exam content (grade-selectable). */}
          <Route path="/teacher-practice" element={<TeacherPractice />} />
          <Route path="/teacher-exam" element={<TeacherExam />} />
          <Route path="*" element={<Navigate to="/students" replace />} />
        </Route>
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/students" element={<Students />} />
        <Route path="/students/:id" element={<StudentDetail />} />
        <Route path="/teacher-practice" element={<TeacherPractice />} />
        <Route path="/teacher-exam" element={<TeacherExam />} />
        {/* Content: set browser (category tree + difficulty tabs) is the home; exam papers 2nd tab. */}
        <Route path="/content" element={<Content />} />
        <Route path="/content/exams" element={<ExamPapers />} />
        {/* Question pool removed from the UI — redirect any old link back to Content. */}
        <Route path="/content/questions" element={<Navigate to="/content" replace />} />
        <Route path="/content/import" element={<ImportQuestions />} />
        <Route path="/content/sets" element={<Navigate to="/content" replace />} />
        <Route path="/content/plans" element={<LearningPlans />} />
        {/* Gamification */}
        <Route path="/gamification" element={<Navigate to="/gamification/achievements" replace />} />
        <Route path="/gamification/achievements" element={<Achievements />} />
        <Route path="/gamification/customization" element={<Customization />} />
        <Route path="/gamification/themes" element={<Customization />} />
        <Route path="/gamification/economy" element={<CoinsXp />} />
        <Route path="/rewards/achievements" element={<Navigate to="/gamification/achievements" replace />} />
        <Route path="/rewards/customization" element={<Navigate to="/gamification/customization" replace />} />
        {/* Communications */}
        <Route path="/announcements" element={<Announcements />} />
        <Route path="/comms/announcements" element={<Navigate to="/announcements" replace />} />
        <Route path="/comms/push" element={<Navigate to="/announcements" replace />} />
        <Route path="/teachers" element={<Teachers />} />
        <Route path="/audit" element={<Audit />} />
        {/* Reached from the Super-Admin dashboard controls panel (R2), not the rail. */}
        <Route path="/health" element={<Health />} />
        <Route path="/admins" element={<Admins />} />
        <Route path="/config" element={<Navigate to="/config/grades" replace />} />
        <Route path="/config/grades" element={<Grades />} />
        <Route path="/config/flags" element={<Flags />} />
        {/* Payments Phase 2 — manual membership grant. Route exists only when the flag is on. */}
        {PAYMENTS_ENABLED && <Route path="/config/membership" element={<Membership />} />}
        {/* Teacher Hub site (multi-site admin) */}
        <Route path="/teacher" element={<TeacherDashboard />} />
        <Route path="/teacher/teachers" element={<TeacherDirectory />} />
        <Route path="/teacher/booking-links" element={<BookingLinks />} />
        <Route path="/teacher/requests" element={<BookingRequests />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
