import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';

// STUDENT-FACING assignments (read-only). The teacher/admin creates assignments via
// /v1/admin/students/:id/assignments (admin-students.ts, table ccat.student_assignments); this endpoint
// is the child's own view of the sets a teacher assigned to THEM. Status is DERIVED from the student's
// real session on that set (assigned → in_progress → done), exactly like the admin list. Ordering:
// INCOMPLETE first (assigned/in_progress), then done; newest-assigned first within each group — so the
// Home panel and Assignments page show "what to do next" at the top and scroll down to finished work.
export function registerAssignmentRoutes(app: FastifyInstance, db: DB) {
  app.get('/v1/assignments', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const { rows } = await db.query(
      `select a.id, a.set_version_id, a.assigned_at,
              qs.id as question_set_id, qs.name,
              cat.key as category_key, cat.name as category_name,
              sub.key as subcategory_key, sub.name as subcategory,
              sv.question_count, sv.duration_minutes, sv.allowed_exam,
              ap.display_name as assigned_by_name,
              sess.session_id, sess.has_session, sess.is_terminal,
              sess.score_correct, sess.score_total,
              sess.started_at, sess.terminal_at, sess.answered_count
         from ccat.student_assignments a
         join ccat.question_set_versions sv on sv.id = a.set_version_id
         join ccat.question_sets qs on qs.id = sv.question_set_id
         join ccat.categories cat on cat.id = qs.category_id
         left join ccat.subcategories sub on sub.id = qs.subcategory_id
         left join ccat.admin_profiles ap on ap.id = a.assigned_by
         left join lateral (
           select s.id as session_id, true as has_session,
                  (sr.terminal_state in ('SUBMITTED','AUTO_SUBMITTED')) as is_terminal,
                  sr.score_correct::int as score_correct, sr.score_total::int as score_total,
                  s.started_at, s.terminal_at,
                  (select count(*)::int from ccat.session_answers sa
                     where sa.session_id = s.id and coalesce(array_length(sa.selected_option_ids,1),0) > 0) as answered_count
             from ccat.sessions s
             left join ccat.session_results sr on sr.session_id = s.id
            where s.student_id = a.student_id and s.set_version_id = a.set_version_id
            order by (sr.terminal_state in ('SUBMITTED','AUTO_SUBMITTED')) desc, s.started_at desc
            limit 1
         ) sess on true
        where a.student_id = $1
        -- Incomplete (assigned/in_progress) first, then done; newest assigned first within each group.
        order by coalesce(sess.is_terminal, false) asc, a.assigned_at desc, a.id desc`,
      [sid]);

    return rows.map((r: any) => {
      const isExam = r.allowed_exam === true;
      const status: 'assigned' | 'in_progress' | 'done' =
        r.is_terminal ? 'done' : (r.has_session ? 'in_progress' : 'assigned');
      const total = Number(r.score_total ?? 0);
      return {
        id: r.id,
        set_version_id: r.set_version_id,
        question_set_id: r.question_set_id,
        name: r.name,
        category_key: r.category_key,
        category_name: r.category_name,               // battery display name (e.g. "Verbal Reasoning")
        subcategory_key: r.subcategory_key ?? null,
        subcategory: r.subcategory ?? null,           // sub-category name (null for exam papers)
        is_exam: isExam,
        question_count: r.question_count ?? null,
        duration_minutes: r.duration_minutes ?? null,
        // Teacher name = the assigning admin's display name (falls back when the assigner was deleted).
        teacher_name: r.assigned_by_name ?? null,
        assigned_at: r.assigned_at,
        status,
        // Latest session for this set — lets "Continue" jump straight into an in-progress attempt.
        session_id: r.session_id ?? null,
        progress: status === 'in_progress'
          ? { answered: Number(r.answered_count ?? 0), total: Number(r.question_count ?? 0) } : null,
        result: status === 'done' ? {
          score: { correct: Number(r.score_correct ?? 0), total },
          accuracyPct: total > 0 ? Math.round((100 * Number(r.score_correct ?? 0)) / total) : null,
          finishedAt: r.terminal_at,
        } : null,
      };
    });
  });
}
