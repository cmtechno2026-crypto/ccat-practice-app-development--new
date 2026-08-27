import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { verifySecret } from '../security/crypto.js';
import { signAdminToken } from '../security/token.js';
import { makeAuthenticateAdmin, loadAdminPermissions, requirePermission } from '../plugins/adminAuth.js';
import { deriveAgeYears } from '../lib/age.js';

// Audit event categories (mockup: Content / Student accounts / Economy / Governance). Each maps to
// a set of event_type prefixes; used for the category filter chips and the colored row grouping.
const AUDIT_CATEGORIES: Record<string, string[]> = {
  content: ['content.', 'book.'],
  student: ['student.', 'device.', 'deletion.', 'session.'],
  economy: ['economy.', 'reward.', 'achievement.', 'avatar.', 'theme.'],
  governance: ['admin.', 'config.', 'flag.', 'grade.', 'announcement.', 'push.', 'audit.', 'incident.'],
};
function categorize(eventType: string): string {
  for (const [cat, prefixes] of Object.entries(AUDIT_CATEGORIES)) {
    if (prefixes.some((p) => eventType.startsWith(p))) return cat;
  }
  return 'other';
}

const loginSchema = z.object({ email: z.string().email(), password: z.string(), mfa_code: z.string().optional() });
const statusSchema = z.object({
  to_status: z.enum(['active', 'suspended', 'banned']),
  reason_code: z.string().min(1),
  reason_text: z.string().optional(),
  reference: z.string().optional(),
});

// Maps a target status to the permission that authorizes it (Blueprint §23).
function permForStatus(to: string, from: string): string {
  if (to === 'suspended') return 'student.suspend';
  if (to === 'banned') return 'student.ban';
  if (to === 'active') return from === 'banned' ? 'student.unban' : 'student.unsuspend';
  return 'student.suspend';
}

export function registerAdminRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);

  // POST /v1/admin/auth/login — email/password (+ MFA). DEV uses admin_local_credentials;
  // production swaps this for Supabase Auth token verification (§22.1, §22.2).
  app.post('/v1/admin/auth/login', async (req) => {
    const body = loginSchema.parse(req.body);
    const { rows } = await db.query(
      `select p.id, p.security_role, p.status, p.mfa_enrolled, p.must_change_password,
              c.password_hash, c.failed_attempts, c.locked_until
         from ccat.admin_profiles p
         left join ccat.admin_local_credentials c on c.admin_id = p.id
        where p.email = $1`,
      [body.email],
    );
    if (rows.length === 0 || !rows[0]!.password_hash) throw Errors.unauthorized('Invalid credentials');
    const a = rows[0]!;
    if (a.status !== 'active') throw Errors.forbidden('ADMIN_DISABLED', 'Admin account is disabled');
    // Account lockout (§22): a run of failed logins locks the account until an admin unlocks it.
    if (a.locked_until && new Date(a.locked_until).getTime() > Date.now()) {
      throw Errors.forbidden('ADMIN_LOCKED', 'Account is locked. Ask an administrator to unlock it.');
    }
    const ok = await verifySecret(body.password, cfg.pinPepper, a.password_hash);
    if (!ok) {
      // Increment the failure counter; lock after 5 within the window.
      const LOCK_THRESHOLD = 5;
      const next = Number(a.failed_attempts ?? 0) + 1;
      if (next >= LOCK_THRESHOLD) {
        await db.query(`update ccat.admin_local_credentials set failed_attempts=$2, locked_until=now() + interval '15 minutes' where admin_id=$1`, [a.id, next]);
      } else {
        await db.query('update ccat.admin_local_credentials set failed_attempts=$2 where admin_id=$1', [a.id, next]);
      }
      throw Errors.unauthorized('Invalid credentials');
    }
    // Success clears the counters.
    if (Number(a.failed_attempts ?? 0) > 0 || a.locked_until) {
      await db.query('update ccat.admin_local_credentials set failed_attempts=0, locked_until=null where admin_id=$1', [a.id]);
    }
    // MFA: production verifies a TOTP here. In local/dev it is not enforced (documented).
    if (cfg.env !== 'local' && cfg.env !== 'development' && !a.mfa_enrolled) {
      throw Errors.forbidden('MFA_REQUIRED', 'MFA enrollment required');
    }
    const token = signAdminToken({ sub: a.id, exp: Math.floor(Date.now() / 1000) + cfg.accessTokenTtlSeconds }, cfg.hmacSecret);
    const permissions = await loadAdminPermissions(db, a.id, a.security_role);
    return {
      access_token: token,
      admin: { id: a.id, role: a.security_role, must_change_password: a.must_change_password, permissions: [...permissions] },
    };
  });

  // GET /v1/admin/me — current admin + permissions
  app.get('/v1/admin/me', { preHandler: [authenticateAdmin] }, async (req) => {
    const a = req.admin!;
    const p = await db.query('select email, display_name from ccat.admin_profiles where id=$1', [a.adminId]);
    return { id: a.adminId, role: a.role, email: p.rows[0]!.email, display_name: p.rows[0]!.display_name, permissions: [...a.permissions] };
  });

  // GET /v1/admin/students — directory: computed Age + raw guardian PII for authorized users (§24).
  // Server-side search / filter / sort / pagination so this scales to millions of accounts —
  // the client never downloads the full table. Rich per-row fields (readiness, progress, devices,
  // last-active) come from indexed lateral lookups against the latest snapshots.
  const SORTS: Record<string, string> = {
    last_active: 'la.last_active', xp: 's.cached_xp_total', readiness: 'r.readiness_pct',
    grade: 'g.grade_number', username: "s.username_normalized::text", created: 's.created_at',
  };
  const STATUSES = new Set(['active', 'suspended', 'banned', 'pending_deletion', 'purged']);
  const BANDS = new Set(['ready', 'building', 'needs_work']);
  app.get('/v1/admin/students', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'student.directory');
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    const offset = Math.max(Number(q.cursor ?? 0), 0);
    const sortCol = SORTS[q.sort ?? 'last_active'] ?? SORTS.last_active;
    const dir = (q.dir ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const status = q.status && STATUSES.has(q.status) ? q.status : null;
    const band = q.band && BANDS.has(q.band) ? q.band : null;
    const search = q.q && q.q.trim() ? `%${q.q.trim()}%` : null;

    const { rows } = await db.query(
      `select s.id, s.display_name, s.username_normalized::text as username, s.status, s.version,
              s.birth_month, s.birth_year, g.grade_number,
              gc.email as guardian_email, gc.phone as guardian_phone, gc.name as guardian_name,
              s.cached_xp_total, s.cached_coin_balance,
              r.readiness_pct, r.band as readiness_band, r.insufficient_data,
              p.completed_count as sets_completed, p.progress_pct,
              d.total_devices, d.active_devices, la.last_active,
              stk.current_streak, stk.longest_streak,
              count(*) over() as matched
         from ccat.students s
         join ccat.grades g on g.id = s.grade_id
         left join ccat.student_guardians sg on sg.student_id = s.id and sg.is_primary = true
         left join ccat.guardian_contacts gc on gc.id = sg.guardian_id
         left join lateral (select readiness_pct, band, insufficient_data from ccat.readiness_snapshots
              where student_id = s.id order by computed_at desc limit 1) r on true
         left join lateral (select completed_count, progress_pct from ccat.student_progress_snapshots
              where student_id = s.id order by computed_at desc limit 1) p on true
         left join lateral (select count(*) as total_devices,
              count(*) filter (where status='active') as active_devices
              from ccat.student_devices where student_id = s.id) d on true
         left join lateral (select max(started_at) as last_active from ccat.sessions
              where student_id = s.id) la on true
         left join lateral (select
              case when ss.last_active_day >= (now() at time zone s.timezone)::date - 1
                   then ss.current_streak else 0 end as current_streak,
              ss.longest_streak
              from ccat.student_streaks ss where ss.student_id = s.id) stk on true
        where s.is_preview = false   -- preview accounts never appear in the real student directory
          and ($1::ccat.student_status is null or s.status = $1::ccat.student_status)
          and ($2::text is null or r.band = $2)
          and ($3::text is null or s.username_normalized::text ilike $3
               or s.display_name ilike $3 or gc.email ilike $3 or coalesce(gc.phone,'') ilike $3)
        order by ${sortCol} ${dir} nulls last, s.created_at desc
        limit $4 offset $5`,
      [status, band, search, limit, offset],
    );
    const matched = rows.length ? Number(rows[0]!.matched) : 0;
    return {
      matched,
      items: rows.map((r) => {
        const total = Number(r.total_devices ?? 0), active = Number(r.active_devices ?? 0);
        const display_status = r.status === 'active' && total > 0 && active === 0 ? 'device_revoked' : r.status;
        return {
          id: r.id, display_name: r.display_name, username: r.username, status: r.status, display_status,
          version: r.version, grade_number: r.grade_number, age_years: deriveAgeYears(r.birth_month, r.birth_year),
          guardian_email: r.guardian_email, guardian_phone: r.guardian_phone, guardian_name: r.guardian_name ?? null,
          xp_total: Number(r.cached_xp_total), coins: Number(r.cached_coin_balance),
          readiness_pct: r.readiness_pct === null ? null : Number(r.readiness_pct),
          readiness_band: r.readiness_band ?? null, readiness_insufficient: r.insufficient_data ?? false,
          sets_completed: r.sets_completed === null ? null : Number(r.sets_completed),
          progress_pct: r.progress_pct === null ? null : Number(r.progress_pct),
          device_total: total, device_active: active, last_active: r.last_active,
          streak_current: r.current_streak == null ? 0 : Number(r.current_streak),
          streak_longest: r.longest_streak == null ? 0 : Number(r.longest_streak),
        };
      }),
      next_cursor: rows.length === limit ? String(offset + limit) : null,
    };
  });

  // GET /v1/admin/students/stats — directory KPI cards + filter-chip counts (§24). One cheap
  // aggregate; the directory shows these without paging the whole table.
  app.get('/v1/admin/students/stats', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'student.directory');
    const { rows } = await db.query(
      `select
         count(*) as total,
         count(*) filter (where status='active') as active,
         count(*) filter (where status='suspended') as suspended,
         count(*) filter (where status='banned') as banned,
         count(*) filter (where status='pending_deletion') as pending_deletion,
         (select count(distinct student_id) from ccat.sessions
            where started_at >= date_trunc('day', now())) as practised_today
       from ccat.students where status <> 'purged'`,
    );
    const r = rows[0]!;
    return {
      total: Number(r.total), active: Number(r.active), suspended: Number(r.suspended),
      banned: Number(r.banned), pending_deletion: Number(r.pending_deletion),
      practised_today: Number(r.practised_today),
    };
  });

  // POST /v1/admin/students/:id/status — suspend/unsuspend/ban/unban (§6, §22.4, §25)
  app.post('/v1/admin/students/:id/status', { preHandler: [authenticateAdmin] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = statusSchema.parse(req.body);
    const ifMatch = req.headers['if-match'] as string | undefined;

    const result = await withTransaction(db, async (client) => {
      const s = await client.query('select status, version from ccat.students where id=$1 for update', [id]);
      if (s.rows.length === 0) throw Errors.notFound('Student not found');
      const cur = s.rows[0]!;
      // Optimistic concurrency: expected version via If-Match (§22.4).
      if (ifMatch !== undefined && Number(ifMatch) !== cur.version) {
        throw Errors.conflict('VERSION_CONFLICT', 'Student was modified by someone else', {
          your_version: Number(ifMatch), current_version: cur.version, current: { status: cur.status },
        });
      }
      requirePermission(req, permForStatus(body.to_status, cur.status));
      if (cur.status === body.to_status) throw Errors.validation('Student already in that status');

      await client.query('update ccat.students set status=$2, version=version+1 where id=$1', [id, body.to_status]);
      await client.query(
        `insert into ccat.student_status_events(student_id, from_status, to_status, reason_code, reason_text, actor_admin_id, actor_kind, reference)
         values ($1,$2,$3,$4,$5,$6,'admin',$7)`,
        [id, cur.status, body.to_status, body.reason_code, body.reason_text ?? null, req.admin!.adminId, body.reference ?? null],
      );
      // Suspend/ban revoke active student app sessions (§6.2).
      if (body.to_status === 'suspended' || body.to_status === 'banned') {
        await client.query(`update ccat.auth_sessions set revoked_at=now(), revoked_reason=$2 where student_id=$1 and revoked_at is null`, [id, body.to_status]);
      }
      await client.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, old_value, new_value, reason, reference)
         values ($1,'admin','student.status.changed','student',$2,$3,$4,$5,$6)`,
        [req.admin!.adminId, id, JSON.stringify({ status: cur.status }), JSON.stringify({ status: body.to_status }), body.reason_code, body.reference ?? null],
      );
      return { status: body.to_status, version: cur.version + 1 };
    });
    reply.header('ETag', String(result.version));
    return { id, ...result };
  });

  // GET /v1/admin/audit — own scope by default; global requires audit.read.global (§25).
  // Filters (all optional, AND-combined): event (prefix, e.g. 'student.'), target_kind, actor,
  // q (free text over event_type/reason/reference), from/to (ISO dates). Keyset pagination via
  // `cursor` = the created_at of the last row seen (append-only, so stable ordering by created_at,id).
  app.get('/v1/admin/audit', { preHandler: [authenticateAdmin] }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const scope = q.scope === 'global' ? 'global' : 'self';
    if (scope === 'global') requirePermission(req, 'audit.read.global');
    const limit = Math.min(Number(q.limit ?? 50), 100);

    const where: string[] = []; const vals: any[] = []; let i = 1;
    if (scope === 'self') { where.push(`al.actor_admin_id = $${i++}`); vals.push(req.admin!.adminId); }
    if (q.event) { where.push(`al.event_type like $${i++}`); vals.push(q.event.replace(/[%_]/g, '\\$&') + '%'); }
    if (q.target_kind) { where.push(`al.target_kind = $${i++}`); vals.push(q.target_kind); }
    if (q.actor && scope === 'global') { where.push(`al.actor_admin_id = $${i++}`); vals.push(q.actor); }
    // Category groups a set of event prefixes (mockup: Content / Student accounts / Economy / Governance).
    if (q.category && AUDIT_CATEGORIES[q.category]) {
      const prefixes = AUDIT_CATEGORIES[q.category]!;
      where.push(`(${prefixes.map(() => `al.event_type like $${i++}`).join(' or ')})`);
      for (const p of prefixes) vals.push(p + '%');
    }
    if (q.q) { where.push(`(al.event_type ilike $${i} or coalesce(al.reason,'') ilike $${i} or coalesce(al.reference,'') ilike $${i})`); vals.push('%' + q.q + '%'); i++; }
    if (q.from) { where.push(`al.created_at >= $${i++}`); vals.push(q.from); }
    if (q.to) { where.push(`al.created_at <= $${i++}`); vals.push(q.to); }
    if (q.cursor) { where.push(`al.created_at < $${i++}`); vals.push(q.cursor); }
    const clause = where.length ? 'where ' + where.join(' and ') : '';
    vals.push(limit + 1); // fetch one extra to detect next page
    const rows = await db.query(
      `select al.id, al.actor_admin_id, al.actor_kind, al.event_type, al.target_kind, al.target_id,
              al.reason, al.reference, al.request_id, al.old_value, al.new_value, al.created_at,
              ap.display_name actor_name, ap.security_role actor_role
         from ccat.audit_log al
         left join ccat.admin_profiles ap on ap.id = al.actor_admin_id
         ${clause}
        order by al.created_at desc, al.id desc limit $${i}`, vals);
    const items = rows.rows.slice(0, limit).map((r: any) => ({ ...r, category: categorize(r.event_type) }));
    const next_cursor = rows.rows.length > limit ? items[items.length - 1]!.created_at : null;
    return { items, scope, next_cursor };
  });

  // Distinct event types + target kinds present in the caller's scope — populates the filter dropdowns.
  app.get('/v1/admin/audit/facets', { preHandler: [authenticateAdmin] }, async (req) => {
    const q = req.query as { scope?: string };
    const scope = q.scope === 'global' ? 'global' : 'self';
    if (scope === 'global') requirePermission(req, 'audit.read.global');
    const clause = scope === 'self' ? 'where actor_admin_id = $1' : '';
    const args = scope === 'self' ? [req.admin!.adminId] : [];
    const events = await db.query(`select distinct event_type from ccat.audit_log ${clause} order by event_type`, args);
    const kinds = await db.query(`select distinct target_kind from ccat.audit_log ${clause} ${clause ? 'and' : 'where'} target_kind is not null order by target_kind`, args);
    // Distinct actors present in scope (AUDIT-1 whose-activity drilldown). Global only — self scope is
    // a single actor. Uses the tombstone actor_name so deleted admins still label their past entries.
    let actors: { id: string; name: string }[] = [];
    if (scope === 'global') {
      const a = await db.query(`select al.actor_admin_id id, coalesce(ap.display_name, left(al.actor_admin_id::text,8)) name
        from ccat.audit_log al left join ccat.admin_profiles ap on ap.id=al.actor_admin_id
        where al.actor_admin_id is not null group by al.actor_admin_id, ap.display_name order by name`);
      actors = a.rows.map((r: any) => ({ id: r.id, name: r.name }));
    }
    return { event_types: events.rows.map((r: any) => r.event_type), target_kinds: kinds.rows.map((r: any) => r.target_kind), actors };
  });

  // GET /v1/admin/audit/export — server-enforced CSV export of the audit log (§25). The
  // audit.export.self permission is checked HERE, in the Gateway, not merely hidden in the UI: an
  // admin without it is refused even though the frontend would just omit the button. Global scope
  // additionally requires audit.read.global (same gate as the read endpoint). Mirrors the read
  // endpoint's filters/scope, and the export itself is audited (event_type 'audit.exported').
  app.get('/v1/admin/audit/export', { preHandler: [authenticateAdmin] }, async (req, reply) => {
    requirePermission(req, 'audit.export.self');
    const q = req.query as Record<string, string | undefined>;
    const scope = q.scope === 'global' ? 'global' : 'self';
    if (scope === 'global') requirePermission(req, 'audit.read.global');

    const where: string[] = []; const vals: any[] = []; let i = 1;
    if (scope === 'self') { where.push(`al.actor_admin_id = $${i++}`); vals.push(req.admin!.adminId); }
    if (q.event) { where.push(`al.event_type like $${i++}`); vals.push(q.event.replace(/[%_]/g, '\\$&') + '%'); }
    if (q.target_kind) { where.push(`al.target_kind = $${i++}`); vals.push(q.target_kind); }
    if (q.actor && scope === 'global') { where.push(`al.actor_admin_id = $${i++}`); vals.push(q.actor); }
    if (q.category && AUDIT_CATEGORIES[q.category]) {
      const prefixes = AUDIT_CATEGORIES[q.category]!;
      where.push(`(${prefixes.map(() => `al.event_type like $${i++}`).join(' or ')})`);
      for (const p of prefixes) vals.push(p + '%');
    }
    if (q.q) { where.push(`(al.event_type ilike $${i} or coalesce(al.reason,'') ilike $${i} or coalesce(al.reference,'') ilike $${i})`); vals.push('%' + q.q + '%'); i++; }
    if (q.from) { where.push(`al.created_at >= $${i++}`); vals.push(q.from); }
    if (q.to) { where.push(`al.created_at <= $${i++}`); vals.push(q.to); }
    const clause = where.length ? 'where ' + where.join(' and ') : '';
    // Bounded export (a UI download, not a bulk data pipe). Newest first, like the read view.
    const rows = await db.query(
      `select al.created_at, al.event_type, al.target_kind, al.target_id, al.reason, al.reference, al.request_id,
              ap.display_name actor_name, ap.security_role actor_role
         from ccat.audit_log al
         left join ccat.admin_profiles ap on ap.id = al.actor_admin_id
         ${clause}
        order by al.created_at desc, al.id desc limit 10000`, vals);

    const esc = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      const s = v instanceof Date ? v.toISOString() : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'created_at,actor,actor_role,event_type,category,target_kind,target_id,reason,reference,request_id';
    const lines = rows.rows.map((r: any) => [
      esc(r.created_at), esc(r.actor_name), esc(r.actor_role), esc(r.event_type), esc(categorize(r.event_type)),
      esc(r.target_kind), esc(r.target_id), esc(r.reason), esc(r.reference), esc(r.request_id),
    ].join(','));
    const csv = [header, ...lines].join('\r\n');

    // The export is itself an audited governance action (no PII in the audit row).
    await db.query(
      `insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,reason,request_id)
       values ($1,'admin','audit.exported','audit',null,$2,$3)`,
      [req.admin!.adminId, `scope=${scope}${q.category ? `;category=${q.category}` : ''}`, req.id ?? null],
    );

    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="audit-${scope}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return csv;
  });
}
