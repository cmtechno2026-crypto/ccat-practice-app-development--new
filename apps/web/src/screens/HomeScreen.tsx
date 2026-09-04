import { useNavigate } from 'react-router-dom';
import { firstName } from '@ccat/client-core';
import type { Achievement, ProgressSummary } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { Card, Loader, ErrorNote, useAsync, GradePill } from '../components/ui';
import { AvatarControl } from '../components/AvatarControl';
import { Avatar } from '../components/Avatar';
import { capsOf, PAYMENTS_ENABLED } from '../lib/entitlements';

// HOME — "Option A": a two-column dashboard for kids (grade 3–6). Purple header band (greeting,
// streak, Continue, avatar) → LEFT column (stat tiles, progress card, hero Practice/Exam, announcements)
// → RIGHT motivation rail (mascot, 7-day streak, next reward, recent badges). EVERY value comes from
// real gateway data; every field is read with a safe default so a brand-new account (0 XP/coins, no
// badges, no streak, no active session, no announcements) renders cleanly with no errors.

// ---- small pure helpers (presentation only; no business logic / thresholds live here) ----
// This Week is rendered in FIXED Monday→Sunday columns. The columns never move; only the per-day fill
// changes. We build the seven weekdays of the LOCAL week containing today (week starts Monday) and map
// the server's activity dates onto those fixed slots.
const WEEK_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function isoDate(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function mondayWeek(activeByDate: Map<string, boolean>): { date: string; active: boolean; label: string }[] {
  const t = new Date();
  const mondayOffset = (t.getDay() + 6) % 7; // getDay: 0=Sun..6=Sat → days since Monday (Mon=0 … Sun=6)
  const monday = new Date(t.getFullYear(), t.getMonth(), t.getDate() - mondayOffset);
  return WEEK_LABELS.map((label, i) => {
    const dt = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const iso = isoDate(dt);
    return { date: iso, active: activeByDate.get(iso) === true, label };
  });
}
// Per-battery visuals for the H4 accuracy rings. Colours are fixed per spec (Verbal blue, Quant teal,
// Non-verbal purple); names are friendly labels for the known keys with a prettified fallback so any
// category the gateway returns still renders. We render whatever readiness[] returns, in its order.
const CAT_VIS: Record<string, { name: string; color: string; tint: string }> = {
  verbal: { name: 'Verbal', color: '#3e7bee', tint: '#eaf0ff' },
  quantitative: { name: 'Quantitative', color: '#22c3a6', tint: '#e6f7f1' },
  non_verbal: { name: 'Non-verbal', color: '#8b5cf6', tint: '#f3ecfb' },
  nonverbal: { name: 'Non-verbal', color: '#8b5cf6', tint: '#f3ecfb' },
};
function catVis(key: string) {
  const hit = CAT_VIS[key];
  if (hit) return hit;
  const name = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { name, color: 'var(--purple)', tint: '#eef1f6' };
}
function mascotLine(streak: number, completion: number | null): string {
  if (streak >= 7) return "You're unstoppable — what a streak! 🔥";
  if (streak >= 3) return `${streak} days in a row — amazing work!`;
  if (streak >= 1) return 'Nice start — come back tomorrow to grow your streak!';
  if (completion != null && completion >= 50) return "You're over halfway through — keep going!";
  return "Ready for today's practice? Let's go!";
}

export function HomeScreen() {
  const nav = useNavigate();
  const { profile, entitlements } = useApp();
  // Payments Phase 2: when the flag is off, capsOf() unlocks everything, so examLocked is always false
  // and the exam entry tile renders exactly as today.
  const examLocked = PAYMENTS_ENABLED && !capsOf(entitlements).exam;
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
      {/* HEADER BAND (purple gradient) — greeting, streak, Continue, avatar */}
      <header className="home-hero">
        <div className="hh-text">
          <h1>Hi {name} 👋</h1>
          <div className="hh-streak">
            {streak > 0 ? `🔥 ${streak}-day streak — let's keep it alive!` : "Ready to practise? Let's go!"}
          </div>
        </div>
        <div className="hh-actions">
          {active && (
            <button className="hh-continue" onClick={() => nav(`/session/${active.id}`)}>
              ▶ Continue practice
            </button>
          )}
          <GradePill />
          <AvatarControl />
        </div>
      </header>

      {loading && <Loader />}
      {error && <ErrorNote error={error} onRetry={reload} />}

      {data && summary && (() => {
        const xp = summary.xp_total ?? 0;
        const coins = summary.coin_balance ?? 0;
        const lvl = summary.level;
        const level = lvl?.level ?? 1;
        const levelPct = lvl && lvl.xp_for_level > 0
          ? Math.max(0, Math.min(100, Math.round((100 * lvl.xp_into_level) / lvl.xp_for_level)))
          : 0;

        const ach = data.achievements ?? [];
        const badgesTotal = ach.length;
        const badgesEarned = ach.filter((a) => a.earned).length;
        const earned = ach.filter((a) => a.earned).sort((a, b) => (b.earned_at ?? '').localeCompare(a.earned_at ?? ''));
        const locked = ach.filter((a) => !a.earned);
        const badgeSlots = [...earned, ...locked].slice(0, 6);

        // Map the server's activity dates → active flags, then render fixed Mon–Sun columns for this week.
        const activeByDate = new Map((summary.streak?.last7 ?? []).map((d) => [d.date, d.active]));
        const week = mondayWeek(activeByDate);

        const nextReward = summary.next_reward ?? null;
        const completion = data.progress.progress_pct ?? null;
        const resumeLine = active
          ? [active.set_name, active.difficulty].filter(Boolean).join(' · ') || active.subcategory || `${active.mode} session`
          : '';
        const answered = active ? Number((active as any).answered_count ?? 0) : 0;
        const qTotal = active ? Number((active as any).question_count ?? 0) : 0;

        return (
          <div className="home-grid">
            {/* ---------------- LEFT / MAIN COLUMN ---------------- */}
            <main className="home-main">
              {/* Stat tiles: Coins · XP · Level (with ring toward next level) */}
              <div className="stat-tiles">
                <div className="stile stile-coin">
                  <span className="st-ic">🪙</span>
                  <span className="st-n">{coins.toLocaleString()}</span>
                  <span className="st-l">Coins</span>
                </div>
                <div className="stile stile-xp">
                  <span className="st-ic">⭐</span>
                  <span className="st-n">{xp.toLocaleString()}</span>
                  <span className="st-l">XP</span>
                </div>
                <div className="stile stile-level">
                  <div className="lvl-ring" style={{ ['--pct' as any]: `${levelPct}%` }}>
                    <span>Lv {level}</span>
                  </div>
                  <span className="st-l">{badgesEarned} / {badgesTotal} badges</span>
                </div>
              </div>

              {/* Progress & analytics — "H4": Score (all batteries) + Sets done + three per-battery
                  accuracy rings. Every value is real; honest empty states ("—" / 0 / rings at 0). */}
              <Card className="home-progress">
                <div className="hp-head">
                  <div className="eyebrow">📊 Progress &amp; Analytics</div>
                  <button className="pill hp-details" onClick={() => nav('/progress')}>Details ›</button>
                </div>
                {(() => {
                  // Sample 4 — one tile per battery: progress-% ring on the left, "N sets done" on the right.
                  const batteries = data.analytics?.batteries ?? [];
                  return (
                    <div className="hp-bat-row">
                      {batteries.map((b) => {
                        const cv = catVis(b.key);
                        const pct = b.accuracyPct ?? 0;
                        return (
                          <button
                            key={b.key}
                            className="hp-bat"
                            style={{ ['--ring' as any]: cv.color, ['--tint' as any]: cv.tint }}
                            onClick={() => nav('/progress')}
                          >
                            <div className="hp-bat-ring" style={{ ['--pct' as any]: `${pct}%` }}>
                              <span>{b.accuracyPct == null ? '0%' : `${b.accuracyPct}%`}</span>
                            </div>
                            <div className="hp-bat-txt">
                              <span className="hp-bat-n">{b.setsDone}</span>
                              <span className="hp-bat-l">{cv.name}</span>
                              <span className="hp-bat-s">sets done</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
              </Card>

              {/* Hero entry cards — CCAT Practice + CCAT Exam */}
              <div className="entry-grid">
                <button className="entry-tile entry-practice" onClick={() => nav('/practice')}>
                  <span className="et-ic">✏️</span>
                  <span className="et-title">CCAT practice</span>
                  <span className="et-sub">Choose a category &amp; topic and start learning</span>
                  <span className="et-go">Start ›</span>
                </button>
                <button className="entry-tile entry-exam" onClick={() => nav('/practice?mode=exam')}>
                  <span className="et-ic">📝</span>
                  <span className="et-title">CCAT exam</span>
                  <span className="et-sub">Timed mock — Verbal, Non-verbal &amp; Quantitative</span>
                  <span className="et-go">{examLocked ? '🔒 Membership' : 'Start ›'}</span>
                </button>
              </div>

              {/* Announcements — hidden entirely when there are none */}
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
              {/* Mascot */}
              <div className="rail-card mascot-card">
                <div className="mascot-emoji"><Avatar size={46} /></div>
                <div className="mascot-line">{mascotLine(streak, completion)}</div>
              </div>

              {/* 7-day streak row */}
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

              {/* Next reward */}
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

              {/* Recent badges (+ locked placeholders) */}
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
                <button className="btn small ghost" style={{ marginTop: 10, paddingLeft: 0 }} onClick={() => nav('/rewards')}>
                  See all rewards ›
                </button>
                {active && (
                  <div className="muted" style={{ marginTop: 10 }}>
                    Resume: {resumeLine || 'your session'}{qTotal > 0 ? ` (${answered}/${qTotal})` : ''}
                  </div>
                )}
              </div>
            </aside>
          </div>
        );
      })()}
    </div>
  );
}
