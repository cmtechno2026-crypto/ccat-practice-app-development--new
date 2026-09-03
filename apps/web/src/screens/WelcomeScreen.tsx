import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useApp } from '../lib/store';

const SLIDES = [
  { emoji: '🧠', title: 'Sharpen your brain!', body: 'Practice verbal, quantitative & non-verbal reasoning — the real CCAT skills.' },
  { emoji: '🔥', title: 'Build a streak!', body: 'Practice a little every day, earn XP and coins, and keep your streak alive.' },
  { emoji: '🦊', title: 'Level up with Milo!', body: 'Unlock avatars, themes and badges as you become a CCAT champion.' },
];

export function WelcomeScreen() {
  const { profile } = useApp();
  const [slide, setSlide] = useState(0);
  const [done, setDone] = useState(false);
  if (profile) return <Navigate to="/home" replace />;

  // Intro carousel first, then the Milo choice screen.
  if (!done) {
    const s = SLIDES[slide]!;
    const last = slide === SLIDES.length - 1;
    return (
      <div className="content center-narrow" style={{ paddingTop: 40 }}>
        <div className="between">
          <span className="eyebrow">CCAT Practice</span>
          <button className="btn ghost small" onClick={() => setDone(true)}>Skip</button>
        </div>
        <div className="stack" style={{ textAlign: 'center', gap: 16, marginTop: 24 }}>
          <div style={{ fontSize: 72 }}>{s.emoji}</div>
          <h1>{s.title}</h1>
          <p className="muted">{s.body}</p>
          <div className="slide-dots" aria-hidden>
            {SLIDES.map((_, i) => <i key={i} className={i === slide ? 'on' : ''} />)}
          </div>
          <button className="btn" onClick={() => (last ? setDone(true) : setSlide((i) => i + 1))}>{last ? 'Get started! 🚀' : 'Next'}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="content center-narrow" style={{ paddingTop: 48 }}>
      <div className="stack" style={{ textAlign: 'center', gap: 16 }}>
        <div style={{ fontSize: 64 }}>🦊</div>
        <h1>Hi, I'm Milo!</h1>
        <p className="muted">Ready to become a CCAT champion? Create an account or log in to get started.</p>
        <Link to="/register" className="btn">Create an account 🚀</Link>
        <Link to="/login" className="btn secondary">I already have an account</Link>
        <p className="hint">A parent sets up the account. We follow Canadian privacy rules (PIPEDA).</p>
      </div>
    </div>
  );
}
