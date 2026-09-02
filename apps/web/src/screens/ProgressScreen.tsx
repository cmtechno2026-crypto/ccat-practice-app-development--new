import { useMemo, useState } from 'react';
import { client } from '../lib/api';
import type { ProgressQuery, ProgressSetRow, ProgressSummary } from '@ccat/api-client';
import { AppBar, Loader, ErrorNote, useAsync } from '../components/ui';

// PROGRESS PAGE ("P1") — real, data-driven analytics.
//   FILTER  Date range ONLY (wired to gateway ?from=&to=). No category/mode dropdowns.
//   ROW 1   LEFT (~1.6fr) "⏱️ Overall practice time": headline total + per-day line chart (hour
//                 gridlines + date axis + markers) or an honest "not enough data yet" placeholder.
//           RIGHT (~1fr)  2×2 of FOUR uniform "sets done" boxes — one per battery + Total (Total is
//                 just the sum; styled identically, never special).
//   ROW 2   "🧠 Battery Tests": one tab per battery. The selected tab shows FOUR metric boxes
//                 (Accuracy % · Score · Total Question · Avg time/q) and a "Sets" table with a
//                 subcategory filter; rows are the sets in that battery, filtered by subcategory.
// Data: GET /v1/progress/summary (score, setsDone, practice time, batteries[]) + GET /v1/progress/sets
// (per-set rows for the active battery + subcategory). Numbers reconcile server-side. Nothing invented:
// avgSecondsPerQuestion renders "—" (not tracked), empty states render on fresh accounts, and the chart
// shows the placeholder (never a fake line) when there is no time series.

// Per-battery visuals. Colours fixed per spec (Verbal blue, Quant teal, Non-verbal purple); short names
// for the known keys with a prettified fallback so any category the gateway returns still renders.
// Order everywhere follows what the summary returns (never hard-coded).
const CAT_VIS: Record<string, { name: string; color: string }> = {
  verbal: { name: 'Verbal', color: '#3e7bee' },
  quantitative: { name: 'Quantitative', color: '#22c3a6' },
  non_verbal: { name: 'Non-verbal', color: '#8b5cf6' },
  nonverbal: { name: 'Non-verbal', color: '#8b5cf6' },
};
function catVis(key: string) {
  const hit = CAT_VIS[key];
  if (hit) return hit;
  const name = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { name, color: 'var(--purple)' };
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
  const [tab, setTab] = useState<string | null>(null);       // selected battery key (null → first)
  const [sub, setSub] = useState('');                        // subcategory key filter ('' = All)
  const query = useMemo<ProgressQuery>(() => {
    const q: ProgressQuery = {};
    const from = rangeToFrom(range);
    if (from) q.from = from;
    return q;
  }, [range]);

  const { loading, error, data, reload } = useAsync(
    async () => client.progressSummary(query) as Promise<ProgressSummary>,
    [query],
  );

  const batteries = data?.batteries ?? [];
  // Selected battery: the chosen tab if it still exists, else the first battery.
  const active = batteries.find((b) => b.key === tab) ?? batteries[0] ?? null;
  const activeKey = active?.key ?? null;
  const subOptions = active?.subcategories ?? [];
  const subActive = subOptions.some((s) => s.key === sub) ? sub : '';

  // Per-set rows for the active battery + subcategory (own request; reconciles with the battery totals).
  const setsAsync = useAsync(
    async () => (activeKey
      ? await client.progressSets({ battery: activeKey, subcategory: subActive || 'all', ...query })
      : ([] as ProgressSetRow[])),
    [activeKey, subActive, query],
  );
  const setsShown = setsAsync.data ?? [];

  return (
    <>
      <AppBar title="Progress & Analytics" sub="Your real practice data" back wide />
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
          const s = data;
          const series = s.practiceTimeSeries ?? [];
          const totalSets = s.setsDone ?? 0;

          return (
            <div className="p1-grid">
              {/* ROW 1 — practice-time chart (1.6fr) + 2×2 sets-done boxes (1fr) */}
              <div className="rail-card p1-chart">
                <div className="eyebrow">⏱️ Overall practice time</div>
                <div className="pt-head">{fmtMinutes(s.practiceTimeMinutes)}</div>
                {series.length >= 2
                  ? <TimeChart points={series} />
                  : <div className="muted pt-empty">Not enough data yet — practise on more days to see your trend.</div>}
              </div>

              <div className="p1-setsdone">
                {batteries.map((b) => (
                  <div key={b.key} className={`sd-box sd-${b.key}`}>
                    <span className="sd-n">{b.setsDone}</span>
                    <span className="sd-l">{catVis(b.key).name}</span>
                    <span className="sd-sub">sets done</span>
                  </div>
                ))}
                <div className="sd-box sd-total">
                  <span className="sd-n">{totalSets}</span>
                  <span className="sd-l">Total</span>
                  <span className="sd-sub">sets done</span>
                </div>
              </div>

              {/* ROW 2 — Battery Tests (full width): tabs → four metric boxes → sets table */}
              <div className="rail-card p1-battery">
                <div className="eyebrow">🧠 Battery Tests</div>

                {batteries.length === 0 ? (
                  <div className="muted" style={{ marginTop: 10 }}>No practice yet — start a set to see your battery breakdown.</div>
                ) : (
                  <>
                    <div className="bt-tabs" role="tablist">
                      {batteries.map((b) => {
                        const cv = catVis(b.key);
                        const on = b.key === activeKey;
                        return (
                          <button
                            key={b.key}
                            role="tab"
                            aria-selected={on}
                            className={`bt-tab ${on ? 'on' : ''}`}
                            style={on ? { ['--cat' as any]: cv.color } : undefined}
                            onClick={() => { setTab(b.key); setSub(''); }}
                          >
                            <span className="bt-tab-dot" style={{ background: cv.color }} aria-hidden />
                            {cv.name}
                          </button>
                        );
                      })}
                    </div>

                    {active && (
                      <>
                        <div className="bt-boxes">
                          <div className="bt-box bt-acc">
                            <span className="btb-n">{active.accuracyPct == null ? '—' : `${active.accuracyPct}%`}</span>
                            <span className="btb-l">Accuracy</span>
                          </div>
                          <div className="bt-box bt-score">
                            <span className="btb-n">{active.score.total > 0 ? `${active.score.correct}/${active.score.total}` : '—'}</span>
                            <span className="btb-l">Score</span>
                          </div>
                          <div className="bt-box bt-tq">
                            <span className="btb-n">{active.totalQuestions || '—'}</span>
                            <span className="btb-l">Total Question</span>
                          </div>
                          <div className="bt-box bt-avg">
                            <span className="btb-n">{active.avgSecondsPerQuestion == null ? '—' : `${active.avgSecondsPerQuestion}s`}</span>
                            <span className="btb-l">Avg time/q</span>
                          </div>
                        </div>

                        <div className="bt-sets-head">
                          <div className="eyebrow">Sets</div>
                          <label className="pf-field bt-subfilter">
                            <span className="pf-lbl">Subcategory</span>
                            <select value={subActive} onChange={(e) => setSub(e.target.value)}>
                              <option value="">All</option>
                              {subOptions.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
                            </select>
                          </label>
                        </div>

                        {setsAsync.loading ? (
                          <Loader />
                        ) : setsAsync.error ? (
                          <ErrorNote error={setsAsync.error} onRetry={setsAsync.reload} />
                        ) : setsShown.length === 0 ? (
                          <div className="muted bt-sets-empty">No sets in this battery yet.</div>
                        ) : (
                          <div className="bt-table-wrap">
                            <table className="bt-table">
                              <thead>
                                <tr>
                                  <th>Set</th>
                                  <th>Accuracy (%)</th>
                                  <th>Score (correct/total)</th>
                                  <th className="ta-center">Total Question</th>
                                  <th>Avg time/q</th>
                                </tr>
                              </thead>
                              <tbody>
                                {setsShown.map((row, i) => (
                                  <tr key={row.setId}>
                                    <td>Set {i + 1}</td>
                                    <td>{row.accuracyPct == null ? '—' : `${row.accuracyPct}%`}</td>
                                    <td>{row.score.total > 0 ? `${row.score.correct}/${row.score.total}` : '—'}</td>
                                    <td className="ta-center">{row.totalQuestions || '—'}</td>
                                    <td>{row.avgSecondsPerQuestion == null ? '—' : `${row.avgSecondsPerQuestion}s`}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </>
  );
}
