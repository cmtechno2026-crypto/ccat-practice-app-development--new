import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';

// Progress & analytics reads for the student dashboard (Home "Progress & Analytics" card + Progress page).
// Read-only aggregates over the AUTHENTICATED student's own data — the student id always comes from the
// session (req.student), never from the client. Straightforward set-based aggregate SQL (no N+1).
//
// Data sources (see PROGRESS_ANALYTICS report):
//   questionsAnswered / avgAccuracy / readiness[]  ← ccat.session_answers (is_locked) vs
//        ccat.question_versions.correct_option_ids, category via
//        sessions → question_set_versions → question_sets.category_id → categories.key
//   setsCompleted / mockExamsTaken                 ← ccat.set_completions.mode
//   practiceTimeMinutes / practiceTimeSeries       ← Σ(sessions.terminal_at − started_at) over terminal
//        sessions (session/set wall-clock — LIVE; per-QUESTION duration is NOT tracked)
//   exams{}                                        ← exam sessions + ccat.session_results
//   streakDays                                     ← ccat.student_streaks (effective current, tz-aware)
//   breakdown topics                               ← session_answers grouped by subcategory, with
//        completion from question_sets vs set_completions
//
// TIME TRACKING: only SESSION wall-clock exists (started_at → terminal_at). That powers practiceTimeMinutes
// and practiceTimeSeries (LIVE). There is NO per-answer/per-question duration column, so
// avgSecondsPerQuestion is returned null everywhere (never estimated).

const CAT_ORDER = ['verbal', 'quantitative', 'non_verbal'] as const;

interface Range { from?: string; to?: string }
function pickRange(q: any): Range {
  const r: Range = {};
  if (typeof q?.from === 'string' && q.from.trim()) r.from = q.from.trim();
  if (typeof q?.to === 'string' && q.to.trim()) r.to = q.to.trim();
  return r;
}

// Date-only relative label in the student's timezone. NEVER a time-of-day.
function daysAgoLabel(isoDay: string | null, todayIso: string): string {
  if (!isoDay) return 'Not practised yet';
  const p = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y!, m! - 1, d!); };
  const diff = Math.round((p(todayIso) - p(isoDay)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return `${diff} days ago`;
  const [ , m, d] = isoDay.split('-').map(Number);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MON[(m ?? 1) - 1]} ${d}`;
}

export function registerProgressRoutes(app: FastifyInstance, db: DB) {
  // GET /v1/progress/summary?from=&to=
  app.get('/v1/progress/summary', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const r = pickRange(req.query);

    const tzRow = await db.query('select timezone from ccat.students where id=$1', [sid]);
    const tz = (tzRow.rows[0]?.timezone as string) || 'UTC';

    // --- answered + per-answer accuracy, grouped by category (locked answers only) ---
    const ap: any[] = [sid]; const ac: string[] = ['sa.is_locked'];
    if (r.from) { ap.push(r.from); ac.push(`sa.updated_at >= $${ap.length}`); }
    if (r.to) { ap.push(r.to); ac.push(`sa.updated_at < $${ap.length}`); }
    const answers = await db.query(
      `select cat.key as category, count(*)::int as answered,
              sum(case when (array(select unnest(sa.selected_option_ids) order by 1)
                            = array(select unnest(qv.correct_option_ids) order by 1)) then 1 else 0 end)::int as correct
         from ccat.session_answers sa
         join ccat.sessions s on s.id = sa.session_id and s.student_id = $1
         join ccat.question_set_versions qsv on qsv.id = s.set_version_id
         join ccat.question_sets qs on qs.id = qsv.question_set_id
         join ccat.categories cat on cat.id = qs.category_id
         join ccat.question_versions qv on qv.id = sa.question_version_id
        where ${ac.join(' and ')}
        group by cat.key`, ap);
    const catMap = new Map<string, { answered: number; correct: number }>();
    let questionsAnswered = 0, correctTotal = 0;
    for (const row of answers.rows as any[]) {
      catMap.set(row.category, { answered: row.answered, correct: row.correct });
      questionsAnswered += row.answered; correctTotal += row.correct;
    }
    const avgAccuracy = questionsAnswered > 0 ? Math.round((100 * correctTotal) / questionsAnswered) : null;
    // Per-category "readiness" bars. No separate per-category readiness model exists, so this is the
    // student's per-answer ACCURACY in that category (null when nothing answered) — documented as such.
    const readiness = CAT_ORDER.map((category) => {
      const c = catMap.get(category);
      return { category, pct: c && c.answered > 0 ? Math.round((100 * c.correct) / c.answered) : null };
    });

    // --- completions by mode (setsCompleted = practice, mockExamsTaken = exam) ---
    const cp: any[] = [sid]; const cc: string[] = ['sc.student_id = $1'];
    if (r.from) { cp.push(r.from); cc.push(`sc.created_at >= $${cp.length}`); }
    if (r.to) { cp.push(r.to); cc.push(`sc.created_at < $${cp.length}`); }
    const comp = await db.query(
      `select sc.mode::text as mode, count(*)::int as n from ccat.set_completions sc
        where ${cc.join(' and ')} group by sc.mode`, cp);
    let setsCompleted = 0, mockExamsTaken = 0;
    for (const row of comp.rows as any[]) { if (row.mode === 'exam') mockExamsTaken = row.n; else setsCompleted += row.n; }

    // --- practice time: real session wall-clock (started_at → terminal_at) over terminal sessions ---
    const tp: any[] = [sid]; const tc: string[] = ['s.student_id = $1', 's.terminal_at is not null'];
    if (r.from) { tp.push(r.from); tc.push(`s.terminal_at >= $${tp.length}`); }
    if (r.to) { tp.push(r.to); tc.push(`s.terminal_at < $${tp.length}`); }
    const timeRow = await db.query(
      `select round(coalesce(sum(extract(epoch from (s.terminal_at - s.started_at))), 0) / 60.0)::int as mins
         from ccat.sessions s where ${tc.join(' and ')}`, tp);
    const practiceTimeMinutes = Number(timeRow.rows[0]?.mins ?? 0);

    // --- practice time series: per-day minutes (tz-aware), chronological for the line chart ---
    // Independent param list: $1 = sid, $2 = tz, range (if any) at $3+.
    const spar: any[] = [sid, tz]; const scnd: string[] = ['s.student_id = $1', 's.terminal_at is not null'];
    if (r.from) { spar.push(r.from); scnd.push(`s.terminal_at >= $${spar.length}`); }
    if (r.to) { spar.push(r.to); scnd.push(`s.terminal_at < $${spar.length}`); }
    const seriesRow = await db.query(
      `select to_char((s.terminal_at at time zone $2)::date, 'YYYY-MM-DD') as date,
              round(sum(extract(epoch from (s.terminal_at - s.started_at))) / 60.0)::int as minutes
         from ccat.sessions s where ${scnd.join(' and ')}
        group by 1 order by 1`, spar);
    const practiceTimeSeries = (seriesRow.rows as any[]).map((x) => ({ date: x.date as string, minutes: Number(x.minutes) }));

    // --- exams: attempts / last score / best accuracy from terminal EXAM sessions + results ---
    const ep: any[] = [sid]; const ec: string[] = ["s.student_id = $1", "s.mode = 'exam'", 'sr.session_id is not null'];
    if (r.from) { ep.push(r.from); ec.push(`sr.created_at >= $${ep.length}`); }
    if (r.to) { ep.push(r.to); ec.push(`sr.created_at < $${ep.length}`); }
    const examRows = await db.query(
      `select sr.score_correct, sr.score_total, sr.created_at
         from ccat.sessions s join ccat.session_results sr on sr.session_id = s.id
        where ${ec.join(' and ')} order by sr.created_at desc`, ep);
    const exRows = examRows.rows as any[];
    const attempts = exRows.length;
    const lastScore = attempts > 0 ? { score: exRows[0].score_correct as number, total: exRows[0].score_total as number } : null;
    let bestAccuracyPct: number | null = null;
    for (const x of exRows) {
      if (x.score_total > 0) {
        const acc = Math.round((100 * x.score_correct) / x.score_total);
        if (bestAccuracyPct == null || acc > bestAccuracyPct) bestAccuracyPct = acc;
      }
    }
    const exams = { attempts, lastScore, bestAccuracyPct };

    // --- streak (effective current; tz-aware, same logic as /v1/rewards/summary) ---
    const stk = await db.query(
      `select case when ss.last_active_day >= (now() at time zone s.timezone)::date - 1 then ss.current_streak else 0 end as current
         from ccat.student_streaks ss join ccat.students s on s.id = ss.student_id where ss.student_id=$1`, [sid]);
    const streakDays = stk.rows[0] ? Number(stk.rows[0].current) : 0;

    return {
      questionsAnswered,
      setsCompleted,
      avgAccuracy,
      practiceTimeMinutes,
      mockExamsTaken,
      streakDays,
      readiness,
      exams,
      practiceTimeSeries,
    };
  });

  // GET /v1/progress/breakdown?from=&to=  → per category, with nested topics (subcategories).
  app.get('/v1/progress/breakdown', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const r = pickRange(req.query);

    const meta = await db.query('select grade_id, timezone from ccat.students where id=$1', [sid]);
    const gradeId = meta.rows[0]?.grade_id as string | undefined;
    const tz = (meta.rows[0]?.timezone as string) || 'UTC';
    const todayIso = (await db.query(`select to_char((now() at time zone $1)::date,'YYYY-MM-DD') as d`, [tz])).rows[0]!.d as string;

    // Ordered per-answer rows (locked), carrying category + subcategory + correctness + tz day.
    // Ordered by subcategory then time so bestStreak (longest consecutive-correct run) is computed in JS.
    const ap: any[] = [sid, tz]; const ac: string[] = ['sa.is_locked'];
    if (r.from) { ap.push(r.from); ac.push(`sa.updated_at >= $${ap.length}`); }
    if (r.to) { ap.push(r.to); ac.push(`sa.updated_at < $${ap.length}`); }
    const rows = await db.query(
      `select cat.key as category, cat.display_order as cat_order,
              coalesce(sub.id::text, 'none') as subid, coalesce(sub.name, 'General') as subname,
              coalesce(sub.display_order, 999) as sub_order,
              (array(select unnest(sa.selected_option_ids) order by 1)
                = array(select unnest(qv.correct_option_ids) order by 1)) as correct,
              to_char((sa.updated_at at time zone $2)::date, 'YYYY-MM-DD') as day
         from ccat.session_answers sa
         join ccat.sessions s on s.id = sa.session_id and s.student_id = $1
         join ccat.question_set_versions qsv on qsv.id = s.set_version_id
         join ccat.question_sets qs on qs.id = qsv.question_set_id
         join ccat.categories cat on cat.id = qs.category_id
         left join ccat.subcategories sub on sub.id = qs.subcategory_id
         join ccat.question_versions qv on qv.id = sa.question_version_id
        where ${ac.join(' and ')}
        order by cat.display_order, coalesce(sub.display_order, 999), sa.updated_at`, ap);

    // Completion per subcategory for the student's grade: completed sets vs total sets.
    const compRows = gradeId ? await db.query(
      `select coalesce(qs.subcategory_id::text,'none') as subid,
              count(distinct qs.id)::int as total,
              count(distinct sc.question_set_id)::int as done
         from ccat.question_sets qs
         left join ccat.set_completions sc on sc.question_set_id = qs.id and sc.student_id = $1
        where qs.grade_id = $2
        group by coalesce(qs.subcategory_id::text,'none')`, [sid, gradeId]) : { rows: [] as any[] };
    const compBySub = new Map<string, { total: number; done: number }>();
    for (const c of compRows.rows as any[]) compBySub.set(c.subid, { total: c.total, done: c.done });

    // Fold ordered answers into category → subcategory aggregates (JS; single scan).
    type Topic = { subcategory: string; accuracyPct: number | null; avgSecondsPerQuestion: null;
                   completionPct: number | null; questionsDone: number; bestStreak: number; lastPractisedLabel: string; };
    const cats = new Map<string, { key: string; order: number; answered: number; correct: number; topics: Map<string, {
      subid: string; name: string; order: number; done: number; correct: number; run: number; best: number; lastDay: string | null; }> }>();
    for (const row of rows.rows as any[]) {
      if (!cats.has(row.category)) cats.set(row.category, { key: row.category, order: row.cat_order, answered: 0, correct: 0, topics: new Map() });
      const c = cats.get(row.category)!;
      c.answered += 1; if (row.correct) c.correct += 1;
      let t = c.topics.get(row.subid);
      if (!t) { t = { subid: row.subid, name: row.subname, order: row.sub_order, done: 0, correct: 0, run: 0, best: 0, lastDay: null }; c.topics.set(row.subid, t); }
      t.done += 1;
      if (row.correct) { t.correct += 1; t.run += 1; if (t.run > t.best) t.best = t.run; } else { t.run = 0; }
      if (!t.lastDay || row.day > t.lastDay) t.lastDay = row.day;
    }

    // Emit all three categories in fixed order; topics ordered by display order. Categories with no
    // activity come back with accuracyPct null + empty topics (frontend shows an empty state).
    const result = CAT_ORDER.map((key) => {
      const c = cats.get(key);
      const topics: Topic[] = c
        ? [...c.topics.values()].sort((a, b) => a.order - b.order).map((t) => {
            const comp = compBySub.get(t.subid);
            return {
              subcategory: t.name,
              accuracyPct: t.done > 0 ? Math.round((100 * t.correct) / t.done) : null,
              avgSecondsPerQuestion: null,
              completionPct: comp && comp.total > 0 ? Math.round((100 * comp.done) / comp.total) : null,
              questionsDone: t.done,
              bestStreak: t.best,
              lastPractisedLabel: daysAgoLabel(t.lastDay, todayIso),
            };
          })
        : [];
      return {
        category: key,
        accuracyPct: c && c.answered > 0 ? Math.round((100 * c.correct) / c.answered) : null,
        topics,
      };
    });
    return result;
  });
}
