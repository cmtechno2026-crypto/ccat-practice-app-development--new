import { useNavigate } from 'react-router-dom';
import { firstName } from '@ccat/client-core';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Card, Loader, ErrorNote, useAsync } from '../components/ui';

// HOME — mockup: CCAT Home.dc.html, adapted to desktop-web. Engaging dashboard: reward chips →
// progress & analytics → pick-up-where-you-left-off → CCAT practice → CCAT exam → achievements.
// No Customize or Bookmark tile (avatar/theme lives behind the top-right control; a bookmarked
// question is saved from inside a session). No Book Store (removed from the website). Colours = mockup tokens.

export function HomeScreen() {
  const nav = useNavigate();
  const { profile } = useApp();
  const { loading, error, data, reload } = useAsync(async () => {
    const [summary, readiness, progress, announcements, active, achievements] = await Promise.all([
      client.rewardsSummary(), client.readiness(), client.progress(), client.announcements(),
      client.activeSession(), client.achievements().catch(() => []),
    ]);
    return { summary, readiness, progress, announcements, active, achievements };
  });

  const streak = (data?.summary as any)?.streak?.current ?? 0;
  const xp = data?.summary.xp_total ?? 0;
  const coins = data?.summary.coin_balance ?? 0;
  const level = Math.floor(xp / 500) + 1; // display level derived from XP
  const unlocked = data ? data.achievements.filter((a) => a.earned).length : 0;
  const totalAch = data?.achievements.length ?? 0;
  const completion = data?.progress.progress_pct ?? null;
  const active = data?.active ?? null;
  const resumeLine = active
    ? [active.set_name, active.difficulty].filter(Boolean).join(' · ') || active.subcategory || `${active.mode} session`
    : '';
  const answered = active ? Number((active as any).answered_count ?? 0) : 0;
  const qTotal = active ? Number((active as any).question_count ?? 0) : 0;
  const resumeProgress = active && qTotal > 0 ? `${answered} of ${qTotal} answered` : 'Not submitted';

  return (
    <>
      <AppBar title={`Hi ${firstName(profile?.display_name)} 👋`}
        sub={streak > 0 ? `🔥 ${streak}-day streak — let's keep it alive!` : "Ready to practise? Let's go!"} />
      <div className="content stack">
        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {data && (
          <>
            {/* Reward chips — coins · XP · level (mockup top-bar chips) */}
            <div className="home-chips">
              <div className="home-chip"><span className="hc-ic">🪙</span><span className="hc-n">{coins}</span><span className="hc-l">Coins</span></div>
              <div className="home-chip"><span className="hc-ic">⭐</span><span className="hc-n">{xp.toLocaleString()}</span><span className="hc-l">XP</span></div>
              <div className="home-chip"><span className="hc-ic">🏆</span><span className="hc-n">Level {level}</span><span className="hc-l">{unlocked}/{totalAch} badges</span></div>
            </div>

            {/* Progress & analytics */}
            <Card onClick={() => nav('/progress')} className="home-progress">
              <div className="row" style={{ alignItems: 'center' }}>
                <div className="ring" style={{ ['--pct' as any]: `${completion ?? 0}%` }}>
                  <span>{completion == null ? '—' : `${completion}%`}</span>
                </div>
                <div style={{ flex: 1 }}>
                  <div className="eyebrow">📊 Progress & analytics</div>
                  <h3 style={{ marginTop: 2 }}>Completion · accuracy · timing</h3>
                  <div className="muted" style={{ marginTop: 4 }}>
                    {data.readiness.insufficient_data ? 'Readiness building…' : `${data.readiness.readiness_pct}% readiness`}
                    {' · '}Course completion {completion == null ? '—' : `${completion}%`}
                    {data.progress.eligible_count > 0 ? ` · ${data.progress.completed_count}/${data.progress.eligible_count} sets` : ''}
                  </div>
                </div>
                <span className="pill">Details ›</span>
              </div>
            </Card>

            {/* Pick up where you left off */}
            {active && (
              <Card onClick={() => nav(`/session/${active.id}`)} className="resume-card">
                <div className="row" style={{ alignItems: 'center' }}>
                  <div className="ic" style={{ background: 'var(--amber-tint)', color: 'var(--amber)' }}>▶️</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="eyebrow" style={{ color: 'var(--amber)' }}>Pick up where you left off</div>
                    <h3 style={{ marginTop: 2, textTransform: 'capitalize' }}>{resumeLine}</h3>
                    <div className="muted">{resumeProgress} — tap to resume</div>
                  </div>
                  <span className="pill" style={{ background: 'var(--amber-tint)', color: 'var(--amber)' }}>Resume ›</span>
                </div>
              </Card>
            )}

            {/* CCAT practice + CCAT exam — the two big entry points */}
            <div className="entry-grid">
              <button className="entry-tile entry-practice" onClick={() => nav('/practice')}>
                <span className="et-ic">✏️</span>
                <span className="et-title">CCAT practice</span>
                <span className="et-sub">Choose a category & topic — Easy, Medium, Hard</span>
                <span className="et-go">Start ›</span>
              </button>
              <button className="entry-tile entry-exam" onClick={() => nav('/practice?mode=exam')}>
                <span className="et-ic">📝</span>
                <span className="et-title">CCAT exam</span>
                <span className="et-sub">Timed mock — Verbal, Non-verbal & Quantitative</span>
                <span className="et-go">Start ›</span>
              </button>
            </div>

            {/* Announcements (only if any) */}
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

            {/* Achievements */}
            <Card onClick={() => nav('/rewards')}>
              <div className="row">
                <div className="ic" style={{ background: 'var(--amber-tint)' }}>🏅</div>
                <div style={{ flex: 1 }}>
                  <h3>Achievements</h3>
                  <div className="muted">{totalAch > 0 ? `${unlocked} of ${totalAch} unlocked · see your rewards` : 'Earn badges, coins & XP as you learn'}</div>
                </div>
                <span className="pill">›</span>
              </div>
            </Card>

          </>
        )}
      </div>
    </>
  );
}
