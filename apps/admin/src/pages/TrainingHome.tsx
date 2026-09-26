import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

// TeacherHub Training — overview landing. The Training rail item opens this; each section opens as
// its own route, so the browser Back button steps section → overview → previous page naturally.
const navy = 'var(--brand,#1c3f6e)';
const card: React.CSSProperties = { background: 'var(--card,#fff)', border: '1px solid var(--line,#e6e6ef)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 6, textDecoration: 'none', color: 'inherit' };

interface Section { to?: string; icon: string; title: string; desc: string; ready: boolean; count?: number | null }

export function TrainingHome() {
  const [moduleCount, setModuleCount] = useState<number | null>(null);
  const [rpCount, setRpCount] = useState<number | null>(null);
  useEffect(() => { let on = true; api.trainingModules().then(r => on && setModuleCount(r.modules.length)).catch(() => on && setModuleCount(null));
    api.trainingRoleplays().then(r => on && setRpCount(r.roleplays.length)).catch(() => {}); return () => { on = false; }; }, []);

  const sections: Section[] = [
    { to: '/teacherhub/training/modules', icon: '📘', title: 'Learning modules', desc: 'Lessons and quizzes teachers read and pass in the TeacherHub app.', ready: true, count: moduleCount },
    { to: '/teacherhub/training/roleplays', icon: '🎭', title: 'Role-play scenarios', desc: 'Practice conversations with a brief and an observer rubric.', ready: true, count: rpCount },
    { icon: '📝', title: 'Test rules', desc: 'Exam settings — attempts allowed, questions per attempt, pass mark.', ready: false },
    { icon: '🗂️', title: 'Question bank', desc: 'Pooled questions the test draws from; CSV import/export.', ready: false },
    { icon: '📜', title: 'Certificates', desc: 'Completion certificate template and issued records.', ready: false },
    { icon: '📊', title: 'Teacher progress', desc: 'Who has completed which modules, role-plays and tests.', ready: false },
  ];

  const Body = (s: Section) => (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 24 }}>{s.icon}</span>
        <span style={{ fontWeight: 800, fontSize: 15, color: navy }}>{s.title}</span>
        {s.ready && s.count != null && <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 800, color: 'var(--brand,#2f6fd0)', background: 'var(--brand-soft,#e7f0fc)', borderRadius: 999, padding: '2px 10px' }}>{s.count}</span>}
        {!s.ready && <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', color: '#6b7280', background: '#eceff2', borderRadius: 999, padding: '2px 8px' }}>Coming soon</span>}
      </div>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{s.desc}</div>
      {s.ready && <div style={{ marginTop: 'auto', fontSize: 12.5, fontWeight: 700, color: 'var(--brand,#2f6fd0)' }}>Manage →</div>}
    </>
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div>
        <h2 style={{ margin: '0 0 2px', fontSize: 22, fontWeight: 900, letterSpacing: '-.02em', color: navy }}>Training</h2>
        <div className="muted" style={{ fontSize: 13 }}>Everything teachers learn and are certified on. Pick a section to manage it.</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 14 }}>
        {sections.map(s => s.ready && s.to
          ? <Link key={s.title} to={s.to} style={{ ...card, cursor: 'pointer' }}>{Body(s)}</Link>
          : <div key={s.title} style={{ ...card, opacity: 0.72 }}>{Body(s)}</div>)}
      </div>
    </div>
  );
}
