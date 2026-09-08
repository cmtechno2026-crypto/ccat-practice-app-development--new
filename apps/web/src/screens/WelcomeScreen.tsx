import { Link, Navigate } from 'react-router-dom';
import { useApp } from '../lib/store';
import cmLogo from '../assets/cm-logo.jpg';

// Pre-login gateway (route "/"). Split brand panel: CM-blue brand + quote on the left, entry actions on
// the right. Replaces the old intro carousel + "Hi, I'm Milo!" choice screen with one combined page.
export function WelcomeScreen() {
  const { profile } = useApp();
  if (profile) return <Navigate to="/home" replace />;

  return (
    <div className="auth-split">
      <div className="auth-brand">
        <span className="b-circ" style={{ width: 260, height: 260, top: -90, right: -70 }} />
        <span className="b-circ" style={{ width: 150, height: 150, bottom: 20, left: -50 }} />
        <div className="b-logo"><img src={cmLogo} alt="Concept Mastery" /></div>
        <div className="b-quote">Every champion starts with a <span>single question.</span></div>
        <div className="b-by">— CCAT Practice by Concept Mastery</div>
      </div>
      <div className="auth-form">
        <div className="af-inner" style={{ textAlign: 'center' }}>
          <h1>Let's get started 🦊</h1>
          <p className="af-sub">Practice the real CCAT skills, earn XP and coins, and level up with Milo.</p>
          <div className="auth-actions">
            <Link to="/register" className="btn primary">Create an account 🚀</Link>
            <Link to="/login" className="btn secondary">I already have an account</Link>
          </div>
          <p className="auth-parent">A parent sets up the account.<br />We follow Canadian privacy rules (PIPEDA).</p>
        </div>
      </div>
    </div>
  );
}
