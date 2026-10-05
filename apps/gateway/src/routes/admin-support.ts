import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';

// Admin Support console (Math workspace + CCAT). Student-facing "Report a problem" cases land in
// ccat.support_cases (support.ts). This surface lets staff READ open cases and REPLY via the
// case-threaded ccat.support_messages table (sender 'student' | 'staff'). Cases are scoped to the
// admin's ACTIVE SITE (X-Admin-Site) so the Math workspace sees only Math cases and CCAT sees CCAT.
// Gated on existing permissions: student.directory (view), student.update (reply / change state).
// support_cases.state CHECK = ('open','closed'); the UI label "Resolved" maps to 'closed'.
export function registerAdminSupportRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };

  const site = (req: any): string => (String(req.headers['x-admin-site'] || '').toLowerCase() === 'math' ? 'math' : 'ccat');

  // List cases for the active site, newest first, with student + latest-message preview + unread count.
  app.get('/v1/admin/support/cases', guard, async (req) => {
    requirePermission(req, 'student.directory');
    const q = req.query as { state?: string };
    const state = q.state === 'open' || q.state === 'closed' ? q.state : null; // null => all
    const rows = await db.query(
      `select sc.id, sc.reference, sc.summary, sc.state, sc.created_at, sc.updated_at,
              sc.student_id, st.display_name student_name, st.grade_id,
              g.grade_number,
              (select body from ccat.support_messages m where m.case_id = sc.id
                order by m.created_at desc limit 1) last_message,
              (select created_at from ccat.support_messages m where m.case_id = sc.id
                order by m.created_at desc limit 1) last_message_at,
              (select count(*) from ccat.support_messages m where m.case_id = sc.id)::int message_count
         from ccat.support_cases sc
         left join ccat.students st on st.id = sc.student_id
         left join ccat.grades g on g.id = st.grade_id
        where sc.site_id = $1
          and ($2::text is null or sc.state = $2)
        order by coalesce((select max(created_at) from ccat.support_messages m where m.case_id = sc.id), sc.created_at) desc
        limit 500`,
      [site(req), state],
    );
    return { items: rows.rows };
  });

  // Case detail + full message thread (oldest first). 404 if the case belongs to another site.
  app.get('/v1/admin/support/cases/:id', guard, async (req) => {
    requirePermission(req, 'student.directory');
    const id = (req.params as any).id;
    const cr = await db.query(
      `select sc.id, sc.reference, sc.summary, sc.state, sc.created_at, sc.updated_at, sc.site_id,
              sc.student_id, st.display_name student_name, st.username_normalized, st.grade_id, g.grade_number, st.status student_status
         from ccat.support_cases sc
         left join ccat.students st on st.id = sc.student_id
         left join ccat.grades g on g.id = st.grade_id
        where sc.id = $1 and sc.site_id = $2`,
      [id, site(req)],
    );
    if (cr.rows.length === 0) throw Errors.notFound('Support case not found');
    const msgs = await db.query(
      `select id, sender, body, created_at from ccat.support_messages
        where case_id = $1 order by created_at asc, id asc`,
      [id],
    );
    return { ...cr.rows[0], messages: msgs.rows };
  });

  // Staff reply — appends a 'staff' message and bumps the case updated_at. Reopens a closed case.
  const replySchema = z.object({ body: z.string().trim().min(1).max(4000) });
  app.post('/v1/admin/support/cases/:id/messages', guard, async (req) => {
    requirePermission(req, 'student.update');
    const id = (req.params as any).id;
    const b = replySchema.parse(req.body);
    const owner = await db.query('select id from ccat.support_cases where id=$1 and site_id=$2', [id, site(req)]);
    if (owner.rows.length === 0) throw Errors.notFound('Support case not found');
    const m = await db.query(
      `insert into ccat.support_messages (case_id, sender, body) values ($1, 'staff', $2)
       returning id, sender, body, created_at`,
      [id, b.body],
    );
    await db.query(`update ccat.support_cases set updated_at = now() where id=$1`, [id]);
    await db.query(
      `insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,request_id)
       values ($1,'admin','support.replied','support_case',$2,$3)`,
      [req.admin!.adminId, id, req.id ?? null],
    );
    return m.rows[0];
  });

  // Change case state. 'resolved' from the UI maps to 'closed' (the table's CHECK value).
  const stateSchema = z.object({ state: z.enum(['open', 'closed', 'resolved']) });
  app.post('/v1/admin/support/cases/:id/state', guard, async (req) => {
    requirePermission(req, 'student.update');
    const id = (req.params as any).id;
    const b = stateSchema.parse(req.body);
    const next = b.state === 'resolved' ? 'closed' : b.state;
    const r = await db.query(
      `update ccat.support_cases set state=$2, updated_at=now() where id=$1 and site_id=$3 returning state`,
      [id, next, site(req)],
    );
    if (r.rows.length === 0) throw Errors.notFound('Support case not found');
    await db.query(
      `insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,new_value,request_id)
       values ($1,'admin','support.state_changed','support_case',$2,$3,$4)`,
      [req.admin!.adminId, id, JSON.stringify({ state: next }), req.id ?? null],
    );
    return { state: next };
  });
}
