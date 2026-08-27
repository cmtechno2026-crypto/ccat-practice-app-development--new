import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { Errors } from '../errors.js';

// PRACTICE per-question feedback loop (client-agnostic; mobile may use it too). Instant
// correct/incorrect, a hint on a wrong first attempt (only if authored — never fabricated),
// a 2nd attempt, and reveal (correct option + explanation) once the answer is committed and can
// no longer change. EXAM sessions are rejected server-side — exam never reveals mid-session.
//
// No answer-key leak: correctness is computed here per submitted attempt; the correct option and
// explanation are returned ONLY after the question is committed/locked, never in the question payload.
// Scoring is unchanged: each attempt writes the student's option into session_answers, and the
// existing binary scorer (economy.scoreSession) grades the committed option at submit.
const MAX_ATTEMPTS = 2;
// Accept either a single option (single-answer questions) or a set (multi-correct "pick all").
const bodySchema = z.object({
  selectedOptionId: z.string().min(1).optional(),
  selectedOptionIds: z.array(z.string().min(1)).min(1).optional(),
}).refine((b) => b.selectedOptionId || (b.selectedOptionIds && b.selectedOptionIds.length), {
  message: 'selectedOptionId or selectedOptionIds required',
});

export function registerPracticeRoutes(app: FastifyInstance, db: DB) {
  app.post(
    '/v1/practice/sessions/:sessionId/questions/:questionVersionId/attempt',
    { preHandler: [app.authenticateStudent] },
    async (req) => {
      const { sessionId, questionVersionId } = req.params as { sessionId: string; questionVersionId: string };
      const parsed = bodySchema.parse(req.body);
      // Normalize to a de-duplicated set of chosen options (single-answer = one element).
      const selectedIds: string[] = Array.from(new Set(parsed.selectedOptionIds ?? [parsed.selectedOptionId!]));
      const studentId = req.student!.studentId;

      // Session must be the caller's own, in progress, and PRACTICE.
      const sres = await db.query(
        `select id, mode, state, set_version_id from ccat.sessions where id = $1 and student_id = $2`,
        [sessionId, studentId],
      );
      if (sres.rows.length === 0) throw Errors.notFound('Session not found');
      const sess = sres.rows[0]!;
      if (sess.state !== 'IN_PROGRESS') throw Errors.sessionTerminal();
      if (sess.mode !== 'practice') {
        // Exam (or any non-practice) can NEVER use per-question feedback.
        throw Errors.forbidden('PRACTICE_ONLY', 'Per-question feedback is available in practice mode only');
      }

      // Question must belong to this session's set (active membership).
      const qres = await db.query(
        `select qv.correct_option_ids, qv.explanation_blocks
           from ccat.set_version_questions svq
           join ccat.question_versions qv on qv.id = svq.question_version_id
          where svq.set_version_id = $1 and qv.id = $2 and svq.active = true`,
        [sess.set_version_id, questionVersionId],
      );
      if (qres.rows.length === 0) throw Errors.notFound('Question not found in this set');
      const correctIds: string[] = qres.rows[0]!.correct_option_ids ?? [];
      const explanation = qres.rows[0]!.explanation_blocks ?? null; // authored; may be null → degrade
      const correctOptionId = correctIds[0] ?? null;
      const isMulti = correctIds.length > 1;
      // Set-equality grading: chosen set must exactly match the correct set (order-independent).
      const setsEqual = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

      // Current per-question attempt state.
      const cur = await db.query(
        `select selected_option_ids, answer_version, is_locked, attempts
           from ccat.session_answers where session_id = $1 and question_version_id = $2`,
        [sessionId, questionVersionId],
      );
      const row = cur.rows[0];
      // Reveal exposes the correct option(s) + authored explanation — only after commit.
      const reveal = () => ({ correctOptionId, correctOptionIds: correctIds, explanation });

      // Already committed/locked → return the revealed state idempotently (safe: post-commit only).
      if (row?.is_locked) {
        const prev: string[] = row.selected_option_ids ?? [];
        const wasCorrect = isMulti ? setsEqual(prev, correctIds) : prev.some((o: string) => correctIds.includes(o));
        return { correct: wasCorrect, attemptsUsed: row.attempts ?? MAX_ATTEMPTS, attemptsRemaining: 0, revealed: reveal() };
      }

      const correct = isMulti ? setsEqual(selectedIds, correctIds) : correctIds.includes(selectedIds[0]!);
      const attemptsUsed = (row?.attempts ?? 0) + 1;
      const lock = correct || attemptsUsed >= MAX_ATTEMPTS;
      const nextVersion = (row?.answer_version ?? 0) + 1;

      // Commit the student's option(s) into session_answers (drives the existing scorer at submit).
      await db.query(
        `insert into ccat.session_answers
           (session_id, question_version_id, selected_option_ids, answer_version, is_locked, attempts)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (session_id, question_version_id) do update
           set selected_option_ids = excluded.selected_option_ids,
               answer_version = excluded.answer_version,
               is_locked = excluded.is_locked,
               attempts = excluded.attempts`,
        [sessionId, questionVersionId, selectedIds, nextVersion, lock, attemptsUsed],
      );

      const base = { correct, attemptsUsed, attemptsRemaining: Math.max(0, MAX_ATTEMPTS - attemptsUsed) };
      if (lock) {
        // Correct (any attempt) OR attempts exhausted → reveal correct option + authored explanation.
        return { ...base, revealed: reveal() };
      }
      // Wrong first attempt → allow retry. Hint only if authored (none today → omitted, never faked).
      return base;
    },
  );
}
