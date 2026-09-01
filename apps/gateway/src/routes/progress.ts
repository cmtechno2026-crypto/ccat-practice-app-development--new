import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';

// Progress & analytics reads for the student dashboard (Home "Progress & Analytics" card + Progress page).
// Read-only aggregates over the AUTHENTICATED student's own data — the student id always comes from the
// session (req.student), never from the client. Straightforward set-based aggregate SQL (no N+1).
//
// Data sources (see PROGRESS report):
//   questionsAnswered / avgAccuracy / byCategory  ← ccat.session_answers (is_locked) vs
//        ccat.question_versions.correct_option_ids, category via
//        sessions → question_set_versions → question_sets.category_id → categories.key
//   setsCompleted / mockExamsTaken                 ← ccat.set_completions.mode
//   timeSpentMinutes                               ← Σ(sessions.terminal_at − started_at) over terminal sessions
//   courseCompletionPct                            ← learning_plan_sets vs set_completions (same as /v1/progress)
//   examReadiness                                  ← latest ccat.readiness_snapshots (same as /v1/readiness)
//   streakDays                                     ← ccat.student_streaks (effective current, tz-aware)
//   activity                                       ← set_completions (+ session_results/sessions) and
//                                                    student_achievements (badges)

interface Filters { from?: string; to?: string; category?: string; mode?: string }
function pickFilters(q: any): Filters {
  const f: Filters = {};
  if (typeof q?.from === 'string' && q.from.trim()) f.from = q.from.trim();
  if (typeof q?.to === 'string' && q.to.trim()) f.to = q.to.trim();
  if (typeof q?.category === 'string' && q.category.trim()) f.category = q.category.trim();
  if (q?.mode === 'practice' || q?.mode === 'exam') f.mode = q.mode;
  return f;
}

// Date-only relative label in the student's timezone. NEVER includes a time-of-day (product rule).
function dayLabel(isoDay: string, todayIso: string): string {
  if (isoDay === todayIso) return 'Today';
  // yesterday = todayIso - 1 day (compute from the ISO date parts, tz already applied in SQL)
  const [ty, tm, td] = todayIso.split('-').map(Number);
  const y = new Date(Date.UTC(ty!, tm! - 1, td!)); y.setUTCDate(y.getUTCDate() - 1);
  const yIso = `${y.getUTCFullYear()}-${String(y.getUTCMonth() + 1).padStart(2, '0')}-${String(y.getUTCDate()).padStart(2, '0')}`;
  if (isoDay === yIso) return 'Yesterday';
  const [ , m, d] = isoDay.split('-').map(Number);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MON[(m ?? 1) - 1]} ${d}`;
}

export function registerProgressRoutes(app: FastifyInstance, db: DB) {
  // GET /v1/progress/summary?from=&to=&category=&mode=
  app.get('/v1/progress/summary', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const f = pickFilters(req.query);

    // --- answered + per-answer accuracy + by-category (locked answers only) ---
    const ap: any[] = [sid]; const ac: string[] = ['sa.is_locked'];
    if (f.mode) { ap.push(f.mode); ac.push(`s.mode = $${ap.length}`); }
    if (f.category) { ap.push(f.category); ac.push(`cat.key = $${ap.length}`); }
    if (f.from) { ap.push(f.from); ac.push(`sa.updated_at >= $${ap.length}`); }
    if (f.to) { ap.push(f.to); ac.push(`sa.updated_at < $${ap.length}`); }
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
    let questionsAnswered = 0, correctTotal = 0;
    const byCategory = answers.rows.map((r: any) => {
      questionsAnswered += r.answered; correctTotal += r.correct;
      return { category: r.category as string, answered: r.answered as number, accuracyPct: r.answered > 0 ? Math.round((100 * r.correct) / r.answered) : null };
    });
    const avgAccuracy = questionsAnswered > 0 ? Math.round((100 * correctTotal) / questionsAnswered) : null;

    // --- completions by mode (setsCompleted = practice, mockExamsTaken = exam) ---
    const cp: any[] = [sid]; const cc: string[] = ['sc.student_id = $1'];
    if (f.from) { cp.push(f.from); cc.push(`sc.created_at >= $${cp.length}`); }
    if (f.to) { cp.push(f.to); cc.push(`sc.created_at < $${cp.length}`); }
    if (f.category) { cp.push(f.category); cc.push(`cat.key = $${cp.length}`); }
    const comp = await db.query(
      `select sc.mode, count(*)::int as n
         from ccat.set_completions sc
         join ccat.question_sets qs on qs.id = sc.question_set_id
         left join ccat.categories cat on cat.id = qs.category_id
        where ${cc.join(' and ')}
        group by sc.mode`, cp);
    let setsCompleted = 0, mockExamsTaken = 0;
    for (const r of comp.rows) { if (r.mode === 'exam') mockExamsTaken = r.n; else setsCompleted += r.n; }

    // --- time spent: real session wall-clock (started_at → terminal_at) over terminal sessions ---
    const tp: any[] = [sid]; const tc: string[] = ['s.student_id = $1', 's.terminal_at is not null'];
    if (f.mode) { tp.push(f.mode); tc.push(`s.mode = $${tp.length}`); }
    if (f.from) { tp.push(f.from); tc.push(`s.terminal_at >= $${tp.length}`); }
    if (f.to) { tp.push(f.to); tc.push(`s.terminal_at < $${tp.length}`); }
    if (f.category) {
      tp.push(f.category);
      tc.push(`exists (select 1 from ccat.question_set_versions qsv join ccat.question_sets qs on qs.id=qsv.question_set_id join ccat.categories cat on cat.id=qs.category_id where qsv.id=s.set_version_id and cat.key=$${tp.length})`);
    }
    const timeRow = await db.query(
      `select round(coalesce(sum(extract(epoch from (s.terminal_at - s.started_at))), 0) / 60.0)::int as mins
         from ccat.sessions s where ${tc.join(' and ')}`, tp);
    const timeSpentMinutes = Number(timeRow.rows[0]?.mins ?? 0);

    // --- course completion (current snapshot; date/category/mode filters do not apply) ---
    let courseCompletionPct: number | null = null;
    const lpv = await db.query(
      `select lpv.id from ccat.students st
         join ccat.learning_plans lp on lp.grade_id = st.grade_id
         join ccat.learning_plan_versions lpv on lpv.learning_plan_id = lp.id and lpv.is_active = true
        where st.id = $1 limit 1`, [sid]);
    if (lpv.rows.length > 0) {
      const planId = lpv.rows[0]!.id;
      const elig = await db.query('select count(*)::int as n from ccat.learning_plan_sets where learning_plan_version_id=$1', [planId]);
      const done = await db.query('select count(*)::int as n from ccat.set_completions where student_id=$1 and learning_plan_version_id=$2', [sid, planId]);
      const e = elig.rows[0]!.n as number, c = done.rows[0]!.n as number;
      courseCompletionPct = e > 0 ? Math.round((100 * c) / e) : null;
    }

    // --- exam readiness (latest snapshot; same source as /v1/readiness) ---
    const rd = await db.query(
      `select readiness_pct, insufficient_data, band from ccat.readiness_snapshots
        where student_id=$1 order by computed_at desc limit 1`, [sid]);
    const examReadiness = rd.rows[0] && !rd.rows[0].insufficient_data
      ? { label: (rd.rows[0].band as string) ?? 'Ready', pct: rd.rows[0].readiness_pct === null ? null : Number(rd.rows[0].readiness_pct) }
      : { label: 'Building…', pct: null };

    // --- streak (effective current; tz-aware, same logic as /v1/rewards/summary) ---
    const stk = await db.query(
      `select case when ss.last_active_day >= (now() at time zone s.timezone)::date - 1 then ss.current_streak else 0 end as current
         from ccat.student_streaks ss join ccat.students s on s.id = ss.student_id where ss.student_id=$1`, [sid]);
    const streakDays = stk.rows[0] ? Number(stk.rows[0].current) : 0;

    return {
      questionsAnswered,
      setsCompleted,
      avgAccuracy,
      timeSpentMinutes,
      mockExamsTaken,
      courseCompletionPct,
      examReadiness,
      streakDays,
      byCategory,
    };
  });

  // GET /v1/progress/activity?limit=&from=&to=&category=&mode=
  app.get('/v1/progress/activity', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const f = pickFilters(req.query);
    const rawLimit = Number((req.query as any)?.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.trunc(rawLimit))) : 20;

    const tzRow = await db.query('select timezone from ccat.students where id=$1', [sid]);
    const tz = (tzRow.rows[0]?.timezone as string) || 'UTC';

    // Set + exam completions. Category filter narrows to that category; mode filter narrows practice/exam.
    const sp: any[] = [sid, tz]; const scnd: string[] = ['sc.student_id = $1'];
    if (f.mode) { sp.push(f.mode); scnd.push(`sc.mode = $${sp.length}`); }
    if (f.category) { sp.push(f.category); scnd.push(`cat.key = $${sp.length}`); }
    if (f.from) { sp.push(f.from); scnd.push(`sc.created_at >= $${sp.length}`); }
    if (f.to) { sp.push(f.to); scnd.push(`sc.created_at < $${sp.length}`); }
    const setEvents = await db.query(
      `select sc.id::text as id,
              case when sc.mode = 'exam' then 'exam' else 'set' end as type,
              qs.name as title,
              cat.key as category,
              r.score_correct, r.score_total,
              case when ses.terminal_at is not null and ses.started_at is not null
                   then round(extract(epoch from (ses.terminal_at - ses.started_at)) / 60.0)::int end as time_minutes,
              sc.created_at as sort_date,
              to_char((sc.created_at at time zone $2)::date, 'YYYY-MM-DD') as day
         from ccat.set_completions sc
         join ccat.question_sets qs on qs.id = sc.question_set_id
         left join ccat.categories cat on cat.id = qs.category_id
         left join ccat.session_results r on r.session_id = sc.first_session_id
         left join ccat.sessions ses on ses.id = sc.first_session_id
        where ${scnd.join(' and ')}
        order by sc.created_at desc
        limit ${limit}`, sp);

    // Badge unlocks. No category/mode → omitted when either of those filters is set. LIVE otherwise.
    let badgeRows: any[] = [];
    if (!f.category && !f.mode) {
      const bp: any[] = [sid, tz]; const bcnd: string[] = ['sa.student_id = $1'];
      if (f.from) { bp.push(f.from); bcnd.push(`sa.created_at >= $${bp.length}`); }
      if (f.to) { bp.push(f.to); bcnd.push(`sa.created_at < $${bp.length}`); }
      const badges = await db.query(
        `select sa.id::text as id, 'badge' as type, a.name as title,
                sa.created_at as sort_date,
                to_char((sa.created_at at time zone $2)::date, 'YYYY-MM-DD') as day
           from ccat.student_achievements sa
           join ccat.achievement_versions av on av.id = sa.achievement_version_id
           join ccat.achievements a on a.id = av.achievement_id
          where ${bcnd.join(' and ')}
          order by sa.created_at desc
          limit ${limit}`, bp);
      badgeRows = badges.rows;
    }

    const todayIso = (await db.query(`select to_char((now() at time zone $1)::date,'YYYY-MM-DD') as d`, [tz])).rows[0]!.d as string;

    const events = [
      ...setEvents.rows.map((r: any) => ({
        id: r.id, type: r.type as 'set' | 'exam', title: r.title as string,
        category: (r.category as string) ?? null,
        accuracyPct: r.score_total > 0 ? Math.round((100 * r.score_correct) / r.score_total) : null,
        questions: r.score_total ?? null,
        timeMinutes: r.time_minutes ?? null,
        dayLabel: dayLabel(r.day, todayIso),
        sortDate: r.sort_date,
      })),
      ...badgeRows.map((r: any) => ({
        id: r.id, type: 'badge' as const, title: r.title as string,
        category: null, accuracyPct: null, questions: null, timeMinutes: null,
        dayLabel: dayLabel(r.day, todayIso), sortDate: r.sort_date,
      })),
    ].sort((a, b) => new Date(b.sortDate).getTime() - new Date(a.sortDate).getTime()).slice(0, limit);

    return events;
  });
}
