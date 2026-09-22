import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors, AppError } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission, requireSuperAdmin } from '../plugins/adminAuth.js';
import { hashSecret, generateOtp, verifySecret } from '../security/crypto.js';
import { sendEmail, emailConfigured } from '../lib/email.js';
import { PERMISSION_BUNDLES } from '../lib/permissionBundles.js';

// Server-side strength gate for a Super-Admin-SUPPLIED admin password (a generated one is always strong).
// Placeholder/common values to reject outright; the length + email checks live in passwordProblem().
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd!', 'changeme', 'change-me',
  'letmein123', '1234567890', '123456789', '12345678', 'qwertyuiop', 'admin12345', 'welcome123',
  'iloveyou12', 'conceptmastery', 'concept@admin',
]);
function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (WEAK_PASSWORDS.has(pw.toLowerCase())) return 'That password is too common — choose a stronger one.';
  if (pw.trim().toLowerCase() === String(email).trim().toLowerCase()) return 'Password must not be the same as the account email.';
  return null;
}
const resetPasswordSchema = z.object({
  new_password: z.string().optional(),
  require_change: z.boolean().optional(),
});

// Admin lifecycle & permissions (Blueprint §22, §23, §28.1, §28.2). Super-Admin domain.
const createSchema = z.object({
  email: z.string().email(), display_name: z.string().min(1),
  role: z.enum(['admin', 'super_admin']).default('admin'),
  permissions: z.array(z.string()).optional(),
  temp_password: z.string().min(10).optional(),        // admin may set it, else one is generated
  recovery_channel: z.enum(['email', 'phone']).optional(), // used only when the account locks (§22.2)
});
const patchSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  role: z.enum(['admin', 'super_admin']).optional(),
  permissions: z.array(z.string()).optional(),
});

export function registerAdminAccountsRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };

  // ---- Self-service admin password reset via email OTP (PUBLIC — the admin is locked out, so no auth) --
  // Mirrors the student PIN-recovery flow: UNIFORM response that never reveals whether the email is an
  // admin, a hashed single-use code with a short TTL, rate-limited, and FAIL-CLOSED when email isn't
  // configured (never claim a code was sent when it wasn't). Requires EMAIL_* to be configured to work.
  const startResetSchema = z.object({ email: z.string().email() });
  const completeResetSchema = z.object({ email: z.string().email(), code: z.string().min(4).max(10), new_password: z.string().min(1) });
  const resetMax = cfg.env === 'production' ? 5 : 500;

  app.post('/v1/admin/password/reset/start', { config: { rateLimit: { max: resetMax, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { email } = startResetSchema.parse(req.body ?? {});
    const em = email.trim().toLowerCase();
    if (cfg.env !== 'local' && !emailConfigured(cfg)) throw Errors.emailUnavailable();
    const rows = await db.query(`select id, display_name from ccat.admin_profiles where lower(email)=$1 and status='active'`, [em]);
    const admin = rows.rows[0];
    if (admin) {
      const code = generateOtp();
      const codeHash = await hashSecret(code, cfg.pinPepper);
      const expires = new Date(Date.now() + cfg.otpTtlSeconds * 1000);
      const mins = Math.round(cfg.otpTtlSeconds / 60);
      await db.query('update ccat.admin_password_resets set consumed_at=now() where admin_id=$1 and consumed_at is null', [admin.id]);
      await db.query('insert into ccat.admin_password_resets(admin_id, code_hash, expires_at) values ($1,$2,$3)', [admin.id, codeHash, expires]);
      const html = `<div style="font-family:Arial,sans-serif;color:#1a1a1a">
        <h2 style="color:#1A5EAB">Reset your Concept Mastery admin password</h2>
        <p>Hi ${admin.display_name}, use this one-time code to reset your admin password:</p>
        <div style="font-size:26px;font-weight:800;letter-spacing:6px;background:#0f1b2d;color:#fff;display:inline-block;padding:12px 20px;border-radius:10px;margin:8px 0">${code}</div>
        <p>This code expires in ${mins} minutes. If you didn't request this, ignore this email — your password stays unchanged.</p>
        <p style="color:#8a90a6;font-size:13px">— Concept Mastery · Admin</p></div>`;
      const sent = await sendEmail(cfg, { to: em, subject: 'Reset your Concept Mastery admin password', html }, req.log);
      if (!sent) throw Errors.emailUnavailable();
    }
    reply.code(202);
    return { ok: true }; // uniform — never reveals whether the email belongs to an admin
  });

  app.post('/v1/admin/password/reset/complete', { config: { rateLimit: { max: resetMax, timeWindow: '15 minutes' } } }, async (req) => {
    const b = completeResetSchema.parse(req.body ?? {});
    const em = b.email.trim().toLowerCase();
    const invalid = () => Errors.unauthorized('Invalid or expired code');
    const pwProblem = passwordProblem(b.new_password, em);
    if (pwProblem) throw Errors.validation(pwProblem);

    const rows = await db.query(
      `select r.id, r.admin_id, r.code_hash, r.attempts, r.max_attempts, r.expires_at
         from ccat.admin_password_resets r
         join ccat.admin_profiles p on p.id = r.admin_id and p.status='active'
        where lower(p.email)=$1 and r.consumed_at is null
        order by r.created_at desc`,
      [em]);
    let match: { id: string; admin_id: string } | null = null;
    for (const c of rows.rows) {
      if (new Date(c.expires_at) < new Date()) continue;
      if (c.attempts >= c.max_attempts) continue;
      if (await verifySecret(b.code, cfg.pinPepper, c.code_hash)) { match = { id: c.id, admin_id: c.admin_id }; break; }
    }
    if (!match) {
      await db.query(`update ccat.admin_password_resets set attempts=attempts+1 where consumed_at is null and admin_id in (select id from ccat.admin_profiles where lower(email)=$1)`, [em]);
      throw invalid();
    }
    const hash = await hashSecret(b.new_password, cfg.pinPepper);
    await withTransaction(db, async (c) => {
      await c.query('update ccat.admin_password_resets set consumed_at=now() where id=$1', [match!.id]);
      await c.query(`insert into ccat.admin_local_credentials(admin_id,password_hash,failed_attempts,locked_until) values ($1,$2,0,null)
                     on conflict (admin_id) do update set password_hash=excluded.password_hash, failed_attempts=0, locked_until=null`, [match!.admin_id, hash]);
      await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','admin.password.self_reset','admin',$1)`, [match!.admin_id]);
    });
    return { ok: true };
  });

  app.get('/v1/admin/permissions', guard, async () => {
    const rows = await db.query('select key, description, super_admin_only from ccat.permissions order by key');
    return { items: rows.rows };
  });

  // Permission bundles — named presets over the catalog (§23). Convenience only; grants are still
  // per-permission. Filtered to bundle permissions that actually exist in this catalog.
  app.get('/v1/admin/permissions/bundles', guard, async () => {
    const cat = await db.query('select key from ccat.permissions where super_admin_only=false');
    const valid = new Set(cat.rows.map((r: any) => r.key));
    return { bundles: PERMISSION_BUNDLES.map((b) => ({ ...b, permissions: b.permissions.filter((p) => valid.has(p)) })) };
  });

  app.get('/v1/admin/accounts', guard, async (req) => {
    requirePermission(req, 'admin.manage');
    const rows = await db.query(`select p.id, p.email, p.display_name, p.security_role, p.status, p.mfa_enrolled, p.must_change_password, p.created_at,
        (c.locked_until is not null and c.locked_until > now()) as locked,
        coalesce(array_agg(ap.permission_key) filter (where ap.permission_key is not null), '{}') permissions
        from ccat.admin_profiles p
        left join ccat.admin_permissions ap on ap.admin_id=p.id
        left join ccat.admin_local_credentials c on c.admin_id=p.id
        where p.status <> 'deleted'
        group by p.id, c.locked_until order by p.created_at`);
    return { items: rows.rows };
  });

  // Unlock a locked admin: clear the brute-force counters and issue a fresh permanent password.
  app.post('/v1/admin/accounts/:id/unlock', guard, async (req) => {
    requireSuperAdmin(req);
    const id = (req.params as any).id;
    const tempPassword = randomBytes(9).toString('base64url');
    const hash = await hashSecret(tempPassword, cfg.pinPepper);
    const done = await withTransaction(db, async (c) => {
      const cur = await c.query('select 1 from ccat.admin_profiles where id=$1', [id]);
      if (cur.rows.length === 0) throw Errors.notFound('Admin not found');
      await c.query('update ccat.admin_local_credentials set failed_attempts=0, locked_until=null, password_hash=$2 where admin_id=$1', [id, hash]);
      await c.query('update ccat.admin_profiles set must_change_password=false where id=$1', [id]);
      await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','admin.unlocked','admin',$2)`, [req.admin!.adminId, id]);
      return true;
    });
    return { unlocked: done, temp_password: tempPassword, note: 'Account unlocked. New permanent password shown once — the admin signs in with it.' };
  });

  app.post('/v1/admin/accounts', guard, async (req) => {
    requireSuperAdmin(req); // only a Super-Admin may create an admin and set its password
    const b = createSchema.parse(req.body);
    // The Super-Admin sets the password (or one is generated). It is PERMANENT — shown once here, and
    // the new admin signs in with it (no forced first-login change; see must_change_password=false).
    const tempPassword = b.temp_password ?? randomBytes(9).toString('base64url');
    const generated = !b.temp_password;
    const hash = await hashSecret(tempPassword, cfg.pinPepper);
    const id = await withTransaction(db, async (c) => {
      const dupe = await c.query('select 1 from ccat.admin_profiles where email=$1', [b.email]);
      if (dupe.rows.length > 0) throw Errors.conflict('EMAIL_TAKEN', 'An admin with that email exists');
      const p = await c.query(`insert into ccat.admin_profiles(id,email,display_name,security_role,status,mfa_enrolled,must_change_password,created_by)
          values (gen_random_uuid(),$1,$2,$3,'active',true,false,$4) returning id`,
        [b.email, b.display_name, b.role, req.admin!.adminId]);
      const pid = p.rows[0]!.id;
      await c.query('insert into ccat.admin_local_credentials(admin_id,password_hash) values ($1,$2)', [pid, hash]);
      for (const key of b.permissions ?? []) {
        await c.query('insert into ccat.admin_permissions(admin_id,permission_key,granted_by) values ($1,$2,$3) on conflict do nothing', [pid, key, req.admin!.adminId]);
      }
      // Record the granted set + recovery channel in the audit diff (truthful: it is logged, not just claimed).
      await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,new_value) values ($1,'admin','admin.created','admin',$2,$3)`,
        [req.admin!.adminId, pid, JSON.stringify({ role: b.role, permissions: b.permissions ?? [], recovery_channel: b.recovery_channel ?? 'email', password: generated ? 'generated' : 'set-by-admin' })]);
      return pid;
    });
    return { id, temp_password: tempPassword, generated, note: 'Password — shown once. This is the admin\'s permanent password; they sign in with it (no first-login change, no MFA).' };
  });

  app.patch('/v1/admin/accounts/:id', guard, async (req) => {
    requirePermission(req, 'admin.manage');
    const id = (req.params as any).id;
    const b = patchSchema.parse(req.body);
    await withTransaction(db, async (c) => {
      const cur = await c.query('select security_role, status from ccat.admin_profiles where id=$1 for update', [id]);
      if (cur.rows.length === 0) throw Errors.notFound('Admin not found');
      const isSuper = cur.rows[0]!.security_role === 'super_admin' && cur.rows[0]!.status === 'active';
      const losingSuper = isSuper && ((b.status && b.status !== 'active') || (b.role && b.role !== 'super_admin'));
      if (losingSuper) {
        const others = await c.query(`select count(*)::int n from ccat.admin_profiles where security_role='super_admin' and status='active' and id<>$1`, [id]);
        if (others.rows[0]!.n < 1) throw Errors.conflict('LAST_SUPER_ADMIN', 'Cannot remove the last active Super-Admin (§28.2)');
      }
      if (b.status !== undefined) {
        await c.query('update ccat.admin_profiles set status=$2 where id=$1', [id, b.status]);
        if (b.status === 'disabled') await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','admin.disabled','admin',$2)`, [req.admin!.adminId, id]);
      }
      if (b.role !== undefined) {
        await c.query('update ccat.admin_profiles set security_role=$2 where id=$1', [id, b.role]);
        await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,new_value) values ($1,'admin','admin.role.changed','admin',$2,$3)`, [req.admin!.adminId, id, JSON.stringify({ role: b.role })]);
      }
      if (b.permissions !== undefined) {
        await c.query('delete from ccat.admin_permissions where admin_id=$1', [id]);
        for (const key of b.permissions) await c.query('insert into ccat.admin_permissions(admin_id,permission_key,granted_by) values ($1,$2,$3) on conflict do nothing', [id, key, req.admin!.adminId]);
        await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,new_value) values ($1,'admin','admin.permissions.changed','admin',$2,$3)`, [req.admin!.adminId, id, JSON.stringify({ permissions: b.permissions })]);
      }
    });
    return { updated: true };
  });

  // Delete an admin (§22, §28.2) — ADMIN-2. A true hard-DELETE is impossible: audit_log and the
  // append-only ledgers reference admin_profiles as actor and carry tg_forbid_mutation, so the
  // ON DELETE sweep is rejected. Erasure is therefore anonymize + TOMBSTONE: keep the row (every FK
  // and the audit trail stay intact), scrub PII, set status='deleted', drop credentials + grants.
  // Guards: cannot delete yourself, and cannot delete an admin who is still an ACTIVE Super-Admin
  // (demote or disable first — this also protects the last-Super-Admin invariant §28.2).
  app.delete('/v1/admin/accounts/:id', guard, async (req) => {
    requirePermission(req, 'admin.manage');
    const id = (req.params as any).id;
    if (id === req.admin!.adminId) throw Errors.conflict('SELF_DELETE', 'You cannot delete your own admin account');
    const b = z.object({ reference: z.string().optional() }).parse(req.body ?? {});
    await withTransaction(db, async (c) => {
      const cur = await c.query('select security_role, status, email from ccat.admin_profiles where id=$1 for update', [id]);
      if (cur.rows.length === 0) throw Errors.notFound('Admin not found');
      if (cur.rows[0]!.status === 'deleted') throw Errors.validation('Admin is already deleted');
      if (cur.rows[0]!.security_role === 'super_admin' && cur.rows[0]!.status === 'active')
        throw Errors.conflict('ACTIVE_SUPER_ADMIN', 'Disable or demote this Super-Admin before deletion (§28.2)');

      // Anonymize + tombstone. Email tombstone stays unique (id-derived); the row itself is retained.
      await c.query(`update ccat.admin_profiles set
          email=('deleted+'||id||'@invalid.local')::citext,
          display_name='Deleted admin',
          status='deleted', disabled_at=now(), disabled_reason='account_deleted',
          mfa_enrolled=false, must_change_password=false, version=version+1
        where id=$1`, [id]);
      // Drop all authentication material and access grants (mutable tables, no append-only trigger).
      await c.query('delete from ccat.admin_local_credentials where admin_id=$1', [id]);
      await c.query('delete from ccat.admin_permissions where admin_id=$1', [id]);
      await c.query('delete from ccat.admin_profile_bundles where admin_id=$1', [id]);
      // Audit — actor_admin_id (this deleted admin, as target) and its historical rows are untouched.
      await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value,reference)
          values ($1,'admin','admin.deleted','admin',$2,'{"status":"active_or_disabled"}'::jsonb,'{"status":"deleted"}'::jsonb,$3)`, [req.admin!.adminId, id, b.reference ?? null]);
    });
    return { deleted: true, status: 'deleted' };
  });

  // Reset ANY admin's password (Super-Admin only; no old password required — authorized reset). Two modes:
  //   • SET   — body.new_password supplied → validated server-side, hashed, stored; must_change_password =
  //             (require_change ?? false). Returns { mode:'set' } — never echoes the password.
  //   • GENERATE — no body.new_password → a strong password is generated, stored, must_change_password=true,
  //             and returned ONCE as { mode:'generated', password }.
  // Either mode clears the lockout counters and audits 'admin.password.reset' with the mode. Admin auth is
  // stateless (short-lived HMAC tokens) so there is no server session to revoke; the old password stops
  // working immediately and any live token expires shortly. The plaintext is never logged.
  app.post('/v1/admin/accounts/:id/reset-password', guard, async (req) => {
    requireSuperAdmin(req);
    const id = (req.params as any).id;
    const b = resetPasswordSchema.parse(req.body ?? {});
    const acct = await db.query('select email::text as email from ccat.admin_profiles where id=$1', [id]);
    if (acct.rows.length === 0) throw Errors.notFound('Admin not found');
    const email = acct.rows[0]!.email as string;

    const setMode = typeof b.new_password === 'string';
    let password: string;
    let mustChange: boolean;
    if (setMode) {
      const problem = passwordProblem(b.new_password!, email);
      if (problem) throw new AppError(400, 'WEAK_PASSWORD', problem);
      password = b.new_password!;
      mustChange = b.require_change ?? false;
    } else {
      password = randomBytes(9).toString('base64url');
      mustChange = true;
    }
    const hash = await hashSecret(password, cfg.pinPepper);
    await withTransaction(db, async (c) => {
      await c.query(`insert into ccat.admin_local_credentials(admin_id,password_hash,failed_attempts,locked_until) values ($1,$2,0,null)
          on conflict (admin_id) do update set password_hash=excluded.password_hash, failed_attempts=0, locked_until=null`, [id, hash]);
      await c.query('update ccat.admin_profiles set must_change_password=$2 where id=$1', [id, mustChange]);
      await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,new_value) values ($1,'admin','admin.password.reset','admin',$2,$3)`,
        [req.admin!.adminId, id, JSON.stringify({ mode: setMode ? 'set' : 'generated', require_change: mustChange })]);
    });
    return setMode ? { mode: 'set' as const } : { mode: 'generated' as const, password };
  });
}
