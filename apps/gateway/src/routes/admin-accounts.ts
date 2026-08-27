import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';
import { hashSecret } from '../security/crypto.js';
import { PERMISSION_BUNDLES } from '../lib/permissionBundles.js';

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

  // Unlock a locked admin: clear the brute-force counters and issue a fresh one-time password.
  app.post('/v1/admin/accounts/:id/unlock', guard, async (req) => {
    requirePermission(req, 'admin.manage');
    const id = (req.params as any).id;
    const tempPassword = randomBytes(9).toString('base64url');
    const hash = await hashSecret(tempPassword, cfg.pinPepper);
    const done = await withTransaction(db, async (c) => {
      const cur = await c.query('select 1 from ccat.admin_profiles where id=$1', [id]);
      if (cur.rows.length === 0) throw Errors.notFound('Admin not found');
      await c.query('update ccat.admin_local_credentials set failed_attempts=0, locked_until=null, password_hash=$2 where admin_id=$1', [id, hash]);
      await c.query('update ccat.admin_profiles set must_change_password=true where id=$1', [id]);
      await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','admin.unlocked','admin',$2)`, [req.admin!.adminId, id]);
      return true;
    });
    return { unlocked: done, temp_password: tempPassword, note: 'Account unlocked. Temporary password shown once — the admin must change it on next login.' };
  });

  app.post('/v1/admin/accounts', guard, async (req) => {
    requirePermission(req, 'admin.manage');
    const b = createSchema.parse(req.body);
    // The admin may set the temporary password, or one is generated. Shown once either way (§22.2).
    const tempPassword = b.temp_password ?? randomBytes(9).toString('base64url');
    const generated = !b.temp_password;
    const hash = await hashSecret(tempPassword, cfg.pinPepper);
    const id = await withTransaction(db, async (c) => {
      const dupe = await c.query('select 1 from ccat.admin_profiles where email=$1', [b.email]);
      if (dupe.rows.length > 0) throw Errors.conflict('EMAIL_TAKEN', 'An admin with that email exists');
      const p = await c.query(`insert into ccat.admin_profiles(id,email,display_name,security_role,status,mfa_enrolled,must_change_password,created_by)
          values (gen_random_uuid(),$1,$2,$3,'active',false,true,$4) returning id`,
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
    return { id, temp_password: tempPassword, generated, note: 'Temporary password — shown once. The admin must change it and enrol MFA on first login.' };
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

  // Reset an admin's password → issue a new one-time temporary password, force change + MFA re-check
  // on next login (§22.2). Admin auth is stateless (short-lived HMAC tokens), so there is no server
  // session to revoke here; the old password simply stops working.
  app.post('/v1/admin/accounts/:id/reset-password', guard, async (req) => {
    requirePermission(req, 'admin.manage');
    const id = (req.params as any).id;
    const exists = await db.query('select 1 from ccat.admin_profiles where id=$1', [id]);
    if (exists.rows.length === 0) throw Errors.notFound('Admin not found');
    const tempPassword = randomBytes(9).toString('base64url');
    const hash = await hashSecret(tempPassword, cfg.pinPepper);
    await withTransaction(db, async (c) => {
      await c.query(`insert into ccat.admin_local_credentials(admin_id,password_hash) values ($1,$2)
          on conflict (admin_id) do update set password_hash=excluded.password_hash`, [id, hash]);
      await c.query('update ccat.admin_profiles set must_change_password=true where id=$1', [id]);
      await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','admin.password.reset','admin',$2)`, [req.admin!.adminId, id]);
    });
    return { temp_password: tempPassword, note: 'Temporary password — shown once. The admin must change it and re-verify MFA on next login.' };
  });
}
