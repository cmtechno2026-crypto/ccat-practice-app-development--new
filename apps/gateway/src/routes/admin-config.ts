import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';

// Grade catalog + global flags (Blueprint §28, §29, §30). Super-Admin domain.
const gradeSchema = z.object({
  registration_enabled: z.boolean().optional(),
  practice_enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  age_min_years: z.number().int().nullable().optional(),
  age_max_years: z.number().int().nullable().optional(),
});
const flagSchema = z.object({ key: z.string().min(1), value: z.boolean(), reason: z.string().optional() });

const FLAG_KEYS = ['registration_enabled', 'student_login_enabled', 'session_start_enabled',
  'device_replacement_enabled', 'content_publish_enabled', 'push_delivery_enabled', 'maintenance_mode',
  // Per-client channel enable flags (§ CONTROL). Turn the website / mobile-app channels on/off from
  // admin without a redeploy; clients read them via the public GET /v1/channel-status.
  'channel_web_enabled', 'channel_app_enabled'];

export function registerAdminConfigRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };

  app.get('/v1/admin/config/grades', guard, async () => {
    const rows = await db.query(`select id, grade_number, name, display_order, active, registration_enabled, practice_enabled,
        age_min_years, age_max_years, (select count(*) from ccat.students s where s.grade_id=g.id)::int student_count
        from ccat.grades g where retired_at is null order by display_order, grade_number`);
    return { items: rows.rows };
  });

  app.patch('/v1/admin/config/grades/:id', guard, async (req) => {
    requirePermission(req, 'grade.manage'); // named perm now enforced (owner decision 3-a)
    const id = (req.params as any).id;
    const b = gradeSchema.parse(req.body);
    const fields: string[] = []; const vals: any[] = [id]; let i = 2;
    for (const [k, v] of Object.entries(b)) { if (v !== undefined) { fields.push(`${k}=$${i++}`); vals.push(v); } }
    if (fields.length === 0) throw Errors.validation('No changes');
    const r = await db.query(`update ccat.grades set ${fields.join(',')} where id=$1 returning grade_number`, vals);
    if (r.rows.length === 0) throw Errors.notFound('Grade not found');
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,new_value)
        values ($1,'admin','config.published','config',$2,$3)`, [req.admin!.adminId, id, JSON.stringify(b)]);
    return { updated: true };
  });

  app.get('/v1/admin/config/flags', guard, async () => {
    const rows = await db.query('select key, value, updated_at from ccat.global_flags');
    const map = new Map(rows.rows.map(r => [r.key, r]));
    return { items: FLAG_KEYS.map(k => ({ key: k, value: map.get(k)?.value ?? true, updated_at: map.get(k)?.updated_at ?? null })) };
  });

  app.post('/v1/admin/config/flags', guard, async (req) => {
    requirePermission(req, 'flags.emergency');
    const b = flagSchema.parse(req.body);
    if (!FLAG_KEYS.includes(b.key)) throw Errors.validation('Unknown flag');
    const prev = await db.query('select value from ccat.global_flags where key=$1', [b.key]);
    await db.query(`insert into ccat.global_flags(key,value,updated_by,updated_at) values ($1,$2,$3,now())
        on conflict (key) do update set value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`,
      [b.key, b.value, req.admin!.adminId]);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value,reason)
        values ($1,'admin','flag.changed','flag',null,$2,$3,$4)`,
      [req.admin!.adminId, JSON.stringify({ key: b.key, value: prev.rows[0]?.value ?? null }), JSON.stringify({ key: b.key, value: b.value }), b.reason ?? null]);
    return { key: b.key, value: b.value };
  });
}
