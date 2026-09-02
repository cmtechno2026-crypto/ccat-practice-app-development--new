import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { deriveAgeYears } from '../lib/age.js';
import { Errors } from '../errors.js';

export function registerCatalogRoutes(app: FastifyInstance, db: DB) {
  // GET /v1/grades — data-driven catalog (§29). Public-ish (no student data).
  app.get('/v1/grades', async () => {
    const { rows } = await db.query(
      `select id, grade_number, name, display_order, registration_enabled, practice_enabled
         from ccat.grades where active = true and retired_at is null order by display_order, grade_number`,
    );
    return rows;
  });

  // GET /v1/catalog — published sets available to the student's grade (§8, §32.3), each enriched
  // with the student's own per-set progress (client-agnostic; mobile may use it too) so a client
  // can render Completed / Resume / Redo / Start states. The progress subquery picks the student's
  // most-recent session for that set: terminal → completed (with score); in-progress → answered
  // count; none → not_started.
  app.get('/v1/catalog', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const { rows } = await db.query(
      `select sv.id as set_version_id, qs.name, cat.key as category_key, cat.name as category_name, sub.name as subcategory,
              coalesce(sub.max_questions_per_set, 15) as max_questions_per_set,
              cat.display_order as cat_order, sub.display_order as sub_order, sv.state as set_state,
              d.key as difficulty, sv.question_count, sv.allowed_practice, sv.allowed_exam, sv.duration_minutes,
              g.practice_enabled as grade_practice_enabled,
              p.session_id, p.state as session_state, p.mode as session_mode,
              p.score_correct, p.score_total, p.answered_count
         from ccat.students st
         join ccat.grades g on g.id = st.grade_id
         join ccat.question_sets qs on qs.grade_id = st.grade_id
         join ccat.categories cat on cat.id = qs.category_id
         join ccat.subcategories sub on sub.id = qs.subcategory_id
         join ccat.question_set_versions sv on sv.question_set_id = qs.id and (
              -- Live, playable sets…
              (sv.state = 'published'
                 and exists (select 1 from ccat.set_version_questions svq where svq.set_version_id = sv.id and svq.active = true))
              -- …plus sets this student already played that were later RETIRED, so their history stays
              -- visible (shown greyed at the bottom, not startable). Other students never see these.
              or (sv.state = 'retired'
                 and exists (select 1 from ccat.sessions sr where sr.student_id = st.id and sr.set_version_id = sv.id))
           )
         left join ccat.difficulties d on d.id = sv.difficulty_id
         left join lateral (
            select ss.id as session_id, ss.state, ss.mode,
                   r.score_correct, r.score_total,
                   (select count(*)::int from ccat.session_answers sa
                      where sa.session_id = ss.id and sa.answer_version > 0) as answered_count
              from ccat.sessions ss
              left join ccat.session_results r on r.session_id = ss.id
             where ss.student_id = $1 and ss.set_version_id = sv.id
             order by ss.started_at desc
             limit 1
         ) p on true
        where st.id = $1
        -- Canonical set order (SAME as admin): within each subcategory, ACTIVE (published) sets first
        -- oldest→newest by the version's created_at (a newly published set lands at the BOTTOM), then the
        -- student's own RETIRED sets last. Never sort by qs.name (numeric/editable → lexical 1,10,11,2).
        order by cat.display_order, sub.display_order, (sv.state = 'retired'), sv.created_at asc, sv.id asc`,
      [sid],
    );
    return rows.map((r) => {
      const isTerminal = r.session_state && r.session_state !== 'IN_PROGRESS';
      const inProgress = r.session_state === 'IN_PROGRESS';
      const retired = r.set_state === 'retired';
      const status = inProgress ? 'in_progress' : isTerminal ? 'completed' : 'not_started';
      return {
        set_version_id: r.set_version_id,
        name: r.name,
        retired,
        category_key: r.category_key,
        category_name: r.category_name,   // battery display name (e.g. "Verbal Reasoning")
        subcategory: r.subcategory,
        maxQuestionsPerSet: Number(r.max_questions_per_set ?? 15),
        difficulty: r.difficulty,
        question_count: r.question_count,
        duration_minutes: r.duration_minutes ?? null,
        // Practice is offered only when the set allows it AND the grade's practice switch is on
        // (Admin → Practice control). Exam availability is independent of the practice switch.
        allowed_modes: [(r.allowed_practice && r.grade_practice_enabled !== false) ? 'practice' : null, r.allowed_exam ? 'exam' : null].filter(Boolean),
        progress: {
          status,
          session_id: r.session_id ?? null,
          answered_count: inProgress ? (r.answered_count ?? 0) : 0,
          score_correct: isTerminal ? r.score_correct : null,
          score_total: isTerminal ? r.score_total : null,
        },
      };
    });
  });

  // GET /v1/profile — computed age (§4.2)
  app.get('/v1/profile', { preHandler: [app.authenticateStudent] }, async (req) => {
    const { rows } = await db.query(
      `select id, display_name, username_normalized as username, grade_id, birth_month, birth_year,
              status, active_avatar_stage_id, active_theme_id, is_preview
         from ccat.students where id = $1`,
      [req.student!.studentId],
    );
    if (rows.length === 0) throw Errors.notFound('Profile not found');
    const s = rows[0]!;
    return {
      id: s.id,
      display_name: s.display_name,
      username: s.username,
      grade_id: s.grade_id,
      age_years: deriveAgeYears(s.birth_month, s.birth_year),
      status: s.status,
      active_avatar_stage_id: s.active_avatar_stage_id,
      active_theme_id: s.active_theme_id,
      is_preview: s.is_preview === true,
    };
  });

  // GET /v1/channel-status — public per-client channel + maintenance contract (§ CONTROL). Any client
  // (website / mobile app) reads this UNAUTHENTICATED to learn whether its channel is open. Admin
  // toggles ccat.global_flags (maintenance_mode / channel_web_enabled / channel_app_enabled) via
  // POST /v1/admin/config/flags; this endpoint reflects those changes immediately, with no redeploy.
  // A flag that has never been set defaults to enabled (true), matching the admin flags view.
  app.get('/v1/channel-status', async () => {
    const { rows } = await db.query(
      `select key, value from ccat.global_flags
        where key in ('maintenance_mode', 'channel_web_enabled', 'channel_app_enabled')`,
    );
    const flag = (key: string, dflt: boolean): boolean => {
      const r = rows.find((x) => x.key === key);
      return r ? r.value === true : dflt;
    };
    const maintenance = flag('maintenance_mode', false);
    const MAINTENANCE_MSG = 'The service is temporarily down for maintenance. Please check back soon.';
    const DISABLED_MSG = 'This channel is currently unavailable.';
    const channel = (enabledFlagKey: string): { enabled: boolean; message: string | null } => {
      if (maintenance) return { enabled: false, message: MAINTENANCE_MSG };
      const enabled = flag(enabledFlagKey, true);
      return { enabled, message: enabled ? null : DISABLED_MSG };
    };
    return {
      maintenance_mode: maintenance,
      channels: {
        web: channel('channel_web_enabled'),
        app: channel('channel_app_enabled'),
      },
    };
  });
}

export function registerHealthRoutes(app: FastifyInstance, db: DB) {
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_req, reply) => {
    try {
      await db.query('select 1');
      return { status: 'ready' };
    } catch {
      reply.code(503);
      return { status: 'not_ready' };
    }
  });
}
