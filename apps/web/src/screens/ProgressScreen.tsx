import { useMemo, useState } from 'react';
import { client } from '../lib/api';
import type { ProgressBreakdownCategory, ProgressQuery, ProgressSummary } from '@ccat/api-client';
import { AppBar, Loader, ErrorNote, useAsync } from '../components/ui';

// PROGRESS PAGE ("P3" bento) — real, data-driven analytics.
//   FILTER  Date range ONLY (wired to gateway ?from=&to=). No category/mode dropdowns.
//   ROW 1   LEFT  "⏱️ Practice time" line chart (hour gridlines + date axis + markers) or an honest
//                 "not enough data yet" placeholder.  RIGHT  2×2 stat tiles.
//   ROW 2   LEFT  "🚀 Readiness" three category bars.  RIGHT  "📝 CCAT exams" last/best/attempts.
//   ROW 3   "🧠 By category & topic" — three category accordions expanding to topic rows.
// Nothing is invented: untracked metrics render "—", empty states render on fresh accounts, and the
// chart shows the placeholder (never a fake line) when there is no time series.

const CAT_VIS: Record<string, { name: string; color: string; tint: string }> = {
  verbal: { name: 'Verbal', color: '#3e7bee', tint: '#eaf0ff' },
  quantitative: { name: 'Quantitative', color: '#22c3a6', tint: '#e8f7f1' },
  non_verbal: { name: 'Non-verbal', color: '#8b5cf6', tint: '#f3ecfb' },
  nonverbal: { name: 'Non-verbal', color: '#8b5cf6', tint: '#f3ecfb' },
};
function catVis(key: string) {
  return CAT_VIS[key] || { name: key, color: 'var(--muted)', tint: '#eef1f6' };
}

const RANGE_OPTIONS = [
  { value: '', label: 'All time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];
function rangeToFrom(days: string): string | undefined {
  if (!days) return undefined;
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}
function fmtMinutes(mins: number | null | undefined): string {
  if (mins == null || mins <= 0) return '—';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
function shortDate(iso: string): string {
  const [ , m, d] = iso.split('-').map(Number);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MON[(m ?? 1) - 1]} ${d}`;
}

// Inline SVG line chart of per-day practice minutes: hour gridlines + left hr labels + date x-axis +
// a circle marker at each point. Rendered only when there are ≥2 points (caller shows placeholder else).
function TimeChart({ points }: { points: { date: string; minutes: number }[] }) {
  const W = 560, H = 200, L = 40, R = 12, T = 12, B = 30;      // viewBox + gutters
  const plotW = W - L - R, plotH = H - T - B;
  const maxMin = Math.max(...points.map((p) => p.minutes), 1);
  const maxHours = Math.max(1, Math.ceil(maxMin / 60));
  const maxScale = maxHours * 60;
  const xAt = (i: number) => L + (points.length > 1 ? (plotW * i) / (points.length - 1) : plotW / 2);
  const yAt = (min: number) => T + plotH * (1 - min / maxScale);
  const coords = points.map((p, i) => [xAt(i), yAt(p.minutes)] as const);
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1]![0].toFixed(1)},${(T + plotH).toFixed(1)} L${coords[0]![0].toFixed(1)},${(T + plotH).toFixed(1)} Z`;
  const hourLines = Array.from({ length: maxHours + 1 }, (_, h) => h);
  // Thin out x labels so they never collide (always first + last).
  const stepLbl = Math.max(1, Math.ceil(points.length / 6));

  return (
    <svg className="time-chart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Practice time per day">
      {hourLines.map((h) => {
        const y = yAt(h * 60);
        return (
          <g key={h}>
            <line x1={L} y1={y} x2={W - R} y2={y} stroke="var(--line)" strokeWidth={1} />
            <text x={L - 6} y={y + 3} textAnchor="end" className="tc-axis">{h}hr</text>
          </g>
        );
      })}
      <path d={area} fill="var(--amber-tint, #fff3db)" opacity={0.6} stroke="none" />
      <path d={line} fill="none" stroke="var(--amber, #f6a821)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {coords.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={3.2} fill="#fff" stroke="var(--amber, #f6a821)" strokeWidth={2} />
      ))}
      {points.map((p, i) => (
        (i % stepLbl === 0 || i === points.length - 1) && (
          <text key={p.date} x={xAt(i)} y={H - 8} textAnchor="middle" className="tc-axis">{shortDate(p.date)}</text>
        )
      ))}
    </svg>
  );
}

export function ProgressScreen() {
  const [range, setRange] = useState('');
  const query = useMemo<ProgressQuery>(() => {
    const q: ProgressQuery = {};
    const from = rangeToFrom(range);
    if (from) q.from = from;
    return q;
  }, [range]);

  const { loading, error, data, reload } = useAsync(async () => {
    const [summary, breakdown] = await Promise.all([
      client.progressSummary(query),
      client.progressBreakdown(query),
    ]);
    return { summary, breakdown } as { summary: ProgressSummary; breakdown: ProgressBreakdownCategory[] };
  }, [query]);

  return (
    <>
      <AppBar title="Progress & Analytics" sub="Your real practice data" back />
      <div className="content content-wide">
        {/* FILTER — date range only */}
        <div className="prog-filters" role="group" aria-label="Filters">
          <label className="pf-field">
            <span className="pf-lbl">Date range</span>
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>

        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}

        {data && (() => {
          const s = data.summary;
          const series = s.practiceTimeSeries ?? [];
          return (
            <div className="p3-grid">
              {/* ROW 1 — practice-time chart (2fr) + 2×2 stats (1fr) */}
              <div className="rail-card p3-chart">
                <div className="eyebrow">⏱️ Practice time</div>
                <div className="pt-head">{fmtMinutes(s.practiceTimeMinutes)}</div>
                {series.length >= 2
                  ? <TimeChart points={series} />
                  : <div className="muted pt-empty">Not enough data yet — practise on more days to see your trend.</div>}
              </div>

              <div className="stat-2x2 p3-stats">
                <div className="s2-tile s2-q"><span className="s2-ic">📝</span><span className="s2-n">{s.questionsAnswered}</span><span className="s2-l">Questions</span></div>
                <div className="s2-tile s2-s"><span className="s2-ic">✅</span><span className="s2-n">{s.setsCompleted}</span><span className="s2-l">Sets</span></div>
                <div className="s2-tile s2-a"><span className="s2-ic">🎯</span><span className="s2-n">{s.avgAccuracy == null ? '—' : `${s.avgAccuracy}%`}</span><span className="s2-l">Accuracy</span></div>
                <div className="s2-tile s2-m"><span className="s2-ic">🧪</span><span className="s2-n">{s.mockExamsTaken}</span><span className="s2-l">Mocks</span></div>
              </div>

              {/* ROW 2 — readiness bars (2fr) + exams (1fr) */}
              <div className="rail-card p3-readiness">
                <div className="eyebrow">🚀 Readiness</div>
                <div className="rdy-list">
                  {s.readiness.map((r) => {
                    const cv = catVis(r.category);
                    const pct = r.pct ?? 0;
                    return (
                      <div key={r.category} className="rdy-row">
                        <span className="rdy-name">{cv.name}</span>
                        <div className="rdy-track">
                          <div className="rdy-fill" style={{ width: `${pct}%`, background: cv.color }} />
                        </div>
                        <span className="rdy-pct">{r.pct == null ? '—' : `${r.pct}%`}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rail-card p3-exams">
                <div className="eyebrow">📝 CCAT exams</div>
                {s.exams.attempts === 0 ? (
                  <div className="muted exams-empty">No exams taken yet — try a timed mock!</div>
                ) : (
                  <div className="exams-stats">
                    <div className="ex-row"><span className="ex-l">Last score</span><strong>{s.exams.lastScore ? `${s.exams.lastScore.score}/${s.exams.lastScore.total}` : '—'}</strong></div>
                    <div className="ex-row"><span className="ex-l">Best accuracy</span><strong>{s.exams.bestAccuracyPct == null ? '—' : `${s.exams.bestAccuracyPct}%`}</strong></div>
                    <div className="ex-row"><span className="ex-l">Attempts</span><strong>{s.exams.attempts}</strong></div>
                  </div>
                )}
              </div>

              {/* ROW 3 — by category & topic (full width) */}
              <div className="rail-card p3-breakdown">
                <div className="eyebrow">🧠 By category &amp; topic</div>
                <div className="bd-cats">
                  {data.breakdown.map((c) => {
                    const cv = catVis(c.category);
                    return (
                      <details key={c.category} className="bd-cat" style={{ ['--cat' as any]: cv.color }}>
                        <summary className="bd-summary">
                          <span className="bd-cat-dot" style={{ background: cv.color }} aria-hidden />
                          <span className="bd-cat-name">{cv.name}</span>
                          <span className="bd-cat-acc">{c.accuracyPct == null ? '—' : `${c.accuracyPct}%`}</span>
                          <span className="bd-chev" aria-hidden>▾</span>
                        </summary>
                        {c.topics.length === 0 ? (
                          <div className="muted bd-empty">No practice in this category yet.</div>
                        ) : (
                          <div className="bd-topics">
                            {c.topics.map((t) => (
                              <div key={t.subcategory} className="bd-topic">
                                <div className="bt-name">{t.subcategory}</div>
                                <div className="bt-metrics">
                                  <span className="bt-m"><span className="bt-k">Accuracy</span>{t.accuracyPct == null ? '—' : `${t.accuracyPct}%`}</span>
                                  <span className="bt-m"><span className="bt-k">Avg time/q</span>{t.avgSecondsPerQuestion == null ? '—' : `${t.avgSecondsPerQuestion}s`}</span>
                                  <span className="bt-m"><span className="bt-k">Completion</span>{t.completionPct == null ? '—' : `${t.completionPct}%`}</span>
                                  <span className="bt-m"><span className="bt-k">Questions</span>{t.questionsDone}</span>
                                  <span className="bt-m"><span className="bt-k">Best streak</span>🔥 {t.bestStreak}</span>
                                  <span className="bt-m"><span className="bt-k">Last practised</span>{t.lastPractisedLabel}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </details>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </>
  );
}
