import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission, assertStudentVisible } from '../plugins/adminAuth.js';

// Admin Support console — MATH OLYMPIAD ONLY. The list shows STUDENTS (not just cases): staff can
// message any student, even one who never wrote in. Super-admins / non-teacher admins see every Math
// student; a TEACHER account sees only its assigned students. A case (ccat.support_cases, site='math')
// is created lazily on the first staff message; the thread lives in ccat.support_messages. Unread = the
// number of student messages since the last staff reply (the "needs a reply" badge).
const SITE = 'math';

function newReference(): string {
  return 'SUP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function registerAdminSupportRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };

  // A teacher account is limited to its assigned students; super-admins / non-teacher admins see all.
  const teacherScope = (req: any): string | null =>
    (req.admin?.isTeacher && req.admin?.role !== 'super_admin') ? req.admin.adminId : null;

  // ---- List Math students for the Support list (all, or a teacher's assigned), with thread summary ----
  app.get('/v1/admin/support/students', guard, async (req) => {
    requirePermission(req, 'student.directory');
    const teacherId = teacherScope(req);
    const rows = await db.query(
      `select st.id student_id, st.display_name student_name, st.username_normalized username,
              st.grade_id, g.grade_number,
              sc.id case_id, sc.state,
              lm.body last_message, lm.sender last_sender, lm.created_at last_message_at,
              coalesce(uc.unread, 0)::int unread
         from ccat.students st
         join ccat.grades g on g.id = st.grade_id
         left join lateral (
            select id, state from ccat.support_cases c
             where c.student_id = st.id and c.site_id = $1
             order by c.created_at desc limit 1) sc on true
         left join lateral (
            select body, sender, created_at from ccat.support_messages m
             where m.case_id = sc.id order by m.created_at desc limit 1) lm on true
         left join lateral (
            select count(*) unread from ccat.support_messages m
             where m.case_id = sc.id and m.sender = 'student'
               and m.created_at > coalesce(
                 (select max(created_at) from ccat.support_messages s2 where s2.case_id = sc.id and s2.sender = 'staff'),
                 'epoch'::timestamptz)) uc on true
        where st.site_id = $1 and st.is_preview = false and st.status <> 'purged'
          and ($2::uuid is null or st.id in (select ts.student_id from ccat.teacher_students ts where ts.teacher_admin_id = $2::uuid))
        order by (lm.created_at is null), lm.created_at desc nulls last, st.display_name asc
        limit 1000`,
      [SITE, teacherId],
    );
    return { items: rows.rows };
  });

  // ---- One student's thread (student info + their Math case, if any, + messages). No create on read ----
  app.get('/v1/admin/support/students/:studentId/thread', guard, async (req) => {
    requirePermission(req, 'student.directory');
    const studentId = (req.params as any).studentId;
    await assertStudentVisible(db, req, studentId);
    const sr = await db.query(
      `select st.id student_id, st.display_name student_name, st.username_normalized username,
              st.grade_id, g.grade_number, st.status student_status, st.site_id
         from ccat.students st join ccat.grades g on g.id = st.grade_id where st.id = $1`,
      [studentId],
    );
    if (sr.rows.length === 0 || sr.rows[0]!.site_id !== SITE) throw Errors.notFound('Student not found');
    const cr = await db.query(
      `select id case_id, state, reference, created_at from ccat.support_cases
        where student_id = $1 and site_id = $2 order by created_at desc limit 1`,
      [studentId, SITE],
    );
    const caseRow = cr.rows[0] ?? null;
    const messages = caseRow
      ? (await db.query(
          `select id, sender, body, created_at from ccat.support_messages where case_id = $1 order by created_at asc, id asc`,
          [caseRow.case_id],
        )).rows
      : [];
    const { site_id, ...student } = sr.rows[0]!;
    return { ...student, case_id: caseRow?.case_id ?? null, state: caseRow?.state ?? null, messages };
  });

  // ---- Staff message. Creates the student's Math case on first contact, then appends a 'staff' message ----
  const replySchema = z.object({ body: z.string().trim().min(1).max(4000) });
  app.post('/v1/admin/support/students/:studentId/messages', guard, async (req) => {
    requirePermission(req, 'student.directory');
    const studentId = (req.params as any).studentId;
    await assertStudentVisible(db, req, studentId);
    const b = replySchema.parse(req.body);
    const sr = await db.query('select id, site_id from ccat.students where id = $1', [studentId]);
    if (sr.rows.length === 0 || sr.rows[0]!.site_id !== SITE) throw Errors.notFound('Student not found');

    // get-or-create the student's Math support case
    let caseId: string;
    const existing = await db.query(
      `select id from ccat.support_cases where student_id = $1 and site_id = $2 order by created_at desc limit 1`,
      [studentId, SITE],
    );
    if (existing.rows.length > 0) {
      caseId = existing.rows[0]!.id;
      await db.query(`update ccat.support_cases set updated_at = now() where id = $1`, [caseId]);
    } else {
      const created = await db.query(
        `insert into ccat.support_cases (student_id, opened_by, reference, summary, state, site_id)
         values ($1, $2, $3, $4, 'open', $5) returning id`,
        [studentId, req.admin!.adminId, newReference(), 'Staff-initiated conversation', SITE],
      );
      caseId = created.rows[0]!.id;
    }
    const m = await db.query(
      `insert into ccat.support_messages (case_id, sender, body) values ($1, 'staff', $2)
       returning id, sender, body, created_at`,
      [caseId, b.body],
    );
    await db.query(
      `insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,request_id)
       values ($1,'admin','support.replied','support_case',$2,$3)`,
      [req.admin!.adminId, caseId, req.id ?? null],
    );
    return { case_id: caseId, message: m.rows[0] };
  });

  // ---- Change the student's case state (open/closed). 'resolved' maps to 'closed'. Optional surface ----
  const stateSchema = z.object({ state: z.enum(['open', 'closed', 'resolved']) });
  app.post('/v1/admin/support/students/:studentId/state', guard, async (req) => {
    requirePermission(req, 'student.directory');
    const studentId = (req.params as any).studentId;
    await assertStudentVisible(db, req, studentId);
    const b = stateSchema.parse(req.body);
    const next = b.state === 'resolved' ? 'closed' : b.state;
    const r = await db.query(
      `update ccat.support_cases set state = $2, updated_at = now()
        where id = (select id from ccat.support_cases where student_id = $1 and site_id = $3 order by created_at desc limit 1)
        returning state`,
      [studentId, next, SITE],
    );
    if (r.rows.length === 0) throw Errors.notFound('No support case for this student');
    return { state: next };
  });
}
