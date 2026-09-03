import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { seededShuffle } from '../lib/shuffle.js';

// Combine subcategories (…_battery_combine) are the 45-question mixed sets; excluded from per-battery
// sets-done / totals (Home + Progress boxes), but INCLUDED in per-subcategory accuracy boxes.
const isCombine = (k: unknown): boolean => typeof k === 'string' && k.endsWith('_battery_combine');
// Ready-to-use image URL from a prompt/option block array (mirrors sessions.ts).
function imageUrlOfBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const img = blocks.find((b: any) => b && b.type === 'image');
  return img && typeof img.url === 'string' ? img.url : null;
}
const eqSet = (a: string[], b: string[]): boolean => {
  const x = [...a].sort(), y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

// Progress & analytics reads for the student dashboard (Home "Progress & Analytics" card + Progress page).
// Read-only aggregates over the AUTHENTICATED student's own data — the student id always comes from the
// session (req.student), never from the client. Set-based aggregate SQL (GROUP BY / window; no N+1).
//
// CONTRACT (H4 / P1):
//   GET /v1/progress/summary?from=&to=   → { score{correct,total}, setsDone, practiceTimeMinutes,
//        practiceTimeSeries[], batteries[{ key, name, accuracyPct, score{correct,total},
//        totalQuestions, avgSecondsPerQuestion, setsDone, subcategories[{key,name}] }] }
//   GET /v1/progress/sets?battery=&subcategory=  → [{ setId, name, accuracyPct, score{correct,total},
//        totalQuestions, avgSecondsPerQuestion }]
//   GET /v1/progress/breakdown?from=&to=  → per-category → topics (kept for compatibility; unchanged).
//
// FINISHED-SET MODEL (score / setsDone / batteries / sets):
//   The unit is a FINISHED practice set. "Finished" = a practice session (mode<>'exam') with a terminal
//   session_results row (SUBMITTED / AUTO_SUBMITTED). For each set we take the MOST RECENT finished
//   attempt (row_number over terminal_at desc) and read its authoritative score_correct / score_total
//   from ccat.session_results. Save & Leave / abandon leave no session_results row, so paused sets are
//   excluded (matches the sets-done bug fix). Because every level is derived from the SAME per-set
//   (rn=1) rows, the numbers reconcile exactly: Σ per-set = per-battery; Σ per-battery = summary.
//   Date range applies on the finished session's terminal_at.
//
// TIME / DURATION — the one honest limitation (verified against the live schema 2026-09-02):
//   ccat.session_answers has NO per-attempt duration column (only attempts / updated_at / created_at),
//   and sessions.duration_seconds is the TIMER CONFIG, not elapsed. So:
//     • avgSecondsPerQuestion — DERIVED, not a raw column: finished-attempt session wall-clock
//       (terminal_at − started_at) ÷ questions answered (see avgPerQ). It is REAL timestamp data, but it
//       is per-SET/session time spread over its questions — it includes reading and pauses and is not
//       true per-question timing. null when there is no time or no answered questions. To get true
//       per-question timing later, the practice client would send elapsed time per answer and the gateway
//       would store it on session_answers; then avg = Σ per-answer time ÷ answers.
//     • practiceTimeMinutes / practiceTimeSeries — LIVE from SESSION wall-clock (started_at → terminal_at)
//       over terminal practice sessions, tz-aware. Real timestamp math, not a fabricated trend.

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

// Per-set row from the "most recent finished attempt per set" window. Shared by /summary and /sets.
// Returns raw rows (rn=1), ordered category → subcategory → set creation → set id.
async function finishedSetRows(db: DB, sid: string, r: Range) {
  const p: any[] = [sid];
  const extra: string[] = [];
  if (r.from) { p.push(r.from); extra.push(`s.terminal_at >= $${p.length}`); }
  if (r.to) { p.push(r.to); extra.push(`s.terminal_at < $${p.length}`); }
  const where = ["s.student_id = $1", "s.mode <> 'exam'", "sr.terminal_state in ('SUBMITTED','AUTO_SUBMITTED')", ...extra].join(' and ');
  const res = await db.query(
    `with fin as (
       select qs.id as set_id, qs.name as set_name, qs.created_at as set_created,
              cat.key as cat_key, cat.name as cat_name, cat.display_order as cat_order,
              coalesce(sub.key, 'none') as sub_key, coalesce(sub.name, 'General') as sub_name,
              coalesce(sub.display_order, 999) as sub_order,
              qsv.question_count as total_questions,
              sr.score_correct::int as score_correct, sr.score_total::int as score_total,
              extract(epoch from (s.terminal_at - s.started_at))::float8 as attempt_seconds,
              row_number() over (partition by qs.id
                                 order by s.terminal_at desc nulls last, sr.created_at desc) as rn
         from ccat.sessions s
         join ccat.session_results sr on sr.session_id = s.id
         join ccat.question_set_versions qsv on qsv.id = s.set_version_id
         join ccat.question_sets qs on qs.id = qsv.question_set_id
         join ccat.categories cat on cat.id = qs.category_id
         left join ccat.subcategories sub on sub.id = qs.subcategory_id
        where ${where}
     )
     select set_id, set_name, cat_key, cat_name, cat_order, sub_key, sub_name, sub_order,
            total_questions, score_correct, score_total, attempt_seconds
       from fin where rn = 1
      order by cat_order, sub_order, set_created asc, set_id asc`, p);
  return res.rows as Array<{
    set_id: string; set_name: string; cat_key: string; cat_name: string; cat_order: number;
    sub_key: string; sub_name: string; sub_order: number;
    total_questions: number | null; score_correct: number; score_total: number;
    attempt_seconds: number | null;
  }>;
}
// Derived "avg time per question" = finished-attempt session wall-clock ÷ questions answered. This is
// NOT true per-question timing (no such column exists) — it includes reading / pauses — but it is real
// timestamp data, not an estimate. null when there is no time or no answered questions.
function avgPerQ(seconds: number | null, answered: number): number | null {
  if (seconds == null || seconds <= 0 || answered <= 0) return null;
  return Math.round(seconds / answered);
}
const pct = (correct: number, total: number): number | null => (total > 0 ? Math.round((100 * correct) / total) : null);

export function registerProgressRoutes(app: FastifyInstance, db: DB) {
  // GET /v1/progress/summary?from=&to=
  app.get('/v1/progress/summary', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const r = pickRange(req.query);

    const tzRow = await db.query('select timezone from ccat.students where id=$1', [sid]);
    const tz = (tzRow.rows[0]?.timezone as string) || 'UTC';

    const gradeRow = await db.query('select grade_id from ccat.students where id=$1', [sid]);
    const gradeId = gradeRow.rows[0]?.grade_id as string | undefined;

    // Battery skeleton — every ACTIVE category, in display order (names + keys straight from the DB, so
    // nothing is hard-coded). Empty batteries still appear with zeros / null.
    const catRows = await db.query(
      `select key, name from ccat.categories where active = true order by display_order, name`);
    const cats = (catRows.rows as any[]).map((c) => ({ key: c.key as string, name: c.name as string }));

    // FULL subcategory list per category (active), including combine — one box per subcategory.
    const subListRows = await db.query(
      `select c.key as cat, s.key as sub_key, s.name as sub_name, s.display_order as sub_order
         from ccat.subcategories s join ccat.categories c on c.id = s.category_id
        where s.active = true order by c.display_order, s.display_order`);

    // Per-subcategory accuracy is derived from the SAME finished-set rows as the sets table below (built
    // in the fold loop) so the subcategory box, the battery ring and each Set row reconcile exactly.
    const subAgg = new Map<string, { correct: number; total: number }>();

    // Total available sets per battery for the grade, EXCLUDING combine (the "/total" denominator).
    // Available = a published version with at least one active question.
    const totalByCat = new Map<string, number>();
    if (gradeId) {
      const totalRows = await db.query(
        `select cat.key as cat, count(distinct qs.id)::int as total
           from ccat.question_sets qs
           join ccat.categories cat on cat.id = qs.category_id
           left join ccat.subcategories sub on sub.id = qs.subcategory_id
          where qs.grade_id = $1
            and (sub.key is null or right(sub.key, 16) <> '_battery_combine')
            and exists (select 1 from ccat.question_set_versions sv
                         where sv.question_set_id = qs.id and sv.state = 'published'
                           and exists (select 1 from ccat.set_version_questions svq
                                        where svq.set_version_id = sv.id and svq.active = true))
          group by cat.key`, [gradeId]);
      for (const t of totalRows.rows as any[]) totalByCat.set(t.cat, t.total);
    }

    // Finished-set rows (most recent finished attempt per set) → fold into per-battery buckets.
    // setsDone EXCLUDES combine sets; score/accuracy/time include everything the student finished.
    const rows = await finishedSetRows(db, sid, r);
    type Bucket = { correct: number; total: number; totalQ: number; setsDone: number; secs: number };
    const byCat = new Map<string, Bucket>();
    let scoreCorrect = 0, scoreTotal = 0, setsDone = 0;
    for (const row of rows) {
      let b = byCat.get(row.cat_key);
      if (!b) { b = { correct: 0, total: 0, totalQ: 0, setsDone: 0, secs: 0 }; byCat.set(row.cat_key, b); }
      b.correct += row.score_correct; b.total += row.score_total; b.totalQ += (row.total_questions ?? 0);
      b.secs += (row.attempt_seconds && row.attempt_seconds > 0 ? row.attempt_seconds : 0);
      if (!isCombine(row.sub_key)) { b.setsDone += 1; setsDone += 1; }
      scoreCorrect += row.score_correct; scoreTotal += row.score_total;
      // per-subcategory aggregate (finished sets) — reconciles with the Set rows
      const sk = `${row.cat_key}|${row.sub_key}`;
      const sa = subAgg.get(sk) ?? { correct: 0, total: 0 };
      sa.correct += row.score_correct; sa.total += row.score_total; subAgg.set(sk, sa);
    }

    // --- practice time: real session wall-clock (started_at → terminal_at) over terminal PRACTICE sessions ---
    const tp: any[] = [sid]; const tc: string[] = ['s.student_id = $1', "s.mode <> 'exam'", 's.terminal_at is not null'];
    if (r.from) { tp.push(r.from); tc.push(`s.terminal_at >= $${tp.length}`); }
    if (r.to) { tp.push(r.to); tc.push(`s.terminal_at < $${tp.length}`); }
    const timeRow = await db.query(
      `select round(coalesce(sum(extract(epoch from (s.terminal_at - s.started_at))), 0) / 60.0)::int as mins
         from ccat.sessions s where ${tc.join(' and ')}`, tp);
    const practiceTimeMinutes = Number(timeRow.rows[0]?.mins ?? 0);

    // --- practice time series: per-day minutes (tz-aware), chronological for the line chart ---
    const spar: any[] = [sid, tz]; const scnd: string[] = ['s.student_id = $1', "s.mode <> 'exam'", 's.terminal_at is not null'];
    if (r.from) { spar.push(r.from); scnd.push(`s.terminal_at >= $${spar.length}`); }
    if (r.to) { spar.push(r.to); scnd.push(`s.terminal_at < $${spar.length}`); }
    const seriesRow = await db.query(
      `select to_char((s.terminal_at at time zone $2)::date, 'YYYY-MM-DD') as date,
              round(sum(extract(epoch from (s.terminal_at - s.started_at))) / 60.0)::int as minutes
         from ccat.sessions s where ${scnd.join(' and ')}
        group by 1 order by 1`, spar);
    const practiceTimeSeries = (seriesRow.rows as any[]).map((x) => ({ date: x.date as string, minutes: Number(x.minutes) }));

    const batteries = cats.map((c) => {
      const b = byCat.get(c.key);
      // Every subcategory of this battery (incl combine) with its accuracy — for the battery boxes AND
      // the sets-table subcategory filter.
      const subcategories = (subListRows.rows as any[])
        .filter((s) => s.cat === c.key)
        .map((s) => {
          const a = subAgg.get(`${c.key}|${s.sub_key}`);
          return { key: s.sub_key as string, name: s.sub_name as string, accuracyPct: a && a.total > 0 ? pct(a.correct, a.total) : null };
        });
      return {
        key: c.key,
        name: c.name,
        accuracyPct: b ? pct(b.correct, b.total) : null,   // battery "progress %" (Home ring)
        score: { correct: b?.correct ?? 0, total: b?.total ?? 0 },
        totalQuestions: b?.totalQ ?? 0,
        avgSecondsPerQuestion: b ? avgPerQ(b.secs, b.total) : null,   // derived from session wall-clock ÷ answered
        setsDone: b?.setsDone ?? 0,        // finished sets, combine excluded
        setsTotal: totalByCat.get(c.key) ?? 0,   // available sets for the grade, combine excluded
        subcategories,
      };
    });

    return {
      score: { correct: scoreCorrect, total: scoreTotal },
      setsDone,
      practiceTimeMinutes,
      practiceTimeSeries,
      batteries,
    };
  });

  // GET /v1/progress/sets?battery=<category key>&subcategory=<subcategory key | 'all'>
  // Per-set rows for one battery (most recent finished attempt per set), optionally filtered to a
  // subcategory. Ordered the way the app lists sets (creation order). Reconciles with /summary batteries.
  app.get('/v1/progress/sets', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const r = pickRange(req.query);
    const q: any = req.query || {};
    const battery = typeof q.battery === 'string' ? q.battery.trim() : '';
    const subRaw = typeof q.subcategory === 'string' ? q.subcategory.trim() : '';
    const sub = subRaw && subRaw.toLowerCase() !== 'all' ? subRaw : null;
    if (!battery) return [];

    const rows = await finishedSetRows(db, sid, r);
    return rows
      .filter((row) => row.cat_key === battery && (sub == null || row.sub_key === sub))
      .map((row) => ({
        setId: row.set_id,
        name: row.set_name,
        subcategory: { key: row.sub_key, name: row.sub_name },
        accuracyPct: pct(row.score_correct, row.score_total),
        score: { correct: row.score_correct, total: row.score_total },
        totalQuestions: row.total_questions ?? 0,
        avgSecondsPerQuestion: avgPerQ(row.attempt_seconds, row.score_total),   // wall-clock ÷ answered
      }));
  });

  // GET /v1/progress/set-review?setId=<question_set id>  → the student's LATEST submitted attempt of a
  // set, rebuilt for read-only review: each question with its options, the correct answer(s) and what the
  // child picked, in the SAME order the child saw (same seeded shuffle as the player), plus a summary
  // (score / accuracy / total session time). Powers the slide-in preview panel on the Progress page.
  app.get('/v1/progress/set-review', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const q: any = req.query || {};
    const setId = typeof q.setId === 'string' ? q.setId.trim() : '';
    const empty = { found: false, setName: null as string | null, score: { correct: 0, total: 0 }, accuracyPct: null as number | null, timeSeconds: null as number | null, questions: [] as any[] };
    if (!setId) return empty;

    const sRes = await db.query(
      `select s.id, s.set_version_id, s.question_order_seed, s.option_order_seed, sv.preserve_order,
              qs.name as set_name, s.started_at, s.terminal_at,
              sr.score_correct::int as score_correct, sr.score_total::int as score_total
         from ccat.sessions s
         join ccat.session_results sr on sr.session_id = s.id
         join ccat.question_set_versions sv on sv.id = s.set_version_id
         join ccat.question_sets qs on qs.id = sv.question_set_id
        where s.student_id = $1 and qs.id = $2 and s.mode <> 'exam'
          and sr.terminal_state in ('SUBMITTED','AUTO_SUBMITTED')
        order by s.terminal_at desc nulls last, sr.created_at desc
        limit 1`, [sid, setId]);
    if (sRes.rows.length === 0) return empty;
    const sess = sRes.rows[0]!;

    const qRes = await db.query(
      `select svq.position, qv.id as question_version_id, qv.question_type,
              qv.prompt_blocks, qv.option_blocks, qv.correct_option_ids, sa.selected_option_ids
         from ccat.set_version_questions svq
         join ccat.question_versions qv on qv.id = svq.question_version_id
         left join ccat.session_answers sa on sa.session_id = $1 and sa.question_version_id = qv.id
        where svq.set_version_id = $2 and svq.active = true
        order by svq.position`, [sess.id, sess.set_version_id]);

    const ordered = sess.preserve_order ? qRes.rows : seededShuffle(qRes.rows, Number(sess.question_order_seed));
    const questions = (ordered as any[]).map((r0, i) => {
      const correctIds: string[] = Array.isArray(r0.correct_option_ids) ? r0.correct_option_ids : [];
      const selected: string[] = Array.isArray(r0.selected_option_ids) ? r0.selected_option_ids : [];
      const options = seededShuffle(
        Array.isArray(r0.option_blocks) ? r0.option_blocks : [],
        (Number(sess.option_order_seed) ^ ((i + 1) * 0x9e3779b1)) >>> 0,
      ).map((o: any) => ({
        option_id: o.option_id,
        content: o.content,
        image_url: imageUrlOfBlocks(o?.content),
        correct: correctIds.includes(o.option_id),
        selected: selected.includes(o.option_id),
      }));
      return {
        question_version_id: r0.question_version_id,
        question_type: r0.question_type,
        prompt_blocks: r0.prompt_blocks,
        image_url: imageUrlOfBlocks(r0.prompt_blocks),
        options,
        selected_option_ids: selected,
        correct_option_ids: correctIds,
        answered: selected.length > 0,
        correct: selected.length > 0 && eqSet(selected, correctIds),
      };
    });
    const timeSeconds = sess.started_at && sess.terminal_at
      ? Math.max(0, Math.round((new Date(sess.terminal_at).getTime() - new Date(sess.started_at).getTime()) / 1000))
      : null;
    return {
      found: true,
      setName: sess.set_name as string,
      score: { correct: sess.score_correct as number, total: sess.score_total as number },
      accuracyPct: sess.score_total > 0 ? Math.round((100 * sess.score_correct) / sess.score_total) : null,
      timeSeconds,
      questions,
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

    type Topic = { subcategory: string; accuracyPct: number | null; avgSecondsPerQuestion: null;
                   completionPct: number | null; questionsDone: number; bestStreak: number; lastPractisedLabel: string; };
    const catsMap = new Map<string, { key: string; order: number; answered: number; correct: number; topics: Map<string, {
      subid: string; name: string; order: number; done: number; correct: number; run: number; best: number; lastDay: string | null; }> }>();
    for (const row of rows.rows as any[]) {
      if (!catsMap.has(row.category)) catsMap.set(row.category, { key: row.category, order: row.cat_order, answered: 0, correct: 0, topics: new Map() });
      const c = catsMap.get(row.category)!;
      c.answered += 1; if (row.correct) c.correct += 1;
      let t = c.topics.get(row.subid);
      if (!t) { t = { subid: row.subid, name: row.subname, order: row.sub_order, done: 0, correct: 0, run: 0, best: 0, lastDay: null }; c.topics.set(row.subid, t); }
      t.done += 1;
      if (row.correct) { t.correct += 1; t.run += 1; if (t.run > t.best) t.best = t.run; } else { t.run = 0; }
      if (!t.lastDay || row.day > t.lastDay) t.lastDay = row.day;
    }

    const result = CAT_ORDER.map((key) => {
      const c = catsMap.get(key);
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
