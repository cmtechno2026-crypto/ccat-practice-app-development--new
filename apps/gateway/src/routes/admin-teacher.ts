import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { makeAuthenticateAdmin, requirePermission, requireSite } from '../plugins/adminAuth.js';
import { AppError } from '../errors.js';

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
}
