import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// ADMIN-2: admin-account erasure by anonymize + tombstone (Option A). A hard-DELETE is impossible —
// audit_log.actor_admin_id references admin_profiles and audit_log is append-only (tg_forbid_mutation),
// so the ON DELETE sweep is rejected. This proves the tombstone path scrubs PII, drops credentials +
// grants, keeps the row (audit trail intact), and enforces the self / active-super-admin guards.

let app: FastifyInstance;
let db: pg.Client;

async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });

let su = '', sup = '', suId = '';
beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  su = (await login('super@cm.ca')).body.access_token;
  sup = (await login('support@cm.ca')).body.access_token;
  suId = (await j('GET', '/v1/admin/me', { token: su })).body.id;
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect(); await db.query('set search_path = ccat, public');
});
afterAll(async () => { await app.close(); await db.end(); });

const one = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];
const num = async (sql: string, p: any[] = []) => Number((await one(sql, p)).c);

describe('ADMIN-2 — admin delete (anonymize + tombstone)', () => {
  it('deletes an admin without tripping the append-only audit invariant', async () => {
    const created = await j('POST', '/v1/admin/accounts', { token: su, body: { email: 'todelete@cm.ca', display_name: 'To Delete', role: 'admin', permissions: ['student.directory'] } });
    expect(created.status).toBe(200);
    const id = created.body.id as string;

    // Appears in the active roster; has credentials + a grant.
    let list = await j('GET', '/v1/admin/accounts', { token: su });
    expect(list.body.items.some((a: any) => a.id === id)).toBe(true);
    expect(await num(`select count(*) c from ccat.admin_local_credentials where admin_id=$1`, [id])).toBe(1);
    expect(await num(`select count(*) c from ccat.admin_permissions where admin_id=$1`, [id])).toBe(1);
    // Audit rows referencing this admin exist (admin.created) — these must survive the delete.
    const auditBefore = await num(`select count(*) c from ccat.audit_log where target_id=$1`, [id]);
    expect(auditBefore).toBeGreaterThan(0);

    // Support lacks admin.manage → forbidden.
    expect((await j('DELETE', `/v1/admin/accounts/${id}`, { token: sup })).status).toBe(403);

    // Super deletes. 200 here is the regression proof: a hard-DELETE would raise
    // 'Table ccat.audit_log is append-only' when the FK sweep hit the actor/target rows.
    const del = await j('DELETE', `/v1/admin/accounts/${id}`, { token: su, body: { reference: 'CASE-9' } });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    // Gone from the active roster.
    list = await j('GET', '/v1/admin/accounts', { token: su });
    expect(list.body.items.some((a: any) => a.id === id)).toBe(false);

    // Row retained + PII scrubbed.
    const row = await one(`select status, email::text, display_name from ccat.admin_profiles where id=$1`, [id]);
    expect(row.status).toBe('deleted');
    expect(row.display_name).toBe('Deleted admin');
    expect(row.email).toMatch(/^deleted\+/);
    expect(row.email).not.toContain('todelete');

    // Credentials + grants dropped.
    expect(await num(`select count(*) c from ccat.admin_local_credentials where admin_id=$1`, [id])).toBe(0);
    expect(await num(`select count(*) c from ccat.admin_permissions where admin_id=$1`, [id])).toBe(0);
    expect(await num(`select count(*) c from ccat.admin_profile_bundles where admin_id=$1`, [id])).toBe(0);

    // Audit trail intact (older rows survive) + the delete itself was audited.
    expect(await num(`select count(*) c from ccat.audit_log where target_id=$1`, [id])).toBeGreaterThan(auditBefore);
    expect(await num(`select count(*) c from ccat.audit_log where target_id=$1 and event_type='admin.deleted'`, [id])).toBe(1);

    // The tombstoned admin can no longer log in.
    expect((await login('deleted+' + id + '@invalid.local')).status).toBe(401);

    // Second delete → already deleted (422).
    expect((await j('DELETE', `/v1/admin/accounts/${id}`, { token: su })).status).toBe(422);
  });

  it('refuses to delete an active Super-Admin (must disable/demote first)', async () => {
    const r = await j('DELETE', `/v1/admin/accounts/${suId}`, { token: su });
    // Self-delete guard fires first here since suId is the caller; either way it is refused (409).
    expect(r.status).toBe(409);
  });

  it('refuses self-deletion', async () => {
    const r = await j('DELETE', `/v1/admin/accounts/${suId}`, { token: su });
    expect(r.status).toBe(409);
    expect(r.body.error?.code || r.body.code).toBe('SELF_DELETE');
  });

  it('refuses to delete another active Super-Admin', async () => {
    // Create a second super-admin, then attempt deletion while active → blocked.
    const c = await j('POST', '/v1/admin/accounts', { token: su, body: { email: 'super2@cm.ca', display_name: 'Super Two', role: 'super_admin' } });
    const id2 = c.body.id as string;
    const r = await j('DELETE', `/v1/admin/accounts/${id2}`, { token: su });
    expect(r.status).toBe(409);
    expect(r.body.error?.code || r.body.code).toBe('ACTIVE_SUPER_ADMIN');
    // But after demotion to admin it can be deleted.
    await j('PATCH', `/v1/admin/accounts/${id2}`, { token: su, body: { role: 'admin' } });
    expect((await j('DELETE', `/v1/admin/accounts/${id2}`, { token: su })).status).toBe(200);
  });
});
