import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { verifyAdminToken } from '../security/token.js';
import { Errors } from '../errors.js';

// Admin request-time enforcement (Blueprint §22.1): validate the token, then load CURRENT
// status + permissions from the DB — never trust client role flags. A disabled admin is blocked
// on the next request regardless of token expiry (§21.1, §28.1).

export interface AdminContext {
  adminId: string;
  role: 'admin' | 'super_admin';
  permissions: Set<string>;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminContext;
  }
}

export async function loadAdminPermissions(db: DB, adminId: string, role: string): Promise<Set<string>> {
  if (role === 'super_admin') {
    const all = await db.query('select key from ccat.permissions');
    return new Set(all.rows.map((r) => r.key as string));
  }
  const direct = await db.query('select permission_key from ccat.admin_permissions where admin_id=$1', [adminId]);
  const viaBundle = await db.query(
    `select bp.permission_key
       from ccat.admin_profile_bundles apb
       join ccat.admin_bundle_permissions bp on bp.bundle_id = apb.bundle_id
      where apb.admin_id = $1`,
    [adminId],
  );
  return new Set([...direct.rows, ...viaBundle.rows].map((r) => r.permission_key as string));
}

export function makeAuthenticateAdmin(db: DB, hmacSecret: string) {
  return async function authenticateAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) throw Errors.unauthorized();
    const payload = verifyAdminToken(header.slice(7), hmacSecret);
    if (!payload) throw Errors.unauthorized('Invalid or expired admin token');
    const { rows } = await db.query(
      'select id, security_role, status, mfa_enrolled from ccat.admin_profiles where id=$1',
      [payload.sub],
    );
    if (rows.length === 0) throw Errors.unauthorized('Admin not found');
    const a = rows[0]!;
    if (a.status !== 'active') throw Errors.forbidden('ADMIN_DISABLED', 'Admin account is disabled');
    const permissions = await loadAdminPermissions(db, a.id, a.security_role);
    req.admin = { adminId: a.id, role: a.security_role, permissions };
  };
}

// Guard: require a specific permission (super_admin implicitly holds all).
export function requirePermission(req: FastifyRequest, key: string): void {
  const admin = req.admin;
  if (!admin) throw Errors.unauthorized();
  if (admin.role === 'super_admin') return;
  if (!admin.permissions.has(key)) throw Errors.forbidden('PERMISSION_DENIED', `Missing permission: ${key}`);
}

// Guard: Super-Admin only (no permission grants this — used for the Service-health surface, §27).
export function requireSuperAdmin(req: FastifyRequest): void {
  const admin = req.admin;
  if (!admin) throw Errors.unauthorized();
  if (admin.role !== 'super_admin') throw Errors.forbidden('SUPER_ADMIN_ONLY', 'Super-Admin only');
}
