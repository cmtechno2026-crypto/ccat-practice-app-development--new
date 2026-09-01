import { useMemo, useState } from 'react';
import { client } from '../lib/api';
import type { ProgressActivityEvent, ProgressQuery, ProgressSummary } from '@ccat/api-client';
import { AppBar, Loader, ErrorNote, useAsync } from '../components/ui';

// PROGRESS PAGE ("B4-1") — a real, data-driven two-column analytics view.
//   TOP    filter row (Date range · Category · Mode) wired to the gateway query params.
//   LEFT   rail (~320px): "⏱️ Practice time" card (headline + inline SVG line chart, or an honest
//          "not enough data yet" placeholder) + a 2×2 grid of stat tiles.
//   RIGHT  "🕑 Recent activity" vertical timeline from /v1/progress/activity.
// Every value comes from the gateway. Nothing is invented: metrics that aren't tracked render "—",
// and an empty activity feed shows a clear empty state. Day labels are DATE-ONLY (never a clock time).

// Category VISUALS reused from PracticeScreen (single visual vocabulary across the app).
const CAT_VIS: Record<string, { name: string; color: string; tint: string }> = {
  verbal: { name: 'Verbal', color: '#3e7bee', tint: '#eaf0ff' },
  quantitative: { name: 'Quantitative', color: '#22c3a6', tint: '#e8f7f1' },
  non_verbal: { name: 'Non-verbal', color: '#8b5cf6', tint: '#f3ecfb' },
  nonverbal: { name: 'Non-verbal', color: '#8b5cf6', tint: '#f3ecfb' },
};
function catVis(key: string | null) {
  return (key && CAT_VIS[key]) || { name: key ?? '', color: 'var(--muted)', tint: '#eef1f6' };
}

// Which filters the gateway actually applies server-side (reported in the PROGRESS backend report).
// All three are LIVE for /v1/progress/activity; on the summary, category/mode/date narrow the answered/
// accuracy/time/completion metrics. We render every control as live — none are inert.
const CATEGORY_OPTIONS = [
  { value: '', label: 'All categories' },
  { value: 'verbal', label: 'Verbal' },
  { value: 'quantitative', label: 'Quantitative' },
  { value: 'non_verbal', label: 'Non-verbal' },
];
const MODE_OPTIONS = [
  { value: '', label: 'Practice & Exam' },
  { value: 'practice', label: 'Practice only' },
  { value: 'exam', label: 'Exam only' },
];
// Date range → concrete `from` ISO (to = now). Kept presentational; the gateway filters on the value.
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
function accuracyClass(pct: number | null): string {
  if (pct == null) return '';
  if (pct >= 80) return 'acc-good';
  if (pct >= 50) return 'acc-mid';
  return 'acc-low';
}

// Small inline SVG line chart of per-day practice minutes. Renders ONLY when there are ≥2 days with
// data — otherwise the caller shows the "not enough data yet" placeholder (never a fake line).
function TimeChart({ points }: { points: { label: string; minutes: number }[] }) {
  const W = 280, H = 84, PAD = 6;
  const max = Math.max(...points.map((p) => p.minutes), 1);
  const stepX = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - (p.minutes / max) * (H - PAD * 2);
    return [x, y] as const;
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1]![0].toFixed(1)},${H - PAD} L${coords[0]![0].toFixed(1)},${H - PAD} Z`;
  return (
    <svg className="time-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Practice time trend">
      <path d={area} fill="var(--tint-orange, #fff1e0)" stroke="none" />
      <path d={line} fill="none" stroke="var(--amber, #f6a821)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {coords.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={2.6} fill="var(--amber, #f6a821)" />
      ))}
    </svg>
  );
}

export function ProgressScreen() {
  const [range, setRange] = useState('');
  const [category, setCategory] = useState('');
  const [mode, setMode] = useState('');

  const query = useMemo<ProgressQuery>(() => {
    const q: ProgressQuery = {};
    const from = rangeToFrom(range);
    if (from) q.from = from;
    if (category) q.category = category;
    if (mode === 'practice' || mode === 'exam') q.mode = mode;
    return q;
  }, [range, category, mode]);

  const { loading, error, data, reload } = useAsync(async () => {
    const [summary, activity] = await Promise.all([
      client.progressSummary(query),
      client.progressActivity({ ...query, limit: 20 }),
    ]);
    return { summary, activity } as { summary: ProgressSummary; activity: ProgressActivityEvent[] };
  }, [query]);

  return (
    <>
      <AppBar title="Progress & Analytics" sub="Your real practice data" back />
      <div className="content">
        {/* FILTER ROW — all three wired to the gateway query params */}
        <div className="prog-filters" role="group" aria-label="Filters">
          <label className="pf-field">
            <span className="pf-lbl">Date range</span>
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="pf-field">
            <span className="pf-lbl">Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="pf-field">
            <span className="pf-lbl">Mode</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              {MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>

        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}

        {data && (() => {
          const s = data.summary;
          // Build a per-day minutes series from the activity feed (date-only buckets, chronological).
          const byDay = new Map<string, number>();
          for (const ev of data.activity) {
            if (ev.timeMinutes == null) continue;
            const key = ev.sortDate.slice(0, 10);
            byDay.set(key, (byDay.get(key) ?? 0) + ev.timeMinutes);
          }
          const chartPoints = [...byDay.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([label, minutes]) => ({ label, minutes }));

          return (
            <div className="prog-grid">
              {/* LEFT RAIL */}
              <aside className="prog-rail">
                <div className="rail-card">
                  <div className="eyebrow">⏱️ Practice time</div>
                  <div className="pt-head">{fmtMinutes(s.timeSpentMinutes)}</div>
                  {chartPoints.length >= 2
                    ? <TimeChart points={chartPoints} />
                    : <div className="muted pt-empty">Not enough data yet — practise on more days to see your trend.</div>}
                </div>

                <div className="stat-2x2">
                  <div className="s2-tile s2-q">
                    <span className="s2-ic">📝</span>
                    <span className="s2-n">{s.questionsAnswered}</span>
                    <span className="s2-l">Questions</span>
                  </div>
                  <div className="s2-tile s2-s">
                    <span className="s2-ic">✅</span>
                    <span className="s2-n">{s.setsCompleted}</span>
                    <span className="s2-l">Sets</span>
                  </div>
                  <div className="s2-tile s2-a">
                    <span className="s2-ic">🎯</span>
                    <span className="s2-n">{s.avgAccuracy == null ? '—' : `${s.avgAccuracy}%`}</span>
                    <span className="s2-l">Accuracy</span>
                  </div>
                  <div className="s2-tile s2-m">
                    <span className="s2-ic">🧪</span>
                    <span className="s2-n">{s.mockExamsTaken}</span>
                    <span className="s2-l">Mocks</span>
                  </div>
                </div>
              </aside>

              {/* RIGHT COLUMN — recent activity timeline */}
              <section className="prog-main">
                <div className="rail-card">
                  <div className="eyebrow">🕑 Recent activity</div>
                  {data.activity.length === 0 ? (
                    <div className="muted act-empty">No activity yet — complete a set to see it here.</div>
                  ) : (
                    <ol className="timeline">
                      {data.activity.map((ev) => {
                        const isBadge = ev.type === 'badge';
                        const cv = catVis(ev.category);
                        const icon = isBadge ? '🏅' : ev.type === 'exam' ? '🧪' : '📘';
                        return (
                          <li key={`${ev.type}-${ev.id}`} className="tl-item">
                            <span className="tl-node" style={{ background: isBadge ? 'var(--tint-amber, #fff3db)' : cv.tint }} aria-hidden>{icon}</span>
                            <div className="tl-body">
                              <div className="tl-top">
                                <span className="tl-title">{ev.title}</span>
                                <span className="tl-day">{ev.dayLabel}</span>
                              </div>
                              <div className="tl-meta">
                                {isBadge ? (
                                  <span className="tl-tag" style={{ background: 'var(--tint-amber, #fff3db)', color: 'var(--amber, #d9902a)' }}>Badge earned</span>
                                ) : (
                                  <>
                                    {ev.category && (
                                      <span className="tl-tag" style={{ background: cv.tint, color: cv.color }}>{cv.name}</span>
                                    )}
                                    {ev.accuracyPct != null && (
                                      <span className={`tl-acc ${accuracyClass(ev.accuracyPct)}`}>{ev.accuracyPct}%</span>
                                    )}
                                    {ev.questions != null && <span className="tl-sub">· {ev.questions} Q</span>}
                                    {ev.timeMinutes != null && <span className="tl-sub">· {ev.timeMinutes} min</span>}
                                  </>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              </section>
            </div>
          );
        })()}
      </div>
    </>
  );
}
