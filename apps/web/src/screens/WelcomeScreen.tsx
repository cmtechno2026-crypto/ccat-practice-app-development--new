import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/store';
import { PlanCheckoutModal } from '../components/PlanCheckoutModal';
import { PAYMENTS_ENABLED } from '../lib/entitlements';
import '../landing2.css';
import wm from '../assets/cm-wordmark.png';
import heroImg from '../assets/landing-hero.jpg';
import homeImg from '../assets/landing-home.png';
import pracImg from '../assets/landing-practice.png';
import demoImg from '../assets/landing-demo.jpg';

// Pre-login landing page (route "/"). Marketing page authored as HTML (design provided by the team),
// rendered inside a `.cml` wrapper whose styles are fully scoped (apps/web/src/landing2.css) so the
// page's generic selectors never leak into the authenticated app. A single delegated click handler
// turns in-page links into SPA navigation and remembers a plan choice so the user lands on /plan
// after they log in or sign up.
const BODY = `

<header class="nav">
  <div class="wrap">
    
    <a href="/" aria-label="Concept Mastery"><img class="logoimg" src="%WM%" alt="Concept Mastery" style="height:52px;width:auto"></a>
    <nav class="nav-cta">
      <a class="nav-link" href="#features">Features</a>
      <a class="nav-link" href="#how">How it works</a>
      <a class="nav-link" href="#pricing">Pricing</a>
      <a class="nav-link" href="#contact">Contact</a>
      <a class="nav-link" href="https://conceptmastery.com/" target="_blank" rel="noopener">Main site ↗</a>
      <a class="btn btn-outline" href="/login">Log in</a>
      <a class="btn btn-gold" href="/register">Create account</a>
    </nav>
  </div>
</header>


<section class="hero">
  <div class="wrap">
    <div class="txt">
      <span class="badge">🎯 Built for Grades 2–5 · CCAT / NGAT</span>
      <h1>Your child walks into the CCAT already knowing <span class="u">exactly what to expect.</span></h1>
      <p class="hero-sub">Real exam-style questions, full-length timed mocks, and a readiness score you can actually watch climb.</p>
      <div class="hero-cta">
        <a class="btn btn-blue btn-lg" href="/register">Start free — no card needed →</a>
        <a class="btn btn-outline btn-lg" href="/login">I have an account</a>
      </div>
      <p class="hero-note">Start on the free plan today. Upgrade only when you see it working.</p>
      <div class="trust">
        <span>✔ Trusted by <b>500+ parents</b></span>
        <span>✔ 3 real batteries</span>
        <span>✔ <b>PIPEDA</b>-compliant</span>
      </div>
    </div>
    <div class="imgslot"><img src="%HERO%" alt="Grade 3 student practising CCAT on a tablet"></div>
  </div>
</section>


<section>
  <div class="wrap" style="max-width:860px">
    <div class="sectlabel"><span class="eyebrow">The real problem</span>
    <h2>The CCAT doesn't test what your child learned in school.</h2></div>
    <p class="lede">It tests how they think under a clock — with question types most kids have never seen. Bright children freeze, not because they can't do it, but because the format is unfamiliar and the timer is unforgiving. That's the gap that decides gifted-program placement.</p>
    <div class="pain">
      <div class="pain-row"><span class="x">✕</span><div><b>Generic worksheets don't match the test.</b> Photocopied packets rarely mirror the three real batteries or the actual timing.</div></div>
      <div class="pain-row"><span class="x">✕</span><div><b>Private tutoring is expensive and hard to schedule.</b> Great when you can get it — but not every family can spend hundreds per month.</div></div>
      <div class="pain-row"><span class="x">✕</span><div><b>You can't see if it's working.</b> Hours of practice, and no clear signal of whether your child is actually ready.</div></div>
    </div>
  </div>
</section>


<section class="band" id="features">
  <div class="wrap">
    <div class="center sectlabel"><span class="eyebrow">What's inside</span>
    <h2>Everything needed to ace the CCAT.</h2>
    <p class="lede">Built around the real test — three batteries, timed papers, and measurable progress.</p></div>
    <div class="grid cols-3" style="margin-top:36px">
      <div class="feat"><div class="ic">🎯</div><h3>Practice by topic</h3><p>Verbal, Non-verbal &amp; Quantitative reasoning, split into focused sets by the exact CCAT skill.</p></div>
      <div class="feat"><div class="ic">⏱️</div><h3>Timed mock exams</h3><p>Full-length, three-battery papers that mirror the real test and its clock.</p></div>
      <div class="feat"><div class="ic">📊</div><h3>Progress &amp; analytics</h3><p>Sets done, accuracy per battery, and a readiness score that climbs with practice.</p></div>
      <div class="feat"><div class="ic">🏆</div><h3>Rewards &amp; streaks</h3><p>XP, coins, levels and daily streaks keep children motivated on their own.</p></div>
      <div class="feat"><div class="ic">🎖️</div><h3>Achievements</h3><p>Badges for milestones turn practice into a game worth finishing.</p></div>
      <div class="feat"><div class="ic">🔖</div><h3>Bookmarks</h3><p>Save the tricky questions and revisit them any time.</p></div>
    </div>
  </div>
</section>


<section>
  <div class="wrap">
    <div class="split">
      <div class="txt">
        <span class="eyebrow">Practice by exact skill</span>
        <h2 style="margin-top:10px">Focused sets for every question type on the test.</h2>
        <p class="lede" style="margin-top:14px">Not random worksheets — the three real batteries, split into the precise skills the CCAT measures, so practice always targets the next weak spot.</p>
        <ul>
          <li><span class="ck">✓</span> Verbal · Non-verbal · Quantitative reasoning</li>
          <li><span class="ck">✓</span> Grade-targeted for Grades 2–5</li>
          <li><span class="ck">✓</span> Bookmark hard questions and revisit them</li>
        </ul>
      </div>
      <div class="imgslot shot"><img src="%HOME%" alt="Concept Mastery home dashboard"></div>
    </div>
  </div>
</section>


<section class="band">
  <div class="wrap">
    <div class="split rev">
      <div class="txt">
        <span class="eyebrow">Progress you can measure</span>
        <h2 style="margin-top:10px">A readiness score you watch climb.</h2>
        <p class="lede" style="margin-top:14px">Accuracy per battery and one simple readiness number tell you exactly where your child stands — and prove the practice is working.</p>
        <ul>
          <li><span class="ck">✓</span> Accuracy tracked for each battery</li>
          <li><span class="ck">✓</span> Single readiness score, updated as they practise</li>
          <li><span class="ck">✓</span> See strengths and gaps at a glance</li>
        </ul>
      </div>
      <div class="imgslot shot"><img src="%PRAC%" alt="Concept Mastery practice screen"></div>
    </div>
  </div>
</section>


<section>
  <div class="wrap" style="max-width:820px">
    <div class="center sectlabel"><span class="eyebrow">Everything you get</span>
    <h2>One platform that replaces the tutor, the worksheets, and the guesswork.</h2></div>
    <div class="stack" style="margin-top:32px">
      <h3>The Concept Mastery CCAT Practice System</h3>
      <ul>
        <li><div class="item"><b>Practice by exact CCAT skill</b><span>Verbal, Non-verbal &amp; Quantitative, split into focused sets.</span></div><div class="val">Core</div></li>
        <li><div class="item"><b>Full-length timed mock exams</b><span>Three-battery papers that mirror the real test and its clock.</span></div><div class="val">Core</div></li>
        <li><div class="item"><b>Progress &amp; readiness score</b><span>Accuracy per battery and a readiness number you can track.</span></div><div class="val">Core</div></li>
        <li><div class="item"><b>Rewards, streaks &amp; achievements</b><span>Keeps your child practising on their own.</span></div><div class="val">Core</div></li>
        <li><div class="item"><b>Bookmarks for tricky questions</b><span>Save the hard ones and revisit any time.</span></div><div class="val">Core</div></li>
        <li><div class="item"><b>Weekly test + live 1-on-1 mentoring</b><span>On Premium: a weekly checkpoint plus 5 live coaching sessions.</span></div><div class="val">Premium</div></li>
      </ul>
      <div class="kicker">A year of everything above — for less than the cost of a single private tutoring session.</div>
    </div>
  </div>
</section>


<section class="band" id="pricing">
  <div class="wrap">
    <div class="center sectlabel"><span class="eyebrow">Pricing</span>
    <h2>Pick a plan that fits your child.</h2>
    <p class="lede">Start free. Standard unlocks all practice · Plus adds full timed exams · Premium adds live mentoring. Prices in CAD, 1-year access from purchase.</p></div>

    <div class="price-grid">
      <div class="plan free">
        <div class="pname">Free</div>
        <div class="priced"><span class="now">$0</span><span class="cur">CAD</span></div>
        <div class="term">Forever free</div>
        <ul>
          <li><span class="ck">✓</span> Set 1 of every practice topic</li>
          <li><span class="ck">✓</span> Try the platform, no card needed</li>
          <li><span class="ck">✓</span> (Excludes Battery Combine)</li>
        </ul>
        <a class="btn btn-outline" href="/register">Start free</a>
      </div>

      <div class="plan">
        <div class="pname">Standard</div>
        <div class="priced"><span class="now">$49</span><span class="cur">CAD</span></div>
        <div class="term">1-year access</div>
        <ul>
          <li><span class="ck">✓</span> Unlimited access to <b>all</b> practice sets</li>
          <li><span class="ck">✓</span> All three batteries, every skill</li>
          <li><span class="ck">✓</span> Progress &amp; readiness score</li>
          <li><span class="ck">✓</span> Rewards, streaks &amp; bookmarks</li>
        </ul>
        <a class="btn btn-blue" href="/register" data-plan="1" data-tier="t50">Get Standard</a>
      </div>

      <div class="plan">
        <div class="pname">Plus</div>
        <div class="priced"><span class="now">$99</span><span class="cur">CAD</span></div>
        <div class="term">1-year access</div>
        <ul>
          <li><span class="ck">✓</span> Everything in Standard</li>
          <li><span class="ck">✓</span> <b>Unlimited full battery tests</b></li>
          <li><span class="ck">✓</span> Full-length timed exam papers</li>
          <li><span class="ck">✓</span> Real exam-day stamina practice</li>
        </ul>
        <a class="btn btn-blue" href="/register" data-plan="1" data-tier="t250">Get Plus</a>
      </div>

      <div class="plan best">
        <span class="tag">Best value</span>
        <div class="pname">Premium</div>
        <div class="priced"><span class="now">$199</span><span class="cur">CAD</span></div>
        <div class="term">1-year access</div>
        <ul>
          <li><span class="ck">✓</span> Everything in Plus</li>
          <li><span class="ck">✓</span> <b>Weekly test</b> checkpoint</li>
          <li><span class="ck">✓</span> <b>5 live 1-on-1 mentoring sessions</b></li>
          <li><span class="ck">✓</span> Direct coaching from a CM instructor</li>
        </ul>
        <a class="btn btn-gold" href="/register" data-plan="1" data-tier="t500">Get Premium</a>
      </div>
    </div>
    
  </div>
</section>


<section>
  <div class="wrap">
    <div class="center sectlabel"><span class="eyebrow">Parents &amp; results</span>
    <h2>What families say after test day.</h2></div>
    
    <div class="grid cols-3" style="margin-top:22px">
      <div class="rev empty"><div class="fill">Add a real parent review here<small>Their words · name · city · grade · optional photo (200×200)</small></div></div>
      <div class="rev empty"><div class="fill">Add a real parent review here<small>Their words · name · city · grade · optional photo (200×200)</small></div></div>
      <div class="rev empty"><div class="fill">Add a real parent review here<small>Their words · name · city · grade · optional photo (200×200)</small></div></div>
    </div>
    
    <p class="note center" style="margin-top:16px">One or two real reviews beat three placeholders. Screenshots of real messages (with permission) also work well.</p>
  </div>
</section>


<section class="band" id="how">
  <div class="wrap" style="max-width:820px">
    <div class="center sectlabel"><span class="eyebrow">How it works</span>
    <h2>Exam-ready in five simple steps.</h2></div>
    <div class="steps">
      <div class="step"><div class="n"></div><div><h3>Create a parent account</h3><p>A grown-up sets it up in under a minute — PIPEDA-compliant and private.</p></div></div>
      <div class="step"><div class="n"></div><div><h3>Pick your child's grade</h3><p>Content targets the right level, Grades 2 to 5.</p></div></div>
      <div class="step"><div class="n"></div><div><h3>Practise by topic</h3><p>Start free, then unlock every set across all three batteries.</p></div></div>
      <div class="step"><div class="n"></div><div><h3>Take a timed mock exam</h3><p>Build real exam stamina with full-length, timed papers.</p></div></div>
      <div class="step"><div class="n"></div><div><h3>Track &amp; earn rewards</h3><p>Watch the readiness score climb and collect badges along the way.</p></div></div>
    </div>
  </div>
</section>


<section>
  <div class="wrap">
    <div class="split">
      <div class="imgslot"><img src="%DEMO%" alt="Concept Mastery instructor teaching a child online"></div>
      <div class="txt">
        <span class="eyebrow">Not ready to buy?</span>
        <h2 style="margin-top:10px">Book a free 45-minute demo class for your child.</h2>
        <p class="lede" style="margin-top:14px">See a Concept Mastery instructor work with your child on real CCAT-style questions — no cost, no obligation. It's the fastest way to know if this is right for them.</p>
        <div class="hero-cta">
          <a class="btn btn-blue btn-lg" href="https://conceptmastery.com/">Book a free 45-min demo class →</a>
        </div>
      </div>
    </div>
  </div>
</section>


<section class="band">
  <div class="wrap">
    <div class="center sectlabel"><span class="eyebrow">Questions</span><h2>Everything a parent asks first.</h2></div>
    <div class="faq">
      <details open><summary>Is this the actual CCAT?</summary><p>No — the CCAT is a copyrighted test. Concept Mastery provides independent practice built around the same three batteries, question types, and timing so your child is familiar with the format on test day.</p></details>
      <details><summary>What grades is it for?</summary><p>Grades 2 to 5. You pick your child's grade at sign-up and the content targets that level.</p></details>
      <details><summary>Can I really start for free?</summary><p>Yes. The free plan gives Set 1 of every practice topic (except Battery Combine), with no card required. Upgrade only when you've seen it work.</p></details>
      <details><summary>What's the difference between Standard, Plus and Premium?</summary><p>Standard unlocks all individual practice sets. Plus adds unlimited full-length timed battery exams. Premium adds a weekly test plus 5 live 1-on-1 mentoring sessions with a Concept Mastery instructor.</p></details>
      <details><summary>How long does access last?</summary><p>Paid plans include 1-year access from the date of purchase (CAD).</p></details>
      <details><summary>Is my child's data safe?</summary><p>Yes. We follow Canadian privacy rules (PIPEDA). Accounts are parent-created and private.</p></details>
    </div>
  </div>
</section>


<section class="final" id="contact">
  <div class="wrap" style="max-width:760px">
    <span class="eyebrow">Test day is coming</span>
    <h2 style="margin-top:12px">Give your child the advantage of walking in prepared.</h2>
    <p>Create a free account now. Practise today. Upgrade only when you see the readiness score climb.</p>
    <div class="hero-cta">
      <a class="btn btn-gold btn-lg" href="/register">Create your free account →</a>
      <a class="btn btn-lg" style="background:#fff;color:var(--blue)" href="https://conceptmastery.com/">Book a free 45-min demo class</a>
    </div>
    <p class="hero-note">Concept Mastery has coached 500+ families across Canada, the US &amp; Australia. <a class="mail" href="mailto:info@conceptmastery.com">info@conceptmastery.com</a></p>
  </div>
</section>

<footer>
  <div class="wrap">
    <div>© Concept Mastery · CCAT Practice · We follow Canadian privacy rules (PIPEDA)</div>
    <div><a href="https://conceptmastery.com/">conceptmastery.com</a> · <a href="mailto:info@conceptmastery.com">info@conceptmastery.com</a></div>
  </div>
</footer>
`;

type Sellable = 't50' | 't250' | 't500';

export function WelcomeScreen() {
  const nav = useNavigate();
  const { profile } = useApp();
  const [checkoutTier, setCheckoutTier] = useState<Sellable | null>(null);
  if (profile) return <Navigate to="/home" replace />;
  const html = BODY
    .replace(/%WM%/g, wm)
    .replace(/%HERO%/g, heroImg)
    .replace(/%HOME%/g, homeImg)
    .replace(/%PRAC%/g, pracImg)
    .replace(/%DEMO%/g, demoImg);

  function onClick(e: ReactMouseEvent<HTMLDivElement>) {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    // hash (in-page scroll), external and mailto links keep their default behaviour
    if (!href || href.startsWith('#') || href.startsWith('http') || href.startsWith('mailto')) return;
    e.preventDefault();
    // A "Get <plan>" button opens the in-page checkout modal (email → login/OTP → PayPal) instead of
    // sending the parent to /register first. Falls back to the old /plan-after-auth path if payments are off.
    const tier = a.getAttribute('data-tier') as Sellable | null;
    if (tier && PAYMENTS_ENABLED) { setCheckoutTier(tier); return; }
    try {
      if (a.getAttribute('data-plan')) sessionStorage.setItem('cmPostAuthRedirect', '/plan');
      else sessionStorage.removeItem('cmPostAuthRedirect');
    } catch { /* ignore */ }
    nav(href);
  }

  return (
    <>
      <div className="cml" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {checkoutTier && <PlanCheckoutModal tier={checkoutTier} onClose={() => setCheckoutTier(null)} />}
    </>
  );
}
