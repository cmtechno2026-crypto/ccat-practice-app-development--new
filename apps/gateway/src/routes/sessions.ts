import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors, AppError } from '../errors.js';
import { checkIdempotency, saveIdempotency } from '../lib/idempotency.js';
import { finalizeSession } from '../lib/finalize.js';
import { seededShuffle } from '../lib/shuffle.js';
import { resolveEntitlement, computeDemoSetIds, isCombineSubcategory } from '../lib/entitlements.js';

// Extract the ready-to-use image URL from a block array (question prompt or option content). Blocks
// store an image as { type:'image', url, asset_id, ... }; the url is the asset's public URL (absolute
// for cloud storage, or the gateway's /v1/assets/:id route for local disk). Returns null when there is
// no image block.
function imageUrlOfBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const img = blocks.find((b: any) => b && b.type === 'image');
  return img && typeof img.url === 'string' ? img.url : null;
}

const startSchema = z.object({
  set_version_id: z.string().uuid(),
  mode: z.enum(['practice', 'exam']),
  timer_type: z.enum(['untimed', 'timed']),
  duration_seconds: z.number().int().positive().optional(),
});
const submitSchema = z.object({
  submission_id: z.string().min(1),
  expected_session_version: z.number().int(),
});
const answersSchema = z.object({
  answers: z.array(
    z.object({
      question_version_id: z.string().uuid(),
      selected_option_ids: z.array(z.string()),
      answer_version: z.number().int().positive(),
    }),
  ).min(1),
});
const abandonSchema = z.object({ confirm: z.boolean().optional() });

// Group a session_results.detail array (per-question {category_key, correct, attempted}) into
// per-battery rows (the exam batteries = categories) + a total attempted count.
function summarizeBattery(detail: unknown): { byBattery: { category_key: string; correct: number; total: number; attempted: number }[]; attempted: number } {
  const rows = Array.isArray(detail) ? (detail as { category_key: string; correct: boolean; attempted: boolean }[]) : [];
  const map = new Map<string, { category_key: string; correct: number; total: number; attempted: number }>();
  let attempted = 0;
  for (const d of rows) {
    const k = d.category_key ?? 'other';
    const b = map.get(k) ?? { category_key: k, correct: 0, total: 0, attempted: 0 };
    b.total += 1;
    if (d.correct) b.correct += 1;
    if (d.attempted) { b.attempted += 1; attempted += 1; }
    map.set(k, b);
  }
  return { byBattery: Array.from(map.values()), attempted };
}

function seedFrom(...parts: string[]): number {
  let h = 2166136261;
  for (const p of parts) for (let i = 0; i < p.length; i++) { h ^= p.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

export function registerSessionRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  // Payments Phase 2 — the HARD gate. Server-side enforcement that cannot be bypassed by the client.
  // Throws 403 { code:'upgrade_required', details:{ requiredTier, feature } } when the student's
  // effective entitlement does not permit starting/serving this set. Only called when cfg.paymentsEnabled
  // is true, so the flag-off path is completely unchanged.
  async function assertSetAllowed(
    studentId: string,
    ctx: { mode: 'practice' | 'exam'; setVersionId: string; gradeId: string; subcategoryKey: string | null; maxQuestionsPerSet: number | null },
  ): Promise<void> {
    const { capabilities: caps } = await resolveEntitlement(db, studentId);
    if (ctx.mode === 'exam') {
      if (!caps.exam) throw new AppError(403, 'upgrade_required', 'This exam is part of a membership', { requiredTier: 't250', feature: 'exam' });
      return;
    }
    // practice mode
    const isCombine = isCombineSubcategory(ctx.subcategoryKey, ctx.maxQuestionsPerSet);
    if (isCombine) {
      if (!caps.combine) throw new AppError(403, 'upgrade_required', 'Battery Combine is part of a membership', { requiredTier: 't250', feature: 'combine' });
      return;
    }
    if (caps.practice !== 'all') {
      const demoSetIds = await computeDemoSetIds(db, ctx.gradeId);
      if (!demoSetIds.has(ctx.setVersionId)) {
        throw new AppError(403, 'upgrade_required', 'Unlock all practice with a membership', { requiredTier: 't50', feature: 'practice' });
      }
    }
  }

  // POST /v1/sessions/start — one active session per student (§9.1, §9.2)
  app.post('/v1/sessions/start', { preHandler: [app.authenticateStudent] }, async (req, reply) => {
    const body = startSchema.parse(req.body);
    const { studentId, deviceId } = req.student!;

    const sv = await db.query(
      `select sv.id, sv.allowed_practice, sv.allowed_exam, sv.state, sv.ruleset_version_id, qs.grade_id,
              sub.key as subcategory_key
         from ccat.question_set_versions sv
         join ccat.question_sets qs on qs.id = sv.question_set_id
         join ccat.subcategories sub on sub.id = qs.subcategory_id
        where sv.id = $1`,
      [body.set_version_id],
    );
    if (sv.rows.length === 0) throw Errors.notFound('Set version not found');
    const set = sv.rows[0]!;
    // Grade isolation (§8 / §32.3): a student may only start a set scoped to their own grade.
    // Mirrors the catalog's `qs.grade_id = student.grade_id` filter, for BOTH practice and exam.
    // Checked before the published gate so a cross-grade set is indistinguishable from a
    // nonexistent one (non-leaking 404) — the client never learns another grade's set exists.
    const gs = await db.query(`select grade_id from ccat.students where id = $1`, [studentId]);
    if (gs.rows.length === 0 || gs.rows[0]!.grade_id !== set.grade_id) throw Errors.notFound('Set version not found');
    if (set.state !== 'published') throw Errors.validation('Set version is not published', { code: 'SET_NOT_PUBLISHED' });
    // Grade-level practice switch (Admin → Practice control). When practice is disabled for the
    // student's grade, the server refuses to start a practice session regardless of client state —
    // the toggle is authoritative, not merely a UI hint.
    if (body.mode === 'practice') {
      const g = await db.query(
        `select g.practice_enabled from ccat.students s join ccat.grades g on g.id = s.grade_id where s.id = $1`,
        [studentId],
      );
      if (g.rows.length && g.rows[0]!.practice_enabled === false)
        throw Errors.validation('Practice is currently disabled for this grade', { code: 'PRACTICE_DISABLED_FOR_GRADE' });
    }
    if (body.mode === 'practice' && !set.allowed_practice) throw Errors.validation('Practice not allowed', { code: 'MODE_NOT_ALLOWED' });
    if (body.mode === 'exam' && !set.allowed_exam) throw Errors.validation('Exam not allowed', { code: 'MODE_NOT_ALLOWED' });
    if (body.timer_type === 'timed' && !body.duration_seconds) throw Errors.validation('duration_seconds required for timed');

    // Payments Phase 2 hard gate (flag-gated). A locked set MUST NOT start a session. Placed after the
    // existing grade/published/mode checks so error precedence (non-leaking 404 for cross-grade) is
    // preserved. Flag OFF → skipped entirely (unchanged behavior).
    if (cfg.paymentsEnabled) {
      await assertSetAllowed(studentId, {
        mode: body.mode,
        setVersionId: body.set_version_id,
        gradeId: String(set.grade_id),
        subcategoryKey: set.subcategory_key ?? null,
        // Combine is detected from the subcategory KEY (a committed column); max_questions_per_set is
        // deliberately not selected here so this path does not depend on that out-of-band column.
        maxQuestionsPerSet: null,
      });
    }

    const deadline = body.timer_type === 'timed'
      ? new Date(Date.now() + (body.duration_seconds ?? 0) * 1000)
      : null;

    try {
      const s = await db.query(
        `insert into ccat.sessions
          (student_id, student_device_id, set_version_id, ruleset_version_id, mode, timer_type,
           duration_seconds, question_order_seed, option_order_seed, deadline_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning id, session_version, state, started_at, deadline_at`,
        [
          studentId, deviceId, body.set_version_id, set.ruleset_version_id, body.mode, body.timer_type,
          body.duration_seconds ?? null,
          seedFrom(studentId, body.set_version_id, 'q'),
          seedFrom(studentId, body.set_version_id, 'o'),
          deadline,
        ],
      );
      const row = s.rows[0]!;
      reply.code(201);
      return {
        id: row.id, set_version_id: body.set_version_id, mode: body.mode, timer_type: body.timer_type,
        duration_seconds: body.duration_seconds ?? null, state: row.state,
        session_version: row.session_version, started_at: row.started_at, deadline_at: row.deadline_at,
      };
    } catch (e: any) {
      // Multiple concurrent ("paused") sessions are allowed — migration 0037 dropped the
      // sessions_one_in_progress unique index, so a second IN_PROGRESS insert no longer raises 23505.
      // Starting a new set must NEVER be blocked by an existing paused set, so we do NOT map 23505 to
      // ACTIVE_SESSION_EXISTS anymore (that was the "A learning session is already in progress" toast).
      throw e;
    }
  });

  // GET /v1/sessions/active — the student's in-progress session, enriched with set metadata + answered
  // progress so the "Pick up where you left off" home card can show the set name and how far along the
  // student is. Client-agnostic (mobile can use it too).
  app.get('/v1/sessions/active', { preHandler: [app.authenticateStudent] }, async (req) => {
    const { rows } = await db.query(
      `select s.id, s.set_version_id, s.mode, s.timer_type, s.duration_seconds, s.state, s.session_version,
              s.started_at, s.deadline_at,
              qs.name as set_name, cat.key as category_key, sub.name as subcategory, d.key as difficulty,
              sv.question_count,
              (select count(*)::int from ccat.session_answers sa
                 where sa.session_id = s.id and sa.answer_version > 0) as answered_count
         from ccat.sessions s
         join ccat.question_set_versions sv on sv.id = s.set_version_id
         join ccat.question_sets qs on qs.id = sv.question_set_id
         join ccat.categories cat on cat.id = qs.category_id
         join ccat.subcategories sub on sub.id = qs.subcategory_id
         left join ccat.difficulties d on d.id = sv.difficulty_id
        where s.student_id = $1 and s.state = 'IN_PROGRESS'
        order by s.started_at desc
        limit 1`,
      [req.student!.studentId],
    );
    return rows[0] ?? null;
  });

  // GET /v1/sessions/:id — session + questions (exam-safe: no correctness/explanations ever
  // leave the server here; correct_option_ids is never selected).
  app.get('/v1/sessions/:id', { preHandler: [app.authenticateStudent] }, async (req) => {
    const id = (req.params as { id: string }).id;
    const s = await db.query(
      `select s.id, s.set_version_id, s.mode, s.timer_type, s.duration_seconds, s.state, s.session_version, s.started_at, s.deadline_at,
              s.question_order_seed, s.option_order_seed, sv.preserve_order,
              qs.grade_id, sub.key as subcategory_key,
              qs.name as set_name, cat.key as category_key, sub.name as subcategory, d.key as difficulty
         from ccat.sessions s
         join ccat.question_set_versions sv on sv.id = s.set_version_id
         join ccat.question_sets qs on qs.id = sv.question_set_id
         left join ccat.categories cat on cat.id = qs.category_id
         left join ccat.subcategories sub on sub.id = qs.subcategory_id
         left join ccat.difficulties d on d.id = sv.difficulty_id
        where s.id = $1 and s.student_id = $2`,
      [id, req.student!.studentId],
    );
    if (s.rows.length === 0) throw Errors.notFound('Session not found');
    const sess = s.rows[0]!;
    // Payments Phase 2 defense-in-depth (flag-gated): a locked set MUST NOT return its questions, even
    // if a session row exists. Re-checks the CURRENT entitlement. Flag OFF → skipped (unchanged).
    if (cfg.paymentsEnabled) {
      await assertSetAllowed(req.student!.studentId, {
        mode: sess.mode,
        setVersionId: sess.set_version_id,
        gradeId: String(sess.grade_id),
        subcategoryKey: sess.subcategory_key ?? null,
        maxQuestionsPerSet: null, // combine detected from subcategory key; avoids the out-of-band column
      });
    }
    const qs = await db.query(
      `select svq.position, qv.id as question_version_id, qv.logical_question_id, qv.question_type, qv.prompt_blocks, qv.option_blocks,
              (coalesce(array_length(qv.correct_option_ids, 1), 1) > 1) as multi,
              qcat.key as category_key, qcat.name as category_name,
              sa.selected_option_ids, sa.answer_version
         from ccat.set_version_questions svq
         join ccat.question_versions qv on qv.id = svq.question_version_id
         join ccat.logical_questions lq on lq.id = qv.logical_question_id
         join ccat.categories qcat on qcat.id = lq.category_id
         left join ccat.session_answers sa on sa.session_id = $1 and sa.question_version_id = qv.id
        where svq.set_version_id = $2 and svq.active = true
        order by svq.position`,
      [id, sess.set_version_id],
    );
    // Server-controlled deterministic shuffle by the session's stored seeds (§9.2, §17.3), unless the
    // set fixes authoring order (CONTENT-3 preserve_order), in which case serve by position.
    const orderedQuestions = sess.preserve_order ? qs.rows : seededShuffle(qs.rows, Number(sess.question_order_seed));
    const { question_order_seed, option_order_seed, preserve_order, grade_id, subcategory_key, ...sessionOut } = sess;
    return {
      ...sessionOut,
      questions: orderedQuestions.map((r, i) => ({
        question_version_id: r.question_version_id,
        logical_question_id: r.logical_question_id,
        question_type: r.question_type,
        multi: r.multi === true, // "pick all correct" — count only, never which options
        category_key: r.category_key, // battery grouping for exam (Verbal/Non-verbal/Quantitative)
        category_name: r.category_name,
        prompt_blocks: r.prompt_blocks,
        // Ready-to-use figure URL for the question (from its prompt image block), null when none.
        image_url: imageUrlOfBlocks(r.prompt_blocks),
        // Options shuffled per-question with a seed derived from the session option seed + index.
        // Each option also carries a ready image_url (from an image block in its content), null when none.
        option_blocks: seededShuffle(
          Array.isArray(r.option_blocks) ? r.option_blocks : [],
          (Number(sess.option_order_seed) ^ ((i + 1) * 0x9e3779b1)) >>> 0,
        ).map((o: any) => ({ ...o, image_url: imageUrlOfBlocks(o?.content) })),
        selected_option_ids: r.selected_option_ids ?? [],
        answer_version: r.answer_version ?? 0,
      })),
    };
  });

  // PATCH /v1/sessions/:id/answers — versioned autosave (§12). Stale writes rejected.
  app.patch('/v1/sessions/:id/answers', { preHandler: [app.authenticateStudent] }, async (req) => {
    const id = (req.params as { id: string }).id;
    const body = answersSchema.parse(req.body);
    const s = await db.query(
      `select id, state, timer_type, deadline_at from ccat.sessions where id = $1 and student_id = $2`,
      [id, req.student!.studentId],
    );
    if (s.rows.length === 0) throw Errors.notFound('Session not found');
    const sess = s.rows[0]!;
    if (sess.state !== 'IN_PROGRESS') throw Errors.sessionTerminal();
    // Deadline-aware guard (§14): a timed session past its deadline cannot accept answers;
    // finalize it and reject the write.
    if (sess.timer_type === 'timed' && sess.deadline_at && new Date(sess.deadline_at) <= new Date()) {
      await finalizeSession(db, id, req.student!.studentId, { finalizedBy: 'deadline', submissionId: `auto:${id}` });
      throw Errors.conflict('DEADLINE_PASSED', 'Session deadline has passed');
    }

    const acks: { question_version_id: string; accepted_version: number }[] = [];
    for (const a of body.answers) {
      const cur = await db.query(
        `select answer_version, is_locked from ccat.session_answers where session_id = $1 and question_version_id = $2`,
        [id, a.question_version_id],
      );
      if (cur.rows.length === 0) {
        await db.query(
          `insert into ccat.session_answers(session_id, question_version_id, selected_option_ids, answer_version)
           values ($1,$2,$3,$4)`,
          [id, a.question_version_id, a.selected_option_ids, a.answer_version],
        );
        acks.push({ question_version_id: a.question_version_id, accepted_version: a.answer_version });
      } else {
        const row = cur.rows[0]!;
        if (row.is_locked) throw Errors.sessionTerminal();
        if (a.answer_version <= row.answer_version) throw Errors.staleAnswer();
        await db.query(
          `update ccat.session_answers set selected_option_ids = $3, answer_version = $4
             where session_id = $1 and question_version_id = $2`,
          [id, a.question_version_id, a.selected_option_ids, a.answer_version],
        );
        acks.push({ question_version_id: a.question_version_id, accepted_version: a.answer_version });
      }
    }
    return acks;
  });

  // POST /v1/sessions/:id/submit — exactly-once (§13). Idempotent by submission_id.
  app.post('/v1/sessions/:id/submit', { preHandler: [app.authenticateStudent] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = submitSchema.parse(req.body);
    const idemKey = (req.headers['idempotency-key'] as string) || body.submission_id;
    const op = 'POST /sessions/{id}/submit';

    const prior = await checkIdempotency(db, op, `${id}:${idemKey}`, body);
    if (prior) { reply.code(prior.status_code); return prior.response_body; }

    const outcome = await finalizeSession(db, id, req.student!.studentId, {
      finalizedBy: 'manual',
      submissionId: body.submission_id,
      expectedSessionVersion: body.expected_session_version,
    });

    await saveIdempotency(db, op, `${id}:${idemKey}`, body, 200, outcome.result);
    reply.code(200);
    return outcome.result;
  });

  // POST /v1/sessions/:id/abandon — explicit abandonment (§10). Exam requires confirm.
  app.post('/v1/sessions/:id/abandon', { preHandler: [app.authenticateStudent] }, async (req) => {
    const id = (req.params as { id: string }).id;
    const body = abandonSchema.parse(req.body ?? {});
    const s = await db.query(
      `select id, state, mode from ccat.sessions where id = $1 and student_id = $2`,
      [id, req.student!.studentId],
    );
    if (s.rows.length === 0) throw Errors.notFound('Session not found');
    const sess = s.rows[0]!;
    if (sess.state !== 'IN_PROGRESS') throw Errors.sessionTerminal();
    if (sess.mode === 'exam' && body.confirm !== true) throw Errors.validation('Exam abandonment requires confirm=true');
    await db.query(
      `update ccat.sessions set state='ABANDONED', terminal_at=now(), session_version = session_version + 1 where id=$1`,
      [id],
    );
    await db.query(`update ccat.session_answers set is_locked = true where session_id = $1`, [id]);
    return { session_id: id, terminal_state: 'ABANDONED' };
  });

  // GET /v1/sessions/:id/result — recovery after a lost response (§13.3)
  app.get('/v1/sessions/:id/result', { preHandler: [app.authenticateStudent] }, async (req) => {
    const id = (req.params as { id: string }).id;
    const { rows } = await db.query(
      `select r.session_id, r.terminal_state, r.score_correct, r.score_total, r.xp_awarded, r.coins_awarded, r.detail,
              s.mode, s.timer_type,
              greatest(0, extract(epoch from (s.terminal_at - s.started_at)))::int as time_spent_seconds
         from ccat.session_results r join ccat.sessions s on s.id = r.session_id
        where r.session_id = $1 and s.student_id = $2`,
      [id, req.student!.studentId],
    );
    if (rows.length === 0) throw Errors.notFound('Result not found');
    const r = rows[0]!;
    const { byBattery, attempted } = summarizeBattery(r.detail);
    return {
      session_id: r.session_id,
      terminal_state: r.terminal_state,
      score_correct: r.score_correct,
      score_total: r.score_total,
      xp_awarded: r.xp_awarded,
      coins_awarded: r.coins_awarded,
      mode: r.mode,
      timer_type: r.timer_type,
      time_spent_seconds: r.time_spent_seconds,
      attempted_count: attempted,
      by_battery: byBattery, // [{category_key, correct, total, attempted}] — for exam result breakdown
      // Timed-out = auto-finalized by the deadline/worker path, not a manual submit.
      timed_out: r.terminal_state === 'AUTO_SUBMITTED',
    };
  });

  // GET /v1/exams/history — the student's finished EXAM sessions with per-battery breakdown
  // (client-agnostic; powers the Achievements "Exam progress" panel). Newest first.
  app.get('/v1/exams/history', { preHandler: [app.authenticateStudent] }, async (req) => {
    const { rows } = await db.query(
      `select s.id as session_id, s.terminal_at, r.terminal_state, r.score_correct, r.score_total, r.detail,
              greatest(0, extract(epoch from (s.terminal_at - s.started_at)))::int as time_spent_seconds,
              qs.name as set_name
         from ccat.sessions s
         join ccat.session_results r on r.session_id = s.id
         join ccat.question_set_versions sv on sv.id = s.set_version_id
         join ccat.question_sets qs on qs.id = sv.question_set_id
        where s.student_id = $1 and s.mode = 'exam'
        order by s.terminal_at desc nulls last
        limit 10`,
      [req.student!.studentId],
    );
    return rows.map((r) => {
      const { byBattery, attempted } = summarizeBattery(r.detail);
      const total = r.score_total ?? 0;
      return {
        session_id: r.session_id,
        set_name: r.set_name,
        when: r.terminal_at,
        end_reason: r.terminal_state, // SUBMITTED | AUTO_SUBMITTED | ABANDONED
        score_correct: r.score_correct,
        score_total: total,
        accuracy_pct: total > 0 ? Math.round((100 * r.score_correct) / total) : 0,
        attempted_count: attempted,
        time_spent_seconds: r.time_spent_seconds,
        by_battery: byBattery,
      };
    });
  });
}
