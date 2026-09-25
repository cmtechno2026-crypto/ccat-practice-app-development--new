import { useNavigate } from 'react-router-dom';
import { firstName } from '@ccat/client-core';
import type { Achievement, ProgressSummary } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { Card, Loader, ErrorNote, useAsync, GradePlanChip } from '../components/ui';
import { AvatarControl } from '../components/AvatarControl';
import { Avatar } from '../components/Avatar';
import { PromoInline } from '../components/DiscountBanner';
import { AssignmentPanel } from '../components/AssignmentPanel';
import { capsOf, PAYMENTS_ENABLED } from '../lib/entitlements';

// HOME — kid-friendly dashboard. Order (top → bottom of the main column): hero → PRACTICE → EXAM →
// PROGRESS → ASSIGNMENT (last, only when the student has a teacher). Practice/Exam are colorful
// "character" cards per battery (Practice = symbol glyphs on brand-blue shades; Exam = topic emoji on
// gold shades). Every value is real gateway data with safe defaults so a brand-new account renders cleanly.

const WEEK_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function isoDate(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function mondayWeek(activeByDate: Map<string, boolean>): { date: string; active: boolean; label: string }[] {
  const t = new Date();
  const mondayOffset = (t.getDay() + 6) % 7;
  const monday = new Date(t.getFullYear(), t.getMonth(), t.getDate() - mondayOffset);
  return WEEK_LABELS.map((label, i) => {
    const dt = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const iso = isoDate(dt);
    return { date: iso, active: activeByDate.get(iso) === true, label };
  });
}
function mascotLine(streak: number, completion: number | null): string {
  if (streak >= 7) return "You're unstoppable — what a streak! 🔥";
  if (streak >= 3) return `${streak} days in a row — amazing work!`;
  if (streak >= 1) return 'Nice start — come back tomorrow to grow your streak!';
  if (completion != null && completion >= 50) return "You're over halfway through — keep going!";
  return "Ready for today's practice? Let's go!";
}

// The three CCAT batteries, in a fixed friendly order. `alt` matches the alternate key spelling some
// grades use ('nonverbal' vs 'non_verbal'). glyph = Practice symbol; emoji = Exam topic mark.
const BATTERIES: { key: string; alt: string; name: string; glyph: string; emoji: string }[] = [
  { key: 'verbal', alt: 'verbal', name: 'Verbal', glyph: 'Aa', emoji: '🔤' },
  { key: 'quantitative', alt: 'quantitative', name: 'Quantitative', glyph: '123', emoji: '🔢' },
  { key: 'non_verbal', alt: 'nonverbal', name: 'Non-Verbal', glyph: '◧▲', emoji: '🧩' },
];

export function HomeScreen() {
  const nav = useNavigate();
  const { profile, entitlements, entitlementsLoaded } = useApp();
  const examLocked = PAYMENTS_ENABLED && !capsOf(entitlements, entitlementsLoaded).exam;
  // Fail OPEN: hide the Assignment panel ONLY when we know there is no teacher (false). undefined
  // (older gateway / still loading) shows it, so a student with a teacher is never wrongly hidden.
  const hasTeacher = profile?.has_teacher !== false;

  const { loading, error, data, reload } = useAsync(async () => {
    const [summary, readiness, progress, announcements, active, achievements, analytics] = await Promise.all([
      client.rewardsSummary(), client.readiness(), client.progress(), client.announcements(),
      client.activeSession(), client.achievements().catch(() => [] as Achievement[]),
      client.progressSummary().catch(() => null as ProgressSummary | null),
    ]);
    return { summary, readiness, progress, announcements, active, achievements, analytics };
  });

  const name = firstName(profile?.display_name);
  const summary = data?.summary;
  const streak = summary?.streak?.current ?? 0;
  const active = data?.active ?? null;

  return (
    <div className="home-a">
      <header className="home-hero">
        <div className="hh-text">
          <h1>Hi {name} 👋</h1>
          <div className="hh-streak">
            {streak > 0 ? `🔥 ${streak}-day streak — let's keep it alive!` : "Ready to practise? Let's go!"}
          </div>
          <PromoInline onClick={() => nav('/plan')} />
        </div>
        <div className="hh-actions">
          {active && (
            <button className="hh-continue" onClick={() => nav(`/session/${active.id}`)}>
              ▶ Continue practice
            </button>
          )}
          <GradePlanChip />
          <AvatarControl />
        </div>
      </header>

      {loading && <Loader />}
      {error && <ErrorNote error={error} onRetry={reload} />}

      {data && summary && (() => {
        const batteries = data.analytics?.batteries ?? [];
        const battOf = (key: string, alt: string) => batteries.find((b) => b.key === key || b.key === alt);

        const ach = data.achievements ?? [];
        const badgesTotal = ach.length;
        const earned = ach.filter((a) => a.earned).sort((a, b) => (b.earned_at ?? '').localeCompare(a.earned_at ?? ''));
        const locked = ach.filter((a) => !a.earned);
        const badgeSlots = [...earned, ...locked].slice(0, 6);

        const activeByDate = new Map((summary.streak?.last7 ?? []).map((d) => [d.date, d.active]));
        const week = mondayWeek(activeByDate);
        const nextReward = summary.next_reward ?? null;
        const completion = data.progress.progress_pct ?? null;

        return (
          <div className="home-grid">
            {/* ---------------- MAIN COLUMN ---------------- */}
            <main className="home-main">

              {/* 1) PRACTICE — brand-blue character cards, one per battery */}
              <section className="hpanel hpanel-prac">
                <div className="hpanel-head">
                  <h3>✏️ Practice</h3>
                  <span className="hpanel-hint">Pick a battery to practise</span>
                </div>
                <div className="hchar-row">
                  {BATTERIES.map((bt, i) => {
                    const b = battOf(bt.key, bt.alt);
                    const done = b?.setsDone ?? 0;
                    const total = b?.setsTotal ?? 0;
                    return (
                      <button key={bt.key} className={`hchar hchar-b${i + 1}`} onClick={() => nav(`/practice?battery=${bt.key}`)}>
                        <span className="hchar-badge"><span className="hchar-glyph">{bt.glyph}</span></span>
                        <span className="hchar-name">{b?.name ?? bt.name}</span>
                        <span className="hchar-ribbon">{total > 0 ? `${done} / ${total} sets` : 'Start practising'}</span>
                        <span className="hchar-cta">Practise ▶</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* 2) EXAM — gold character cards, one per battery */}
              <section className="hpanel hpanel-exam">
                <div className="hpanel-head">
                  <h3>📝 Exam</h3>
                  <span className="hpanel-hint">Timed full-battery mocks</span>
                </div>
                <div className="hchar-row">
                  {BATTERIES.map((bt, i) => {
                    const b = battOf(bt.key, bt.alt);
                    return (
                      <button
                        key={bt.key}
                        className={`hchar hchar-g${i + 1}`}
                        onClick={() => (examLocked ? nav('/plan') : nav(`/practice?mode=exam&battery=${bt.key}`))}
                      >
                        <span className="hchar-badge"><span className="hchar-emoji">{bt.emoji}</span></span>
                        <span className="hchar-name">{b?.name ?? bt.name} Exam</span>
                        <span className="hchar-ribbon">Full timed mock</span>
                        <span className="hchar-cta">{examLocked ? '🔒 Membership' : 'Start ▶'}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* 3) PROGRESS — per-battery accuracy rings (real analytics) */}
              <Card className="home-progress">
                <div className="hp-head">
                  <div className="eyebrow">📊 Progress &amp; Analytics</div>
                  <button className="pill hp-details" onClick={() => nav('/progress')}>Details ›</button>
                </div>
                <div className="hp-bat-row">
                  {(batteries.length ? batteries : []).map((b) => {
                    const pct = b.accuracyPct ?? 0;
                    return (
                      <button key={b.key} className="hp-bat" onClick={() => nav('/progress')}>
                        <div className="hp-bat-ring" style={{ ['--pct' as any]: `${pct}%` }}>
                          <span>{b.accuracyPct == null ? '0%' : `${b.accuracyPct}%`}</span>
                        </div>
                        <div className="hp-bat-txt">
                          <span className="hp-bat-n">{b.setsDone}</span>
                          <span className="hp-bat-l">{b.name}</span>
                          <span className="hp-bat-s">sets done</span>
                        </div>
                      </button>
                    );
                  })}
                  {batteries.length === 0 && <div className="muted" style={{ padding: 6 }}>Practise a set to see your progress here.</div>}
                </div>
              </Card>

              {/* 4) ASSIGNMENT — last, and only when the student has a teacher */}
              {hasTeacher && <AssignmentPanel />}

              {/* Announcements */}
              {data.announcements.length > 0 && (
                <Card>
                  <div className="eyebrow">📣 Announcements</div>
                  <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                    {data.announcements.slice(0, 3).map((a) => (
                      <div key={a.id} className="between"><strong>{a.title}</strong></div>
                    ))}
                  </div>
                </Card>
              )}
            </main>

            {/* ---------------- RIGHT MOTIVATION RAIL ---------------- */}
            <aside className="home-rail" aria-label="Your progress">
              <div className="rail-card mascot-card">
                <div className="mascot-emoji"><Avatar size={46} /></div>
                <div className="mascot-line">{mascotLine(streak, completion)}</div>
              </div>

              <div className="rail-card">
                <div className="eyebrow">🔥 This week</div>
                <div className="week-row" role="list">
                  {week.map((d) => (
                    <div key={d.date} role="listitem" className={`wk-day ${d.active ? 'on' : ''}`} title={d.date}>
                      <span className="wk-dot" aria-hidden>{d.active ? '🔥' : ''}</span>
                      <span className="wk-lbl">{d.label}</span>
                    </div>
                  ))}
                </div>
                <div className="muted" style={{ marginTop: 8 }}>
                  {streak > 0 ? `${streak}-day streak` : 'Practise today to start a streak'}
                </div>
              </div>

              <div className="rail-card">
                <div className="eyebrow">🎁 Next reward</div>
                {nextReward ? (
                  <>
                    <div className="nr-line" style={{ marginTop: 6 }}>
                      <strong>{nextReward.xp_needed.toLocaleString()} XP</strong> to {nextReward.label}
                    </div>
                    <div className="progress-track" style={{ marginTop: 8 }}>
                      <div className="progress-fill" style={{ width: `${nextReward.progress_pct}%`, background: 'var(--purple)' }} />
                    </div>
                  </>
                ) : (
                  <div className="muted" style={{ marginTop: 6 }}>You've unlocked every reward! 🎉</div>
                )}
              </div>

              <div className="rail-card">
                <div className="eyebrow">🏅 Recent badges</div>
                {badgesTotal === 0 ? (
                  <div className="muted" style={{ marginTop: 6 }}>Earn badges as you practise.</div>
                ) : (
                  <div className="badge-grid" style={{ marginTop: 8 }}>
                    {badgeSlots.map((a) => (
                      <div key={a.key} className={`badge ${a.earned ? 'on' : ''}`} title={a.name}>
                        <span aria-hidden>{a.earned ? '🏅' : '🔒'}</span>
                      </div>
                    ))}
                  </div>
                )}
                <button className="btn small ghost" style={{ marginTop: 10, paddingLeft: 0 }} onClick={() => nav('/achievements')}>
                  See all rewards ›
                </button>
              </div>
            </aside>
          </div>
        );
      })()}
    </div>
  );
}
