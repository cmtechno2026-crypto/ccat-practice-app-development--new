import { useState } from 'react';
import type { Achievement, CoinsPanel as CoinsPanelData } from '@ccat/api-client';
import { client } from '../lib/api';
import { AppBar, Card, Loader, ErrorNote, useAsync } from '../components/ui';

const relTime = (iso: string | null) => {
  if (!iso) return '';
  try {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
  } catch { return ''; }
};

function CoinsPanel({ coins }: { coins: CoinsPanelData }) {
  const { coin_balance, current_streak, ladder, next, history } = coins;
  return (
    <Card>
      <div className="between">
        <div className="eyebrow">🪙 Coins</div>
        <div className="row" style={{ gap: 10 }}>
          <span className="pill" style={{ background: 'var(--amber-tint)', color: 'var(--amber)' }}>🪙 {coin_balance}</span>
          <span className="pill" style={{ background: 'var(--tint-orange, var(--amber-tint))', color: 'var(--amber)' }}>🔥 {current_streak}-day streak</span>
        </div>
      </div>

      {ladder.length > 0 && (
        <>
          <div className="hint" style={{ margin: '10px 0 6px' }}>
            {next ? `Keep your streak going — ${next.days_to_go} day${next.days_to_go === 1 ? '' : 's'} to the next ${next.coins}🪙 bonus.` : 'Every streak milestone reached — incredible! 🎉'}
          </div>
          <div className="coin-ladder">
            {ladder.map((r) => {
              const isNext = !!next && next.day === r.day;
              return (
                <div key={r.day} className={`coin-rung ${r.reached ? 'reached' : ''} ${isNext ? 'next' : ''}`} title={`${r.day}-day streak → ${r.coins} coins`}>
                  <span className="rung-ic">{r.reached ? '✅' : isNext ? '🎯' : '🔒'}</span>
                  <strong>{r.day}d</strong>
                  <span className="hint">{r.coins}🪙</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="eyebrow" style={{ marginTop: 12 }}>Recent</div>
      {history.length === 0 ? (
        <div className="muted" style={{ marginTop: 6 }}>No coin activity yet — finish sets and keep a daily streak to earn coins.</div>
      ) : (
        <div className="stack" style={{ gap: 6, marginTop: 6 }}>
          {history.map((h, i) => (
            <div key={i} className="between coin-row">
              <div><strong style={{ textTransform: 'capitalize' }}>{h.label}</strong><div className="muted">{relTime(h.created_at)}</div></div>
              <strong style={{ color: h.delta >= 0 ? 'var(--green, #22a06b)' : 'var(--danger, #ef5b6b)' }}>{h.delta >= 0 ? '+' : ''}{h.delta}🪙</strong>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Deterministic display emoji per achievement (presentation only — not data). Falls back by key
// so each badge looks distinct; earned badges render in color, locked ones greyscale.
const EMOJI_POOL = ['🏅', '🔥', '⭐', '🎯', '🧠', '🚀', '🏆', '💎', '🌟', '⚡', '🎓', '🧩'];
function emojiFor(key: string): string {
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return EMOJI_POOL[h % EMOJI_POOL.length]!;
}
const rewardPills = (a: Achievement) => (a.rewards ?? []).map((r, i) => {
  if (r.coins) return <span key={i} className="pill" style={{ background: 'var(--amber-tint)', color: 'var(--amber)' }}>🪙 {r.coins}</span>;
  if (r.xp) return <span key={i} className="pill" style={{ background: 'var(--tint-lilac)', color: 'var(--purple)' }}>⭐ {r.xp} XP</span>;
  return <span key={i} className="pill" style={{ background: 'var(--tint-blue)', color: 'var(--primary)' }}>🎁 {r.kind}</span>;
});
const prettyDate = (iso: string | null) => { if (!iso) return ''; try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; } };

function AchievementCard({ a, open, onToggle }: { a: Achievement; open: boolean; onToggle: () => void }) {
  const earned = a.earned;
  return (
    <Card onClick={onToggle} className={open ? 'ach-open' : ''}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="ic" style={{ background: earned ? 'var(--tint-green)' : 'var(--bg)', filter: earned ? 'none' : 'grayscale(1) opacity(.7)', position: 'relative' }}>
          {emojiFor(a.key)}
          <span style={{ position: 'absolute', right: -4, bottom: -4, fontSize: 14 }}>{earned ? '✅' : '🔒'}</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{a.name}</h3>
          <div className="muted">{a.description}</div>
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>{rewardPills(a)}</div>
          {!earned && typeof a.progress_pct === 'number' && (
            <>
              <div className="progress-track" style={{ marginTop: 8 }}><div className="progress-fill" style={{ width: `${a.progress_pct}%` }} /></div>
              <div className="hint" style={{ marginTop: 4 }}>{a.progress_pct}%{a.howto ? ` · 👉 ${a.howto}` : ''}</div>
            </>
          )}
        </div>
        <span className={`ach-chev ${open ? 'up' : ''}`} aria-hidden>▸</span>
      </div>
      {open && (
        <div className="ach-detail">
          <div className="eyebrow">{earned ? '🎁 You earned' : '🎁 Reward when unlocked'}</div>
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>{rewardPills(a)}</div>
          {earned && a.earned_at && <div className="hint" style={{ marginTop: 8 }}>Unlocked {prettyDate(a.earned_at)}</div>}
          {!earned && a.howto && <div className="hint" style={{ marginTop: 8 }}>👉 {a.howto}</div>}
        </div>
      )}
    </Card>
  );
}

export function RewardsScreen() {
  const { loading, error, data, reload } = useAsync(async () => {
    const [summary, achievements, coins] = await Promise.all([
      client.rewardsSummary(), client.achievements(), client.coins().catch(() => null),
    ]);
    return { summary, achievements, coins };
  });
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (k: string) => setOpen((o) => (o === k ? null : k));

  const unlocked = (data?.achievements ?? []).filter((a) => a.earned);
  const locked = (data?.achievements ?? []).filter((a) => !a.earned);
  const coinsEarned = unlocked.reduce((s, a) => s + (a.rewards ?? []).reduce((t, r) => t + (r.coins ?? 0), 0), 0);
  const bonusXp = unlocked.reduce((s, a) => s + (a.rewards ?? []).reduce((t, r) => t + (r.xp ?? 0), 0), 0);
  const total = data?.achievements.length ?? 0;

  return (
    <>
      <AppBar title="Achievements" sub="Earn badges, coins & XP as you learn" back />
      <div className="content stack">
        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {data && (
          <>
            <div className="row" style={{ gap: 10 }}>
              <div className="stat" style={{ flex: 1 }}><div className="n">{unlocked.length}/{total}</div><div className="l">Unlocked</div></div>
              <div className="stat" style={{ flex: 1 }}><div className="n">🪙 {coinsEarned}</div><div className="l">Coins earned</div></div>
              <div className="stat" style={{ flex: 1 }}><div className="n">⭐ {bonusXp}</div><div className="l">Bonus XP</div></div>
            </div>

            {data.coins && <CoinsPanel coins={data.coins} />}

            <div className="eyebrow">✅ Unlocked</div>
            {unlocked.length === 0 && <div className="empty">No badges yet — finish a set to earn your first!</div>}
            {unlocked.map((a) => <AchievementCard key={a.key} a={a} open={open === a.key} onToggle={() => toggle(a.key)} />)}

            <div className="eyebrow">🔒 Locked</div>
            {locked.length === 0 && <div className="muted">Every badge unlocked — amazing! 🎉</div>}
            {locked.map((a) => <AchievementCard key={a.key} a={a} open={open === a.key} onToggle={() => toggle(a.key)} />)}
          </>
        )}
      </div>
    </>
  );
}
