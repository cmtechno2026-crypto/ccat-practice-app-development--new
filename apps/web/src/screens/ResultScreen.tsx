import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { pct, mmss } from '@ccat/client-core';
import { ApiError } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Loader, ErrorNote, Card, useAsync } from '../components/ui';

export function ResultScreen() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { flash } = useApp();
  const [retrying, setRetrying] = useState(false);
  const { loading, error, data, reload } = useAsync(async () => {
    const [result, session] = await Promise.all([
      client.sessionResult(id),
      client.getSession(id).catch(() => null), // for set metadata + retry
    ]);
    return { result, session };
  }, [id]);

  async function tryAgain() {
    if (!data?.session) return nav('/practice');
    setRetrying(true);
    const s = data.session;
    try {
      const min = s.duration_seconds ? Math.round(s.duration_seconds / 60) : null;
      const ns = await client.sessionStart(s.set_version_id, s.mode, s.timer_type, min ? min * 60 : undefined);
      nav(`/session/${ns.id}`, { replace: true });
    } catch (e) {
      setRetrying(false);
      flash(e instanceof ApiError ? (e.code === 'ACTIVE_SESSION_EXISTS' ? 'Finish your current session first.' : e.message) : 'Could not start again.');
    }
  }

  const r = data?.result;
  const accuracy = r ? pct(r.score_correct, r.score_total) : 0;
  const timedOut = !!r?.timed_out;
  const emoji = timedOut ? '⏰' : accuracy >= 90 ? '🏆' : accuracy >= 70 ? '🎉' : '💪';
  const title = timedOut ? "Time's up!" : accuracy >= 90 ? 'Superstar!' : accuracy >= 70 ? 'Great job!' : 'Nice try!';
  const sess = data?.session;
  const subLine = sess ? [sess.subcategory, sess.set_name, sess.difficulty].filter(Boolean).join(' · ') : '';

  return (
    <>
      <AppBar title="Your result" />
      <div className="content stack center-narrow">
        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {r && (
          <>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 56 }}>{emoji}</div>
              <h1>{title}</h1>
              {subLine && <div className="muted" style={{ marginTop: 4 }}>{subLine}</div>}
            </div>
            <div className="result-tri">
              <div className="stat"><div className="n">{r.score_correct}/{r.score_total}</div><div className="l">Correct</div></div>
              <div className="stat"><div className="n">{accuracy}%</div><div className="l">Accuracy</div></div>
              <div className="stat"><div className="n">+{r.xp_awarded}</div><div className="l">XP</div></div>
              <div className="stat"><div className="n">🪙 {r.coins_awarded}</div><div className="l">Coins</div></div>
            </div>
            {r.mode === 'exam' && !!r.by_battery?.length && (
              <Card>
                <div className="eyebrow">📊 By battery</div>
                <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                  {r.by_battery.map((b) => {
                    const label = b.category_key.replace('_', '-');
                    const skipped = b.total - b.attempted;
                    return (
                      <div key={b.category_key} className="between">
                        <div style={{ textTransform: 'capitalize' }}><strong>{label}</strong><div className="muted">{b.attempted}/{b.total} attempted{skipped > 0 ? ` · ${skipped} skipped` : ''}</div></div>
                        <span className="pill">{b.correct}/{b.total}</span>
                      </div>
                    );
                  })}
                </div>
                {typeof r.attempted_count === 'number' && <div className="hint" style={{ marginTop: 8 }}>Saved to your Progress · {r.attempted_count}/{r.score_total} attempted</div>}
              </Card>
            )}
            {typeof r.time_spent_seconds === 'number' && (
              <Card>
                <div className="between">
                  <div className="eyebrow">{timedOut ? '⏰ Auto-submitted' : '⏱ Completed in'}</div>
                  <strong>{r.timer_type === 'timed' || r.time_spent_seconds > 0 ? mmss(r.time_spent_seconds) : '—'}</strong>
                </div>
              </Card>
            )}
            {!!r.achievements_unlocked?.length && (
              <Card>
                <div className="eyebrow">🏅 Unlocked</div>
                <div className="stack" style={{ gap: 6, marginTop: 6 }}>
                  {r.achievements_unlocked.map((a) => <div key={a.key} className="row"><span>🏅</span><strong>{a.name}</strong></div>)}
                </div>
              </Card>
            )}
            <button className="btn" disabled={retrying} onClick={tryAgain}>{retrying ? '…' : '🔁 Try again'}</button>
            <button className="btn secondary" onClick={() => nav(sess?.mode === 'exam' ? '/practice?mode=exam' : '/practice')}>Back to sets</button>
            <button className="btn ghost" onClick={() => nav('/home')}>Go to Home</button>
          </>
        )}
      </div>
    </>
  );
}
