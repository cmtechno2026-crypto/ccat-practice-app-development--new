import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import type { ProgressQuery, ProgressSetRow, ProgressSummary, ProgressSetReview, ExamHistoryItem } from '@ccat/api-client';
import { AppBar, Loader, ErrorNote, useAsync, Figure } from '../components/ui';
import { capsOf, PAYMENTS_ENABLED } from '../lib/entitlements';

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

// Slide-in review panel body (fetches the latest submitted attempt for the set). Includes filter
// toggles: show/hide explanations, and show/hide correct vs incorrect (incl. unanswered) questions.
function SetReviewPanel({ setId, setLabel, onClose }: { setId: string; setLabel: string; onClose: () => void }) {
  const { loading, error, data, reload } = useAsync(async () => client.progressSetReview(setId) as Promise<ProgressSetReview>, [setId]);
  const [showExpl, setShowExpl] = useState(true);
  const [showCorrect, setShowCorrect] = useState(true);
  const [showIncorrect, setShowIncorrect] = useState(true);

  const all = data?.questions ?? [];
  // "Incorrect" here also covers unanswered (anything not correct).
  const shown = all.filter((q) => (q.correct ? showCorrect : showIncorrect));

  const chk = (checked: boolean, onChange: () => void, label: string) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 12.5, color: '#e9edff', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ accentColor: '#fff', width: 15, height: 15 }} />{label}
    </label>
  );

  return (
    <div className="sp-in">
      <div className="sp-head">
        <h3>{setLabel}</h3>
        <button className="sp-x" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      {data && data.found && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', padding: '10px 16px', background: 'linear-gradient(90deg,#4b3bd6,#6d4bff)' }}>
          {chk(showExpl, () => setShowExpl((v) => !v), 'Explanations')}
          {chk(showCorrect, () => setShowCorrect((v) => !v), 'Correct')}
          {chk(showIncorrect, () => setShowIncorrect((v) => !v), 'Incorrect')}
        </div>
      )}
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
            {shown.length === 0 && <div className="muted" style={{ padding: '8px 2px' }}>Nothing to show — adjust the filters above.</div>}
            {shown.map((q) => {
              const n = all.indexOf(q) + 1; // stable original question number
              const expl = blocksText(q.explanation_blocks ?? []);
              return (
                <div key={q.question_version_id} className="sp-q">
                  <div className="sp-qh"><span>Question {n}</span><span className={q.correct ? 'ok' : (q.answered ? 'bad' : 'muted')}>{q.correct ? '✓ Correct' : (q.answered ? '✗ Incorrect' : 'Not answered')}</span></div>
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
                  {showExpl && expl && (
                    <div style={{ marginTop: 10, background: '#eef3fc', border: '1px solid #d9e4f7', borderRadius: 10, padding: '10px 12px' }}>
                      <div style={{ fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 12, color: '#2f62c8', marginBottom: 3 }}>💡 Why</div>
                      <div style={{ fontSize: 13.5, color: '#2a3450', lineHeight: 1.5 }}>{expl}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MON[d.getMonth()]} ${d.getDate()}`;
}

// EXAM PROGRESS — the student's finished exam papers (range-filtered), grouped by BATTERY. Pick a battery
// pill to filter; each paper is single-battery. Clicking a paper opens the SAME slide-in review drawer as a
// Battery Practice set (per-question review). Values come straight from GET /v1/exams/history.
const EXAM_BATTERIES = ['verbal', 'quantitative', 'non_verbal'];
function ExamProgress({ query, locked, onUpgrade, onOpenReview }: { query: ProgressQuery; locked: boolean; onUpgrade: () => void; onOpenReview: (setId: string, label: string) => void }) {
  const { loading, error, data, reload } = useAsync(
    async () => (locked ? ([] as ExamHistoryItem[]) : (client.examHistory({ from: query.from, to: query.to }) as Promise<ExamHistoryItem[]>)),
    [query, locked],
  );
  const [battery, setBattery] = useState('verbal');
  const papers = (data ?? []).filter((p) => (p.battery_key ?? 'verbal') === battery);

  if (locked) {
    return (
      <div className="rail-card p1-exam" style={{ marginTop: 16, borderColor: '#f0dcb0', boxShadow: 'inset 0 0 0 2px #fdf6e8' }}>
        <div className="eyebrow" style={{ color: '#a5731a' }}>📝 Exam Progress</div>
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 8, padding: '16px 0' }}>
          <div style={{ fontSize: 34 }}>🔒</div>
          <strong>Exam progress is a Plus feature</strong>
          <div className="muted" style={{ maxWidth: 440 }}>Upgrade to Plus to unlock timed exams and track your exam results and per-battery breakdown here.</div>
          <button className="btn small" onClick={onUpgrade}>See plans</button>
        </div>
      </div>
    );
  }

  const hcell = { color: 'var(--muted)', fontWeight: 800, fontSize: 11.5, textTransform: 'uppercase' as const, letterSpacing: '.04em' };
  const cols = '1.6fr .7fr .8fr .7fr .9fr';

  return (
    <div className="rail-card p1-exam" style={{ marginTop: 16, borderColor: '#f0dcb0', boxShadow: 'inset 0 0 0 2px #fdf6e8' }}>
      <div className="eyebrow" style={{ color: '#a5731a' }}>📝 Exam Progress</div>

      {/* battery selector */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '12px 0' }}>
        {EXAM_BATTERIES.map((k) => {
          const cv = catVis(k); const on = battery === k;
          return (
            <button key={k} onClick={() => setBattery(k)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 999,
                border: `2px solid ${on ? cv.color : 'transparent'}`, background: on ? '#fff' : '#f2f4f9',
                color: on ? cv.color : '#2a3450', fontWeight: 700, cursor: 'pointer', font: 'inherit' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: cv.color }} />{cv.name}
            </button>
          );
        })}
      </div>

      {loading && <Loader />}
      {error && <ErrorNote error={error} onRetry={reload} />}
      {data && papers.length === 0 && (
        <div className="muted" style={{ marginTop: 10 }}>No {catVis(battery).name} exam papers yet — finish a {catVis(battery).name} exam to see it here.</div>
      )}

      {data && papers.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 10, padding: '0 12px 8px' }}>
            <span style={hcell}>Paper</span><span style={hcell}>Score</span><span style={hcell}>Accuracy</span><span style={hcell}>Time</span><span style={hcell}>Status</span>
          </div>

          {papers.map((p) => {
            // Status: never-engaged auto-finalize → "Not attempted"; auto-finalize WITH engagement → "Timed
            // out"; manual submit → "Completed".
            const noEngagement = (p.attempted_count ?? 0) === 0 && !p.time_spent_seconds;
            const status = noEngagement
              ? { label: 'Not attempted', bg: '#eef1f6', fg: '#6b7186' }
              : p.end_reason === 'AUTO_SUBMITTED'
                ? { label: 'Timed out', bg: '#fdefe0', fg: '#a15c00' }
                : { label: 'Completed', bg: '#e9f7ef', fg: '#1e7a46' };
            const clickable = !noEngagement && !!p.set_id; // an attempted paper opens the review drawer
            return (
              <div key={p.session_id} style={{ border: '1px solid var(--line)', borderRadius: 14, marginBottom: 10, overflow: 'hidden', background: '#fff' }}>
                <button
                  onClick={() => { if (clickable) onOpenReview(p.set_id, p.set_name || 'Exam paper'); }}
                  disabled={!clickable}
                  style={{ display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'center', width: '100%',
                    padding: 14, cursor: clickable ? 'pointer' : 'default', background: 'transparent', border: 0, textAlign: 'left', font: 'inherit' }}
                >
                  <span><span className={clickable ? 'set-link' : ''} style={{ fontWeight: 800 }}>{p.set_name || 'Exam paper'}</span><br /><span className="muted" style={{ fontSize: 12 }}>{fmtWhen(p.when)}</span></span>
                  <span style={{ fontWeight: 800 }}>{p.score_total > 0 ? `${p.score_correct}/${p.score_total}` : '—'}</span>
                  <span>{p.score_total > 0 ? `${p.accuracy_pct}%` : '—'}</span>
                  <span>{fmtSeconds(p.time_spent_seconds)}</span>
                  <span>
                    <span style={{ display: 'inline-flex', borderRadius: 999, padding: '4px 10px', fontWeight: 800, fontSize: 12,
                      background: status.bg, color: status.fg }}>
                      {status.label}
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
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

  // Plan gating (cosmetic; progress data isn't sensitive). Free → whole page locked. Standard (no exam
  // capability) → practice progress visible, exam box + Exam Progress locked. Plus/Premium → everything.
  const nav = useNavigate();
  const { entitlements, entitlementsLoaded, refreshEntitlements } = useApp();
  useEffect(() => { if (PAYMENTS_ENABLED && !entitlements) refreshEntitlements(); /* eslint-disable-next-line */ }, []);
  const caps = capsOf(entitlements, entitlementsLoaded);
  const entReady = !PAYMENTS_ENABLED || entitlementsLoaded;
  const freeLocked = entReady && caps.practice !== 'all';   // only the free tier has demo-level practice
  const examLocked = entReady && !caps.exam;                // free + Standard lack the exam capability

  return (
    <div className={`prog-shell ${preview ? 'paneled' : ''}`}>
      <div className="prog-col">
        <AppBar title="Progress" sub="Your real practice data" back wide />
        <div className="content content-wide">
          {!entReady ? <Loader /> : freeLocked ? (
            <div className="rail-card" style={{ textAlign: 'center', padding: '40px 20px' }}>
              <div style={{ fontSize: 44 }}>🔒</div>
              <h2 style={{ marginTop: 8 }}>Progress tracking is a membership feature</h2>
              <div className="muted" style={{ maxWidth: 520, margin: '8px auto 16px' }}>
                Upgrade to see your practice analytics, battery breakdowns and exam results. Standard unlocks full practice tracking; Plus adds exam progress.
              </div>
              <button className="btn" onClick={() => nav('/plan')}>See plans</button>
            </div>
          ) : (
          <>
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
              <>
              <div className="p1-grid">
                <div className="rail-card p1-chart">
                  <div className="eyebrow">⏱️ Overall practice time</div>
                  <div className="pt-head">{fmtMinutes(s.practiceTimeMinutes)}</div>
                  {series.length >= 2 ? <TimeChart points={series} /> : <div className="muted pt-empty">Not enough data yet — practise on more days to see your trend.</div>}
                </div>

                {/* per-battery done/total (combine excluded) + an Exam papers box (amber) */}
                <div className="p1-setsdone">
                  {batteries.map((b) => (
                    <div key={b.key} className={`sd-box sd-${b.key}`}>
                      <span className="sd-n">{b.setsDone}/{b.setsTotal}</span>
                      <span className="sd-l">{catVis(b.key).name}</span>
                      <span className="sd-sub">sets done</span>
                    </div>
                  ))}
                  <div className="sd-box sd-exam" style={{ background: '#fdf3e0', borderTop: '3px solid #E8A020' }}>
                    {examLocked ? (
                      <>
                        <span className="sd-n" style={{ color: '#a5731a' }}>🔒</span>
                        <span className="sd-l">📝 Exam papers</span>
                        <span className="sd-sub">Plus unlocks</span>
                      </>
                    ) : (
                      <>
                        <span className="sd-n" style={{ color: '#a5731a' }}>{s.exam?.papersDone ?? 0}/{s.exam?.papersTotal ?? 0}</span>
                        <span className="sd-l">📝 Exam papers</span>
                        <span className="sd-sub">papers done</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="rail-card p1-battery">
                  <div className="eyebrow">🧠 Battery Practice</div>
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
              <ExamProgress query={query} locked={examLocked} onUpgrade={() => nav('/plan')} onOpenReview={(id, label) => setPreview({ id, label })} />
              </>
            );
          })()}
          </>
          )}
        </div>
      </div>

      <aside className={`set-panel ${preview ? 'open' : ''}`} aria-hidden={!preview}>
        {preview && <SetReviewPanel setId={preview.id} setLabel={preview.label} onClose={() => setPreview(null)} />}
      </aside>
    </div>
  );
}
