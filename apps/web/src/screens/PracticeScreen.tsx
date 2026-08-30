import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { CatalogItem, Mode } from '@ccat/api-client';
import { ApiError } from '@ccat/api-client';
import { client } from '../lib/api';
import { useApp } from '../lib/store';
import { AppBar, Card, Loader, ErrorNote, useAsync } from '../components/ui';

// PRACTICE — 3-level browse that ends in a quiz (mockup: CCAT Practice.dc.html), desktop layout,
// mockup tokens:  BATTERY (3) → CATEGORY (subcategories) → SET → start screen → practice quiz.
// Everything comes from GET /v1/catalog (published-only, student's grade, sets with active
// questions), grouped client-side. Difficulty is a per-set attribute → a filter on the sets view;
// the timer is a per-session choice on the start screen. Exam keeps its existing flat paper list.

// Battery VISUALS (icon/colour = mockup tokens). The display NAME comes from the gateway catalog
// (category_name); the fallback name here is only used before the catalog loads.
const BATTERY_ORDER = ['verbal', 'quantitative', 'non_verbal'];
const BATTERY_VIS: Record<string, { fallbackName: string; icon: string; color: string; tint: string }> = {
  verbal: { fallbackName: 'Verbal reasoning', icon: '🔤', color: '#3e7bee', tint: '#eaf0ff' },
  quantitative: { fallbackName: 'Quantitative reasoning', icon: '🔢', color: '#22c3a6', tint: '#e8f7f1' },
  non_verbal: { fallbackName: 'Non-verbal reasoning', icon: '🧩', color: '#8b5cf6', tint: '#f3ecfb' },
};

// Option A difficulty palette — Easy green 🌱 · Medium amber 🌳 · Hard coral 🌲.
const DIFF_META: Record<string, { icon: string; color: string; tint: string }> = {
  easy: { icon: '🌱', color: '#22a06b', tint: '#e8f7f1' },
  medium: { icon: '🌳', color: '#d9902a', tint: '#fff3db' },
  hard: { icon: '🌲', color: '#e4574f', tint: '#fde9ef' },
};

type Prefs = { difficulty: string; timerMin: number | null; customMins: number | null };
function loadPrefs(): Prefs {
  try { const p = JSON.parse(localStorage.getItem('cmPracticePrefs') || '{}'); return { difficulty: p.difficulty ?? 'all', timerMin: p.timerMin ?? null, customMins: p.customMins ?? null }; }
  catch { return { difficulty: 'all', timerMin: null, customMins: null }; }
}

export function PracticeScreen() {
  const nav = useNavigate();
  const { flash } = useApp();
  const [sp, setSp] = useSearchParams();
  const mode: Mode = sp.get('mode') === 'exam' ? 'exam' : 'practice';
  const battery = sp.get('battery');            // level 2 when set
  const category = sp.get('category');          // level 3 when set
  const setId = sp.get('set');                  // start screen when set
  const { loading, error, data, reload } = useAsync(() => client.catalog(), []);
  const [starting, setStarting] = useState(false);

  const initial = loadPrefs();
  const [timerMin, setTimerMin] = useState<number | null>(initial.timerMin);
  const [customOpen, setCustomOpen] = useState(false);
  const [customMins, setCustomMins] = useState<number>(initial.customMins ?? 20);

  useEffect(() => {
    try { localStorage.setItem('cmPracticePrefs', JSON.stringify({ timerMin, customMins })); } catch { /* */ }
  }, [timerMin, customMins]);

  const practice = useMemo(() => (data ?? []).filter((c) => c.allowed_modes.includes('practice')), [data]);

  // Battery meta: NAME from the catalog's category_name (DB), visuals from the token map.
  const batteryMeta = (key: string) => {
    const vis = BATTERY_VIS[key];
    const name = practice.find((c) => c.category_key === key)?.category_name ?? vis?.fallbackName ?? key.replace('_', '-');
    return { name, icon: vis?.icon ?? '📘', color: vis?.color ?? 'var(--primary)', tint: vis?.tint ?? 'var(--tint-blue)' };
  };

  // battery_key -> subcategory -> sets  (only batteries/categories with real sets appear beneath the 3)
  const grouped = useMemo(() => {
    const g: Record<string, Record<string, CatalogItem[]>> = {};
    for (const c of practice) { (g[c.category_key] ??= {}); (g[c.category_key]![c.subcategory] ??= []).push(c); }
    return g;
  }, [practice]);

  // ---- navigation helpers (URL-driven so browser back/forward + deep-links work) ----
  const go = (params: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(params)) { if (v == null) next.delete(k); else next.set(k, v); }
    setSp(next);
  };

  async function startSet(item: CatalogItem, resumeId?: string | null) {
    if (resumeId) { nav(`/session/${resumeId}`); return; }
    setStarting(true);
    try {
      const min = timerMin;
      const timerType = min == null ? 'untimed' : 'timed';
      const durationSeconds = min == null ? undefined : Math.max(60, min * 60);
      const session = await client.sessionStart(item.set_version_id, 'practice', timerType, durationSeconds);
      nav(`/session/${session.id}`);
    } catch (e) {
      flash(e instanceof ApiError
        ? (e.code === 'ACTIVE_SESSION_EXISTS' ? 'You already have a session in progress — resume it from Home.' : e.message)
        : (e as Error).message);
    } finally { setStarting(false); }
  }

  // ============================ EXAM (unchanged flat paper list) ============================
  if (mode === 'exam') {
    const papers = (data ?? []).filter((c) => c.allowed_modes.includes('exam'));
    return (
      <>
        <AppBar title="CCAT Exam" sub="Timed mock exams" back />
        <div className="content stack">
          <div className="card" style={{ background: 'var(--tint-blue)' }}>
            <div className="muted">⏱ The timer starts the moment you open a set. Work through the three batteries (Verbal · Non-verbal · Quantitative) before time runs out.</div>
          </div>
          {loading && <Loader />}
          {error && <ErrorNote error={error} onRetry={reload} />}
          {data && papers.length === 0 && <div className="empty">No exam sets for your grade yet.<br />Check back after your teacher publishes an exam.</div>}
          {papers.map((s) => {
            const st = s.progress?.status ?? 'not_started';
            const cta = st === 'completed' ? 'Retake' : st === 'in_progress' ? 'Resume' : 'Start';
            return (
              <Card key={s.set_version_id}>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <div className="ic" style={{ background: 'var(--tint-lilac)' }}>📝</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3>{s.name}</h3>
                    <div className="muted">3 batteries · {s.question_count} questions{s.duration_minutes ? ` · ⏱ ${s.duration_minutes} min` : ''}
                      {st === 'completed' && s.progress?.score_total != null && <> · ✅ {s.progress.score_correct}/{s.progress.score_total}</>}</div>
                  </div>
                  <button className={`btn small ${st === 'completed' ? 'secondary' : ''}`} disabled={starting}
                    onClick={() => startSet(s, st === 'in_progress' ? s.progress?.session_id : null)}>{cta}</button>
                </div>
              </Card>
            );
          })}
        </div>
      </>
    );
  }

  // ============================ PRACTICE 3-level drill-down ============================
  const crumb = (
    <div className="crumbs">
      <button className="crumb" onClick={() => go({ battery: null, category: null, set: null })}>Practice</button>
      {battery && <><span className="crumb-sep">›</span><button className="crumb" onClick={() => go({ category: null, set: null })}>{batteryMeta(battery).name}</button></>}
      {battery && category && <><span className="crumb-sep">›</span><button className="crumb" onClick={() => go({ set: null })}>{category}</button></>}
    </div>
  );

  // ---- START SCREEN (a set is selected) ----
  const selectedSet = setId ? practice.find((c) => c.set_version_id === setId) : null;
  if (setId && selectedSet) {
    const dm = DIFF_META[(selectedSet.difficulty ?? '').toLowerCase()];
    const bm = batteryMeta(selectedSet.category_key);
    const st = selectedSet.progress?.status ?? 'not_started';
    const timerLabel = timerMin == null ? 'Untimed' : `${timerMin} min`;
    return (
      <>
        <AppBar title="Ready to start?" sub={selectedSet.name} back />
        <div className="content stack">
          {crumb}
          <Card className="start-hero" >
            <div className="start-hero-top" style={{ background: bm.tint }}>
              <div className="ic" style={{ background: '#fff', fontSize: 30 }}>{bm.icon}</div>
              <div>
                <div className="eyebrow" style={{ color: bm.color }}>{bm.name} · {selectedSet.subcategory}</div>
                <h2 style={{ marginTop: 2 }}>{selectedSet.name}</h2>
              </div>
            </div>
            <div className="start-facts">
              <div className="fact"><div className="n">{selectedSet.question_count}</div><div className="l">Questions</div></div>
              <div className="fact"><div className="n">{dm ? dm.icon : ''} {selectedSet.difficulty ?? '—'}</div><div className="l">Difficulty</div></div>
              <div className="fact"><div className="n">✏️ Practice</div><div className="l">Mode</div></div>
            </div>
            <div className="muted" style={{ marginTop: 4 }}>Practice mode gives instant feedback: a hint after a wrong first try, two attempts, then the answer and why. Bookmark any question to revisit it later.</div>

            {/* Timer choice for THIS session */}
            <div style={{ marginTop: 12 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>Timer · {timerLabel}</div>
              <div className="row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Timer">
                <button className={`btn small ${timerMin == null ? '' : 'secondary'}`} aria-pressed={timerMin == null} onClick={() => { setTimerMin(null); setCustomOpen(false); }}>∞ Untimed</button>
                {[5, 10, 15].map((m) => (
                  <button key={m} className={`btn small ${timerMin === m ? '' : 'secondary'}`} aria-pressed={timerMin === m} onClick={() => { setTimerMin(m); setCustomOpen(false); }}>{m} min</button>
                ))}
                <button className={`btn small ${customOpen || (timerMin != null && ![5, 10, 15].includes(timerMin)) ? '' : 'secondary'}`}
                  onClick={() => { setCustomOpen((o) => !o); setTimerMin(customMins); }}>
                  Custom{timerMin != null && ![5, 10, 15].includes(timerMin) ? ` · ${timerMin}m` : ''}
                </button>
              </div>
              {customOpen && (
                <div className="row" style={{ marginTop: 8, gap: 10 }}>
                  <input className="input" type="range" min={20} max={120} step={5} value={customMins}
                    onChange={(e) => { const v = Number(e.target.value); setCustomMins(v); setTimerMin(v); }} style={{ flex: 1 }} />
                  <span className="pill">{customMins} min</span>
                </div>
              )}
            </div>

            <button className="btn" style={{ marginTop: 14 }} disabled={starting}
              onClick={() => startSet(selectedSet, st === 'in_progress' ? selectedSet.progress?.session_id : null)}>
              {starting ? 'Starting…' : st === 'in_progress' ? 'Resume practice ▶' : st === 'completed' ? 'Practise again ▶' : 'Start practice ▶'}
            </button>
          </Card>
        </div>
      </>
    );
  }

  // ---- SETS view (battery + category selected) ----
  if (battery && category) {
    // Difficulty filter removed for now — all published sets in the category are shown (each set still
    // displays its admin-assigned difficulty badge). The filter will be reintroduced later.
    const sets = grouped[battery]?.[category] ?? [];
    return (
      <>
        <AppBar title={category} sub={`${batteryMeta(battery).name} · pick a set`} back />
        <div className="content stack">
          {crumb}
          {loading && <Loader />}
          {error && <ErrorNote error={error} onRetry={reload} />}
          {sets.length === 0 && <div className="empty">No sets in {category} yet.<br />Check back after your teacher publishes more.</div>}
          {sets.map((s) => {
            const st = s.progress?.status ?? 'not_started';
            const dm = DIFF_META[(s.difficulty ?? '').toLowerCase()];
            const pct = st === 'in_progress' && s.question_count ? Math.round((100 * (s.progress!.answered_count)) / s.question_count) : 0;
            const cta = st === 'completed' ? 'Redo' : st === 'in_progress' ? 'Resume' : 'Start';
            return (
              <div key={s.set_version_id} className="practice-set tap" role="button" tabIndex={0}
                onClick={() => go({ set: s.set_version_id })}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go({ set: s.set_version_id }); } }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{s.name}</strong>
                  <div className="muted">
                    {dm ? `${dm.icon} ` : ''}{s.difficulty ?? '—'} · {s.question_count} questions
                    {st === 'completed' && s.progress?.score_total != null && <> · ✅ {s.progress.score_correct}/{s.progress.score_total}</>}
                    {st === 'in_progress' && <> · ⏳ {s.progress!.answered_count}/{s.question_count}</>}
                  </div>
                  {st === 'in_progress' && <div className="progress-track" style={{ marginTop: 6 }}><div className="progress-fill" style={{ width: `${pct}%`, background: 'var(--amber)' }} /></div>}
                </div>
                <span className="pill" style={{ background: st === 'in_progress' ? 'var(--amber-tint)' : 'var(--tint-blue)', color: st === 'in_progress' ? 'var(--amber)' : 'var(--primary)' }}>{cta} ›</span>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  // ---- CATEGORIES view (battery selected) ----
  if (battery) {
    const cats = grouped[battery] ?? {};
    const bm = batteryMeta(battery);
    const entries = Object.entries(cats);
    return (
      <>
        <AppBar title={bm.name} sub="Pick a category" back />
        <div className="content stack">
          {crumb}
          {loading && <Loader />}
          {error && <ErrorNote error={error} onRetry={reload} />}
          {data && entries.length === 0 && <div className="empty">No published sets in {bm.name} for your grade yet.<br />Check back after your teacher publishes content.</div>}
          {entries.map(([sub, sets]) => (
            <Card key={sub} onClick={() => go({ category: sub })}>
              <div className="row">
                <div className="ic" style={{ background: bm.tint }}>{bm.icon}</div>
                <div style={{ flex: 1 }}><h3>{sub}</h3><div className="muted">{sets.length} set{sets.length === 1 ? '' : 's'}</div></div>
                <span className="pill">›</span>
              </div>
            </Card>
          ))}
        </div>
      </>
    );
  }

  // ---- BATTERIES landing (always the 3) ----
  return (
    <>
      <AppBar title="Practice" sub="Pick a battery to begin" back />
      <div className="content stack">
        {loading && <Loader />}
        {error && <ErrorNote error={error} onRetry={reload} />}
        {data && BATTERY_ORDER.map((key) => {
          const bm = batteryMeta(key);
          const cats = grouped[key] ?? {};
          const catCount = Object.keys(cats).length;
          const setCount = Object.values(cats).reduce((n, arr) => n + arr.length, 0);
          const empty = setCount === 0;
          return (
            <button key={key} className="battery-card" style={{ ['--bat' as any]: bm.color, ['--bat-tint' as any]: bm.tint }}
              disabled={empty} onClick={() => go({ battery: key })} aria-disabled={empty}>
              <span className="bat-ic" style={{ background: bm.tint }}>{bm.icon}</span>
              <span className="bat-body">
                <span className="bat-name">{bm.name}</span>
                <span className="bat-sub">{empty ? 'No sets published yet' : `${setCount} set${setCount === 1 ? '' : 's'} · ${catCount} categor${catCount === 1 ? 'y' : 'ies'}`}</span>
              </span>
              <span className="bat-go">{empty ? '' : '›'}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
