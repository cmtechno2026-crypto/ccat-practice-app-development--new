import { useMemo, useState } from 'react';
import { client } from '../lib/api';
import type { ProgressQuery, ProgressSetRow, ProgressSummary, ProgressSetReview } from '@ccat/api-client';
import { AppBar, Loader, ErrorNote, useAsync, Figure } from '../components/ui';

// PROGRESS PAGE ("P1" + preview panel).
//   ROW 1  practice-time chart + per-battery "done/total" sets-done boxes (combine excluded, no Total box).
//   "Battery Tests" card: tabs → one box per SUBCATEGORY (accuracy %, combine included) → Sets table
//   (Set | Description | Accuracy | Score | Avg time/q). Clicking a Set name opens a slide-in review of
//   the child's latest submitted attempt on the right; the page shrinks to make room (never overlapped).

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
const isCombine = (k: string) => k.endsWith('_battery_combine');

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
function fmtSeconds(sec: number | null | undefined): string {
  if (sec == null || sec <= 0) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
function shortDate(iso: string): string {
  const [ , m, d] = iso.split('-').map(Number);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MON[(m ?? 1) - 1]} ${d}`;
}
// Plain text from a content block array ([{type:'text',value}, {type:'image',…}]).
function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b: any) => b && b.type === 'text' && typeof b.value === 'string').map((b: any) => b.value).join(' ').trim();
}

function TimeChart({ points }: { points: { date: string; minutes: number }[] }) {
  const W = 560, H = 200, L = 40, R = 12, T = 12, B = 30;
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
      {hourLines.map((h) => { const y = yAt(h * 60); return (
        <g key={h}><line x1={L} y1={y} x2={W - R} y2={y} stroke="var(--line)" strokeWidth={1} /><text x={L - 6} y={y + 3} textAnchor="end" className="tc-axis">{h}hr</text></g>); })}
      <path d={area} fill="var(--amber-tint, #fff3db)" opacity={0.6} stroke="none" />
      <path d={line} fill="none" stroke="var(--amber, #f6a821)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {coords.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={3.2} fill="#fff" stroke="var(--amber, #f6a821)" strokeWidth={2} />)}
      {points.map((p, i) => (i % stepLbl === 0 || i === points.length - 1) && (
        <text key={p.date} x={xAt(i)} y={H - 8} textAnchor="middle" className="tc-axis">{shortDate(p.date)}</text>))}
    </svg>
  );
}

// Slide-in review panel body (fetches the latest submitted attempt for the set).
function SetReviewPanel({ setId, setLabel, onClose }: { setId: string; setLabel: string; onClose: () => void }) {
  const { loading, error, data, reload } = useAsync(async () => client.progressSetReview(setId) as Promise<ProgressSetReview>, [setId]);
  return (
    <div className="sp-in">
      <div className="sp-head">
        <h3>{setLabel}</h3>
        <button className="sp-x" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="sp-body">
        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {data && !data.found && <div className="muted" style={{ padding: '8px 2px' }}>No submitted attempt for this set yet.</div>}
        {data && data.found && (
          <>
            <div className="sp-sum">
              <div className="a"><span className="n">{data.score.total > 0 ? `${data.score.correct}/${data.score.total}` : '—'}</span><span className="l">Score</span></div>
              <div className="a"><span className="n">{data.accuracyPct == null ? '—' : `${data.accuracyPct}%`}</span><span className="l">Accuracy</span></div>
              <div className="a"><span className="n">{fmtSeconds(data.timeSeconds)}</span><span className="l">Time</span></div>
            </div>
            {data.questions.map((q, i) => (
              <div key={q.question_version_id} className="sp-q">
                <div className="sp-qh"><span>Question {i + 1}</span><span className={q.correct ? 'ok' : (q.answered ? 'bad' : 'muted')}>{q.correct ? '✓ Correct' : (q.answered ? '✗ Incorrect' : 'Not answered')}</span></div>
                {blocksText(q.prompt_blocks) && <div className="sp-qt">{blocksText(q.prompt_blocks)}</div>}
                <Figure url={q.image_url} kind="question" />
                <div className="sp-opts">
                  {q.options.map((o) => (
                    <div key={o.option_id} className={`sp-opt ${o.correct ? 'correct' : (o.selected ? 'wrong' : '')}`}>
                      <span className="sp-ot">{blocksText(o.content) || ''}</span>
                      <Figure url={o.image_url} kind="option" />
                      <span className="sp-mk">{o.correct ? '✓' : (o.selected ? '✗' : '')}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export function ProgressScreen() {
  const [range, setRange] = useState('');
  const [tab, setTab] = useState<string | null>(null);
  const [sub, setSub] = useState('');
  const [preview, setPreview] = useState<{ id: string; label: string } | null>(null);
  const query = useMemo<ProgressQuery>(() => {
    const q: ProgressQuery = {};
    const from = rangeToFrom(range);
    if (from) q.from = from;
    return q;
  }, [range]);

  const { loading, error, data, reload } = useAsync(async () => client.progressSummary(query) as Promise<ProgressSummary>, [query]);

  const batteries = data?.batteries ?? [];
  const active = batteries.find((b) => b.key === tab) ?? batteries[0] ?? null;
  const activeKey = active?.key ?? null;
  const subOptions = active?.subcategories ?? [];
  const subActive = subOptions.some((s) => s.key === sub) ? sub : '';
  // colour index per subcategory (for the Description chips), stable within the battery
  const subColor = new Map(subOptions.map((s, i) => [s.key, i % 6] as const));

  const setsAsync = useAsync(
    async () => (activeKey ? await client.progressSets({ battery: activeKey, subcategory: subActive || 'all', ...query }) : ([] as ProgressSetRow[])),
    [activeKey, subActive, query],
  );
  const setsShown = setsAsync.data ?? [];

  return (
    <div className={`prog-shell ${preview ? 'paneled' : ''}`}>
      <div className="prog-col">
        <AppBar title="Progress & Analytics" sub="Your real practice data" back wide />
        <div className="content content-wide">
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
            return (
              <div className="p1-grid">
                <div className="rail-card p1-chart">
                  <div className="eyebrow">⏱️ Overall practice time</div>
                  <div className="pt-head">{fmtMinutes(s.practiceTimeMinutes)}</div>
                  {series.length >= 2 ? <TimeChart points={series} /> : <div className="muted pt-empty">Not enough data yet — practise on more days to see your trend.</div>}
                </div>

                {/* per-battery done/total (combine excluded); no Total box */}
                <div className="p1-setsdone">
                  {batteries.map((b) => (
                    <div key={b.key} className={`sd-box sd-${b.key}`}>
                      <span className="sd-n">{b.setsDone}/{b.setsTotal}</span>
                      <span className="sd-l">{catVis(b.key).name}</span>
                      <span className="sd-sub">sets done</span>
                    </div>
                  ))}
                </div>

                <div className="rail-card p1-battery">
                  <div className="eyebrow">🧠 Battery Tests</div>
                  {batteries.length === 0 ? (
                    <div className="muted" style={{ marginTop: 10 }}>No practice yet — start a set to see your battery breakdown.</div>
                  ) : (
                    <>
                      <div className="bt-tabs" role="tablist">
                        {batteries.map((b) => {
                          const cv = catVis(b.key); const on = b.key === activeKey;
                          return (
                            <button key={b.key} role="tab" aria-selected={on} className={`bt-tab ${on ? 'on' : ''}`}
                              style={on ? { ['--cat' as any]: cv.color } : undefined}
                              onClick={() => { setTab(b.key); setSub(''); }}>
                              <span className="bt-tab-dot" style={{ background: cv.color }} aria-hidden />{cv.name}
                            </button>
                          );
                        })}
                      </div>

                      {active && (
                        <>
                          {/* one box per subcategory (combine included) — accuracy % */}
                          <div className="subacc-grid">
                            {active.subcategories.map((sc) => (
                              <div key={sc.key} className={`subacc ${isCombine(sc.key) ? 'combine' : ''}`}>
                                <span className="subacc-n">{sc.accuracyPct == null ? '—' : `${sc.accuracyPct}%`}</span>
                                <span className="subacc-l">{sc.name}</span>
                              </div>
                            ))}
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

                          {setsAsync.loading ? <Loader />
                            : setsAsync.error ? <ErrorNote error={setsAsync.error} onRetry={setsAsync.reload} />
                            : setsShown.length === 0 ? <div className="muted bt-sets-empty">No sets in this battery yet.</div>
                            : (
                              <div className="bt-table-wrap">
                                <table className="bt-table">
                                  <thead><tr><th>Set</th><th>Description</th><th>Accuracy (%)</th><th>Score</th><th>Avg time/q</th></tr></thead>
                                  <tbody>
                                    {setsShown.map((row, i) => {
                                      const label = `Set ${i + 1}`;
                                      return (
                                        <tr key={row.setId}>
                                          <td><button className="set-link" onClick={() => setPreview({ id: row.setId, label })}>{label}</button></td>
                                          <td><span className={`desc-chip dc${subColor.get(row.subcategory.key) ?? 0}`}>{row.subcategory.name}</span></td>
                                          <td>{row.accuracyPct == null ? '—' : `${row.accuracyPct}%`}</td>
                                          <td>{row.score.total > 0 ? `${row.score.correct}/${row.score.total}` : '—'}</td>
                                          <td>{row.avgSecondsPerQuestion == null ? '—' : `${row.avgSecondsPerQuestion}s`}</td>
                                        </tr>
                                      );
                                    })}
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
      </div>

      <aside className={`set-panel ${preview ? 'open' : ''}`} aria-hidden={!preview}>
        {preview && <SetReviewPanel setId={preview.id} setLabel={preview.label} onClose={() => setPreview(null)} />}
      </aside>
    </div>
  );
}
