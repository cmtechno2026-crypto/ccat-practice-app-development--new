import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// ADMIN-1: a run of failed admin logins locks the account; an admin.manage holder unlocks it, which
// clears the counters and issues a fresh one-time password. A throwaway admin is used so locking it
// cannot disturb the shared seeded logins other tests depend on.
let app: FastifyInstance; let db: ReturnType<typeof createPool>;
async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string, password: string) => j('POST', '/v1/admin/auth/login', { body: { email, password } });
async function loginAndChangeTemporaryPassword(email: string, temporaryPassword: string, newPassword: string) {
  const first = await login(email, temporaryPassword);
  expect(first.status).toBe(403);
  expect(first.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  return j('POST', '/v1/admin/auth/change-password', {
    body: { change_token: first.body.error.details.change_token, new_password: newPassword },
  });
}
let su = '';
const EMAIL = `locktest_${Date.now()}@cm.ca`;
const PW = 'LockTest123!';
let lockedId = '';

beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready(); db = createPool(process.env.DATABASE_URL!);
  su = (await login('super@cm.ca', 'Passw0rd!')).body.access_token;
  const created = await j('POST', '/v1/admin/accounts', { token: su, body: { email: EMAIL, display_name: 'Lock Test', role: 'admin', permissions: [], temp_password: PW } });
  lockedId = created.body.id;
});
afterAll(async () => { await app.close(); await db.end(); });

describe('admin lockout + unlock (ADMIN-1)', () => {
  it('locks after 5 failed logins, then a super unlock restores access', async () => {
    // First use of the temporary password is restricted to the password-change endpoint.
    const activePassword = 'ChangedLockTest123!';
    expect((await loginAndChangeTemporaryPassword(EMAIL, PW, activePassword)).status).toBe(200);
    // 5 wrong-password attempts
    for (let i = 0; i < 5; i++) expect((await login(EMAIL, 'wrong-password')).status).toBe(401);
    // now even the correct password is refused — the account is locked
    const blocked = await login(EMAIL, activePassword);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error_code || blocked.body.code || JSON.stringify(blocked.body)).toContain('ADMIN_LOCKED');
    // accounts list shows it locked
    const list1 = await j('GET', '/v1/admin/accounts', { token: su });
    expect(list1.body.items.find((a: any) => a.id === lockedId).locked).toBe(true);

    // unlock → new temp password
    const un = await j('POST', `/v1/admin/accounts/${lockedId}/unlock`, { token: su });
    expect(un.status).toBe(200);
    expect(typeof un.body.temp_password).toBe('string');
    // old password no longer works; the new one does
    expect((await login(EMAIL, activePassword)).status).toBe(401);
    expect((await loginAndChangeTemporaryPassword(EMAIL, un.body.temp_password, 'ChangedAgain123!')).status).toBe(200);
    // no longer locked in the list
    const list2 = await j('GET', '/v1/admin/accounts', { token: su });
    expect(list2.body.items.find((a: any) => a.id === lockedId).locked).toBe(false);
    // audited
    const aud = await db.query(`select 1 from ccat.audit_log where event_type='admin.unlocked' and target_id=$1`, [lockedId]);
    expect(aud.rows.length).toBe(1);
  });

  it('RBAC: an admin without admin.manage cannot unlock', async () => {
    const sup = (await login('support@cm.ca', 'Passw0rd!')).body.access_token;
    const r = await j('POST', `/v1/admin/accounts/${lockedId}/unlock`, { token: sup });
    expect(r.status).toBe(403);
  });
});
