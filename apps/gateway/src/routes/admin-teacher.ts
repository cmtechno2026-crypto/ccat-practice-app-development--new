import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { z } from 'zod';
import { makeAuthenticateAdmin, requirePermission, requireSite } from '../plugins/adminAuth.js';
import { AppError, Errors } from '../errors.js';

// Teacher Hub (TeachTime) admin surface. This site's data lives in a SEPARATE Supabase project
// ("cm-whiteboard", public.ta_* tables), reached through a dedicated read pool (`teacherDb`, from
// TEACHER_DATABASE_URL). Every route is gated by requirePermission('teacher.*') AND
// requireSite('teacher'); super_admin bypasses both. When the pool is not configured the routes
// answer 503 rather than crash, so the gateway is safe to deploy before the env var is set.
export function registerAdminTeacherRoutes(app: FastifyInstance, db: DB, cfg: Config, teacherDb: DB | null) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  function tdb(): DB {
    if (!teacherDb) throw new AppError(503, 'SITE_NOT_CONFIGURED', 'Teacher Hub database is not configured (set TEACHER_DATABASE_URL).');
    return teacherDb;
  }

  // Dashboard KPIs for the Teacher Hub site.
  app.get('/v1/admin/teacher/summary', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const { rows } = await tdb().query(
      `select
         (select count(*)::int from public.ta_teachers)                          as teachers,
         (select count(*)::int from public.ta_slots)                             as published_slots,
         (select count(*)::int from public.ta_slots where status = 'open')       as open_slots,
         (select count(*)::int from public.ta_slots where status = 'booked')     as booked_slots`);
    return rows[0]!;
  });

  // Teacher directory. Never selects the password hash. Slot counts via lateral-free subselects.
  app.get('/v1/admin/teacher/teachers', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const q = req.query as { search?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 200);
    const search = (q.search ?? '').trim();
    const params: any[] = [];
    let where = '';
    if (search) { params.push('%' + search.toLowerCase() + '%'); where = 'where lower(t.name) like $1 or lower(t.email) like $1'; }
    params.push(limit);
    const { rows } = await tdb().query(
      `select t.id, t.name, t.email, t.subjects, t.created_at,
              (select count(*)::int from public.ta_slots s where s.teacher_id = t.id)                          as slots,
              (select count(*)::int from public.ta_slots s where s.teacher_id = t.id and s.status = 'open')    as open_slots
         from public.ta_teachers t
         ${where}
         order by t.name
         limit $${params.length}`,
      params);
    return { teachers: rows };
  });

  // Slots for one teacher (teacher_id) or all teachers. Ordered by teacher, then weekday, then start
  // time so the admin UI can group them under each teacher.
  app.get('/v1/admin/teacher/slots', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const q = req.query as { teacher_id?: string };
    const teacherId = (q.teacher_id ?? '').trim();
    const params: any[] = [];
    let where = '';
    if (teacherId) { params.push(teacherId); where = 'where s.teacher_id = $1'; }
    const { rows } = await tdb().query(
      `select s.id, s.teacher_id, s.teacher_name, s.subject, s.grade, s.day_of_week,
              s.start_time, s.end_time, s.mode, s.status, s.timezone, s.notes
         from public.ta_slots s
         ${where}
         order by s.teacher_name,
                  case s.day_of_week
                    when 'Monday' then 1 when 'Tuesday' then 2 when 'Wednesday' then 3
                    when 'Thursday' then 4 when 'Friday' then 5 when 'Saturday' then 6
                    when 'Sunday' then 7 else 8 end,
                  s.start_time`,
      params);
    return { slots: rows };
  });

  // Book / unbook a slot from the admin. Writes status to the Teacher Hub DB (public.ta_slots), so the
  // change is immediately visible in the teacher app (same table). Gated by teacher.slots.manage +
  // requireSite('teacher'). The change is recorded in the CCAT audit log (best-effort).
  const slotStatusSchema = z.object({ status: z.enum(['open', 'booked']) });
  app.patch('/v1/admin/teacher/slots/:id', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const id = (req.params as { id: string }).id;
    const b = slotStatusSchema.parse(req.body ?? {});
    const { rows } = await tdb().query(
      `update public.ta_slots set status = $2, updated_at = now()
        where id = $1
        returning id, teacher_id, teacher_name, subject, grade, day_of_week, start_time, end_time, mode, status, timezone`,
      [id, b.status]);
    if (rows.length === 0) throw Errors.notFound('Slot not found');
    // Governance: record the admin action in the CCAT audit log. Best-effort — a logging failure must
    // not fail the booking.
    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1, 'admin', 'teacher.slot.status', 'ta_slot', $2, $3)`,
        [req.admin!.adminId, id, JSON.stringify({ status: b.status, teacher: rows[0]!.teacher_name })]);
    } catch { /* audit is best-effort */ }
    return rows[0];
  });
}
