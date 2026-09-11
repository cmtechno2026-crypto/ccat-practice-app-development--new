import { Link, Navigate } from 'react-router-dom';
import { useApp } from '../lib/store';
import cmWordmark from '../assets/cm-wordmark.png';
import '../landing.css';

// Pre-login landing page (route "/"). Full marketing page: features, how-it-works, pricing, contact —
// with a sticky header whose menu scrolls to each section, and CTAs into /register and /login.
// All styling is scoped under `.lp` (apps/web/src/landing.css) so it never touches the in-app UI.

const FEATURES = [
  ['🎯', 'Practice by topic', 'Verbal, Non-verbal & Quantitative reasoning, split into focused sets by the exact CCAT skill.'],
  ['⏱️', 'Timed mock exams', 'Full-length, three-battery papers that mirror the real test and its clock.'],
  ['📊', 'Progress & analytics', 'Sets done, accuracy per battery, and a readiness score that climbs with practice.'],
  ['🏆', 'Rewards & streaks', 'XP, coins, levels and daily streaks keep children motivated on their own.'],
  ['🎖️', 'Achievements', 'Badges for milestones turn practice into a game worth finishing.'],
  ['🔖', 'Bookmarks', 'Save the tricky questions and revisit them any time.'],
] as const;

const STEPS = [
  ['1', 'Create a parent account', 'A grown-up sets it up in a minute — PIPEDA-compliant.'],
  ['2', "Pick your child's grade", 'Content is targeted to the right grade, Grades 3 to 5.'],
  ['3', 'Practise by topic', 'Start free, then unlock every set across all three batteries.'],
  ['4', 'Take a timed mock exam', 'Build real exam stamina with full-length, timed papers.'],
  ['5', 'Track & earn rewards', 'Watch the readiness score climb and collect badges.'],
] as const;

const PLANS = [
  { name: 'Free', price: '$0', term: '', feats: ['Set 1 of every practice topic (except Battery Combine)'], best: false, cta: 'Current plan' },
  { name: 'Standard', price: '$50', term: '1-year access', feats: ['Unlimited access to all individual practice sets'], best: false, cta: 'Get Standard' },
  { name: 'Plus', price: '$100', term: '1-year access', feats: ['Everything in Standard', 'Unlimited full battery tests', 'Full-length timed exam papers'], best: false, cta: 'Get Plus' },
  { name: 'Premium', price: '$200', term: '1-year access', feats: ['Everything in Plus', 'Weekly test', '5 live 1-on-1 mentoring sessions'], best: true, cta: 'Get Premium' },
] as const;

export function WelcomeScreen() {
  const { profile } = useApp();
  if (profile) return <Navigate to="/home" replace />;

  return (
    <div className="lp">
      {/* Sticky header — logo (matches conceptmastery.com) + section menu + auth CTAs */}
      <header className="lp-nav">
        <div className="lp-nav-in">
          <a className="lp-logo" href="#top" aria-label="Concept Mastery"><img src={cmWordmark} alt="Concept Mastery — Quality Education" /></a>
          <nav className="lp-menu">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#contact">Contact</a>
            <a href="https://conceptmastery.com" target="_blank" rel="noopener noreferrer">Main site ↗</a>
            <Link className="lp-btn ghost" to="/login">Log in</Link>
            <Link className="lp-btn solid" to="/register">Create account</Link>
          </nav>
        </div>
      </header>

      <span id="top" />

      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-hero-in">
          <div>
            <span className="lp-ey">CCAT / NGAT Prep</span>
            <h1>Prepare your child for the CCAT with a <em>proven system.</em></h1>
            <span className="lp-gradepill">🎯 Built for Grades 3–5</span>
            <p>The CCAT Practice platform by Concept Mastery gives Grade 3–5 students real exam-style questions, full-length timed mocks, and progress parents can actually measure.</p>
            <div className="lp-cta">
              <Link className="lp-btn solid lg" to="/register">Create an account</Link>
              <Link className="lp-btn ghost lg" style={{ color: '#fff', borderColor: '#fff' }} to="/login">I already have an account</Link>
            </div>
            <div className="lp-trust">✔ Trusted by 500+ parents · ✔ Grades 3–5 · ✔ PIPEDA-compliant</div>
          </div>
          <div className="lp-panel">
            <h3>What's inside</h3>
            <div className="lp-row"><span className="lp-ic">🎯</span><div><b>Topic practice</b><br /><span>Verbal · Non-verbal · Quantitative</span></div></div>
            <div className="lp-row"><span className="lp-ic">⏱️</span><div><b>Timed mock exams</b><br /><span>Full three-battery papers</span></div></div>
            <div className="lp-row"><span className="lp-ic">📊</span><div><b>Progress & readiness score</b><br /><span>See exactly where they stand</span></div></div>
            <div className="lp-row"><span className="lp-ic">🏆</span><div><b>Rewards & streaks</b><br /><span>Motivation built in</span></div></div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="lp-sec">
        <div className="lp-sh">
          <span className="lp-ey">Features</span>
          <h2>Everything needed to ace the CCAT</h2>
          <p>Built around the real test — three batteries, timed papers, and measurable progress.</p>
        </div>
        <div className="lp-grid3">
          {FEATURES.map(([icon, title, desc]) => (
            <div className="lp-fcard" key={title}>
              <div className="fx">{icon}</div>
              <div><h3>{title}</h3><p>{desc}</p></div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <div className="lp-how">
        <section id="how" className="lp-sec">
          <div className="lp-sh"><span className="lp-ey">How it works</span><h2>Exam-ready in five simple steps</h2></div>
          <div className="lp-steps">
            {STEPS.map(([n, title, desc]) => (
              <div className="lp-step" key={n}><span className="lp-sn">{n}</span><div><h3>{title}</h3><p>{desc}</p></div></div>
            ))}
          </div>
        </section>
      </div>

      {/* Pricing */}
      <section id="pricing" className="lp-sec">
        <div className="lp-sh">
          <span className="lp-ey">Pricing</span>
          <h2>Choose the right plan for your child</h2>
          <p>Start free. Standard unlocks all practice; Plus adds full exams; Premium adds mentoring. CAD, 12 months from purchase.</p>
        </div>
        <div className="lp-plans">
          {PLANS.map((pl) => (
            <article className={`lp-plan${pl.best ? ' best' : ''}`} key={pl.name}>
              {pl.best && <span className="lp-pbadge">BEST VALUE</span>}
              <div className="lp-pn">{pl.name}</div>
              <div className="lp-pp">{pl.price}<span>CAD</span></div>
              <div className="lp-pt">{pl.term}</div>
              <ul>{pl.feats.map((f) => <li key={f}><span className="lp-ck">✓</span>{f}</li>)}</ul>
              <Link className="lp-pbtn" to="/register">{pl.cta}</Link>
            </article>
          ))}
        </div>
      </section>

      {/* Contact */}
      <section id="contact" className="lp-sec">
        <div className="lp-contact">
          <h2>Questions? Talk to a real person.</h2>
          <p>Concept Mastery has coached 500+ families across Canada, the US and Australia. Book a free strategy call or reach us any time.</p>
          <div className="lp-cbtns">
            <a className="lp-cw" href="https://conceptmastery.com" target="_blank" rel="noopener noreferrer">Book a free 15-min call →</a>
            <a className="lp-cm2" href="mailto:info@conceptmastery.com">info@conceptmastery.com</a>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        © Concept Mastery · <a href="https://conceptmastery.com" target="_blank" rel="noopener noreferrer">conceptmastery.com</a> · CCAT Practice · We follow Canadian privacy rules (PIPEDA)
      </footer>
    </div>
  );
}
