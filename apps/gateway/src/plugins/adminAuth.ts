import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { verifyAdminToken } from '../security/token.js';
import { credentialFingerprint } from '../security/crypto.js';
import { Errors } from '../errors.js';

// Admin request-time enforcement (Blueprint §22.1): validate the token, then load CURRENT
// status + permissions from the DB — never trust client role flags. A disabled admin is blocked
// on the next request regardless of token expiry (§21.1, §28.1).

export interface AdminContext {
  adminId: string;
  role: 'admin' | 'super_admin';
  permissions: Set<string>;
  sites: string[];      // site ids this admin may access (super_admin => every active site)
  activeSite: string;   // the site this request is scoped to (from X-Admin-Site, default 'ccat')
  isTeacher: boolean;   // restricted TEACHER account — student reads are scoped to assigned students
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

// Sites an admin may access. super_admin implicitly reaches every ACTIVE site; a normal admin is
// limited to ccat.admin_sites. Defensive: if the multi-site tables are not present yet (pre-0048),
// fall back to the single legacy site so the gateway is safe to deploy before the migration runs.
export async function loadAdminSites(db: DB, adminId: string, role: string): Promise<string[]> {
  try {
    if (role === 'super_admin') {
      const all = await db.query('select id from ccat.sites where is_active = true order by sort_order');
      const ids = all.rows.map((r) => r.id as string);
      return ids.length ? ids : ['ccat'];
    }
    const r = await db.query('select site_id from ccat.admin_sites where admin_id=$1', [adminId]);
    const ids = r.rows.map((x) => x.site_id as string);
    return ids.length ? ids : ['ccat'];
  } catch {
    return ['ccat'];
  }
}

// Whether an admin is a restricted TEACHER account. Defensive: if the is_teacher column doesn't exist
// yet (pre-0050), treat as a normal admin so the gateway is safe to deploy before the migration runs.
export async function loadIsTeacher(db: DB, adminId: string): Promise<boolean> {
  try {
    const r = await db.query('select is_teacher from ccat.admin_profiles where id=$1', [adminId]);
    return r.rows[0]?.is_teacher === true;
  } catch {
    return false;
  }
}

// Scope guard for STUDENT reads. A teacher account may only see students explicitly assigned to it;
// non-teachers and super_admins pass through. Call this after requirePermission('student.directory')
// on every per-student read (detail / progress / exams). Throws 403 for an unassigned student.
export async function assertStudentVisible(db: DB, req: FastifyRequest, studentId: string): Promise<void> {
  const admin = req.admin;
  if (!admin) throw Errors.unauthorized();
  if (admin.role === 'super_admin' || !admin.isTeacher) return;
  const r = await db.query('select 1 from ccat.teacher_students where teacher_admin_id=$1 and student_id=$2', [admin.adminId, studentId]);
  if (r.rows.length === 0) throw Errors.forbidden('STUDENT_NOT_ASSIGNED', 'This student is not assigned to you');
}

export function makeAuthenticateAdmin(db: DB, hmacSecret: string) {
  return async function authenticateAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) throw Errors.unauthorized();
    const payload = verifyAdminToken(header.slice(7), hmacSecret);
    if (!payload) throw Errors.unauthorized('Invalid or expired admin token');
    const { rows } = await db.query(
      `select p.id, p.security_role, p.status, p.mfa_enrolled, c.password_hash
         from ccat.admin_profiles p
         left join ccat.admin_local_credentials c on c.admin_id = p.id
        where p.id=$1`,
      [payload.sub],
    );
    if (rows.length === 0) throw Errors.unauthorized('Admin not found');
    const a = rows[0]!;
    if (a.status !== 'active') throw Errors.forbidden('ADMIN_DISABLED', 'Admin account is disabled');
    // Token revocation: a token carries a fingerprint (`pv`) of the password hash it was minted
    // against. If the admin's password was reset/unlocked since, the stored hash changed and the
    // fingerprint no longer matches — reject, forcing re-login. Legacy tokens without `pv`, and
    // accounts with no local-credential row, skip the check (backward-compatible rollout).
    if (payload.pv && a.password_hash && credentialFingerprint(a.password_hash) !== payload.pv) {
      throw Errors.unauthorized('Session no longer valid; sign in again');
    }
    const permissions = await loadAdminPermissions(db, a.id, a.security_role);
    const sites = await loadAdminSites(db, a.id, a.security_role);
    // Active site comes from the client (X-Admin-Site); fall back to ccat, then the first granted site.
    const requested = String(req.headers['x-admin-site'] || '').trim().toLowerCase();
    const activeSite = sites.includes(requested) ? requested : (sites.includes('ccat') ? 'ccat' : sites[0]!);
    const isTeacher = await loadIsTeacher(db, a.id);
    req.admin = { adminId: a.id, role: a.security_role, permissions, sites, activeSite, isTeacher };
  };
}

// Guard: require a specific permission (super_admin implicitly holds all).
export function requirePermission(req: FastifyRequest, key: string): void {
  const admin = req.admin;
  if (!admin) throw Errors.unauthorized();
  if (admin.role === 'super_admin') return;
  if (!admin.permissions.has(key)) throw Errors.forbidden('PERMISSION_DENIED', `Missing permission: ${key}`);
}

// Guard: require access to a specific site (super_admin reaches every active site). New per-site
// routes (e.g. teacher.*) call this alongside requirePermission.
export function requireSite(req: FastifyRequest, siteId: string): void {
  const admin = req.admin;
  if (!admin) throw Errors.unauthorized();
  if (admin.role === 'super_admin') return;
  if (!admin.sites.includes(siteId)) throw Errors.forbidden('SITE_DENIED', `No access to site: ${siteId}`);
}

// Guard: Super-Admin only (no permission grants this — used for the Service-health surface, §27).
export function requireSuperAdmin(req: FastifyRequest): void {
  const admin = req.admin;
  if (!admin) throw Errors.unauthorized();
  if (admin.role !== 'super_admin') throw Errors.forbidden('SUPER_ADMIN_ONLY', 'Super-Admin only');
}
