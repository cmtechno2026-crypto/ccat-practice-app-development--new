import React, { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { ApiError } from './lib/api';
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
import { Books } from './pages/Books';
import { Grades } from './pages/Grades';
import { Flags } from './pages/Flags';
import { Admins } from './pages/Admins';
import { Audit } from './pages/Audit';

const DEMO = [
  { email: 'super@cm.ca', name: 'Ayesha Khan', role: 'Super-Admin', tag: 'SUPER', av: '#fbe6c4', avink: '#b5791b' },
  { email: 'content@cm.ca', name: 'Sam Mehta · Content editor', role: 'ADMIN', tag: 'ADMIN', av: '#dbe7ff', avink: '#2f5fc0' },
  { email: 'support@cm.ca', name: 'Priya Rao · Student support', role: 'SUPPORT', tag: 'SUPPORT', av: '#e7dcff', avink: '#6c4bd6' },
];

function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('super@cm.ca');
  const [password, setPassword] = useState('Passw0rd!');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [fails, setFails] = useState(0);
  const locked = fails >= 5;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (locked) return;
    setErr(''); setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setFails(f => f + 1);
        setErr('Invalid email or password.');
      } else {
        setErr((e as Error).message);
      }
    } finally { setBusy(false); }
  };

  const fill = (em: string) => { setEmail(em); setPassword('Passw0rd!'); setErr(''); };

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
        <form className="formcard" onSubmit={submit}>
          <h3>Welcome back</h3>
          <p className="sub">Admins sign in with their work email and password. Five failed attempts locks the account.</p>

          <label>Work email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" placeholder="you@conceptmastery.com" disabled={locked} />
          <label>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" disabled={locked} />

          <button className="btn" style={{ width: '100%', marginTop: 18, justifyContent: 'center' }} disabled={busy || locked}>
            {locked ? 'Account locked' : busy ? 'Signing in…' : 'Continue'}
          </button>
          <div className="err">{err}</div>

          <div className="demo">
            <div className="dl">Demo accounts — tap to fill</div>
            {DEMO.map(d => (
              <button type="button" key={d.email} className="demorow" onClick={() => fill(d.email)}>
                <span className="av" style={{ background: d.av, color: d.avink }}>{d.name.split(' ').map(s => s[0]).slice(0, 2).join('')}</span>
                <span>
                  <span className="nm">{d.email}</span><br />
                  <span className="ml">{d.name}</span>
                </span>
                <span className="rl" style={{ background: d.av, color: d.avink }}>{d.tag}</span>
              </button>
            ))}
            {locked
              ? <div className="locknote">This account is locked — too many attempts. Contact a Super-Admin.</div>
              : fails > 0 && <div className="locknote">{fails} of 5 failed attempts</div>}
          </div>
        </form>
      </div>
    </div>
  );
}

export function App() {
  const { me, ready } = useAuth();
  if (!ready) return <div className="empty" style={{ paddingTop: 80 }}>Loading…</div>;
  if (!me) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/students" element={<Students />} />
        <Route path="/students/:id" element={<StudentDetail />} />
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
        <Route path="/books" element={<Books />} />
        <Route path="/comms/books" element={<Navigate to="/books" replace />} />
        <Route path="/audit" element={<Audit />} />
        {/* Reached from the Super-Admin dashboard controls panel (R2), not the rail. */}
        <Route path="/health" element={<Health />} />
        <Route path="/admins" element={<Admins />} />
        <Route path="/config" element={<Navigate to="/config/grades" replace />} />
        <Route path="/config/grades" element={<Grades />} />
        <Route path="/config/flags" element={<Flags />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
