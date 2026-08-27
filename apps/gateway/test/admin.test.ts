import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
let app: FastifyInstance;

async function json(method: string, url: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) } });
  let p: any = null; try { p = res.json(); } catch {}
  return { status: res.statusCode, body: p, headers: res.headers };
}
async function studentLogin(username: string, device: string) {
  const s = await json('POST', '/v1/registration/contact/start', { body: { guardian_name: 'Guardian', email: `${username}@g.test`, phone: '+14165551234' } });
  const c = await json('POST', '/v1/registration/consent', { body: { registration_grant: s.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  const stu = await json('POST', '/v1/registration/student', { body: { registration_grant: c.body.registration_grant, display_name: 'K', username, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: device } });
  const l = await json('POST', '/v1/auth/login', { body: { username, pin: '1234', device_hash: device } });
  return { id: stu.body.id, token: l.body.access_token as string };
}
const adminLogin = (email: string) => json('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); });
afterAll(async () => { await app.close(); });

describe('admin auth + RBAC (§22, §23)', () => {
  it('logs in; wrong password rejected', async () => {
    const ok = await adminLogin('support@cm.ca');
    expect(ok.status).toBe(200);
    expect(ok.body.admin.role).toBe('admin');
    const bad = await json('POST', '/v1/admin/auth/login', { body: { email: 'support@cm.ca', password: 'nope' } });
    expect(bad.status).toBe(401);
  });

  it('normal admin: directory allowed, ban denied (no permission)', async () => {
    const t = (await adminLogin('support@cm.ca')).body.access_token;
    const kid = await studentLogin('adm_target1', 'adm-dev1');
    const dir = await json('GET', '/v1/admin/students', { token: t });
    expect(dir.status).toBe(200);
    const row = dir.body.items.find((s: any) => s.id === kid.id);
    expect(typeof row.age_years).toBe('number');       // computed age (§4.2)
    expect(row.guardian_email).toContain('@');          // raw guardian PII (§24)

    // suspend allowed
    const susp = await json('POST', `/v1/admin/students/${kid.id}/status`, { token: t, body: { to_status: 'suspended', reason_code: 'abuse' } });
    expect(susp.status).toBe(200);
    // suspension revoked the student's app session
    expect((await json('GET', '/v1/profile', { token: kid.token })).status).toBe(401);

    // ban denied — support admin lacks student.ban
    const kid2 = await studentLogin('adm_target2', 'adm-dev2');
    const ban = await json('POST', `/v1/admin/students/${kid2.id}/status`, { token: t, body: { to_status: 'banned', reason_code: 'x' } });
    expect(ban.status).toBe(403);
    expect(ban.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('super admin can ban; ETag conflict is surfaced', async () => {
    const t = (await adminLogin('super@cm.ca')).body.access_token;
    const kid = await studentLogin('adm_target3', 'adm-dev3');
    const dir = await json('GET', '/v1/admin/students', { token: t });
    const row = dir.body.items.find((s: any) => s.id === kid.id);

    // stale If-Match → 409 with comparison
    const stale = await json('POST', `/v1/admin/students/${kid.id}/status`, { token: t, headers: { 'if-match': String(row.version + 5) }, body: { to_status: 'banned', reason_code: 'x' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.current_version).toBe(row.version);

    // correct version → ban succeeds, ETag returned
    const ban = await json('POST', `/v1/admin/students/${kid.id}/status`, { token: t, headers: { 'if-match': String(row.version) }, body: { to_status: 'banned', reason_code: 'abuse' } });
    expect(ban.status).toBe(200);
    expect(ban.headers.etag).toBe(String(row.version + 1));
  });

  it('audit scope: normal admin self only; global requires permission', async () => {
    const support = (await adminLogin('support@cm.ca')).body.access_token;
    const self = await json('GET', '/v1/admin/audit', { token: support });
    expect(self.status).toBe(200);
    expect(self.body.scope).toBe('self');
    const denied = await json('GET', '/v1/admin/audit?scope=global', { token: support });
    expect(denied.status).toBe(403);

    const superT = (await adminLogin('super@cm.ca')).body.access_token;
    const global = await json('GET', '/v1/admin/audit?scope=global', { token: superT });
    expect(global.status).toBe(200);
    expect(global.body.scope).toBe('global');
    // Rows now carry actor_name + request_id fields and a next_cursor for keyset paging.
    expect('next_cursor' in global.body).toBe(true);
    if (global.body.items[0]) expect('request_id' in global.body.items[0]).toBe(true);
  });

  it('audit filters + facets + keyset pagination (global)', async () => {
    const superT = (await adminLogin('super@cm.ca')).body.access_token;
    // Generate a couple of distinct audit events by publishing an announcement.
    const ann = await json('POST', '/v1/admin/announcements', { token: superT, body: { title: 'Audit probe', body_text: 'x' } });
    await json('POST', `/v1/admin/announcements/${ann.body.id}/publish`, { token: superT });

    // Facets list the event types + target kinds present.
    const facets = await json('GET', '/v1/admin/audit/facets?scope=global', { token: superT });
    expect(facets.status).toBe(200);
    expect(facets.body.event_types).toContain('announcement.published');
    expect(facets.body.target_kinds).toContain('announcement');

    // Event-prefix filter narrows to matching rows only.
    const filtered = await json('GET', '/v1/admin/audit?scope=global&event=announcement.', { token: superT });
    expect(filtered.status).toBe(200);
    expect(filtered.body.items.length).toBeGreaterThan(0);
    expect(filtered.body.items.every((r: any) => String(r.event_type).startsWith('announcement.'))).toBe(true);

    // target_kind filter.
    const byKind = await json('GET', '/v1/admin/audit?scope=global&target_kind=announcement', { token: superT });
    expect(byKind.body.items.every((r: any) => r.target_kind === 'announcement')).toBe(true);

    // Keyset pagination: limit=1 returns a cursor, and the next page differs.
    const p1 = await json('GET', '/v1/admin/audit?scope=global&limit=1', { token: superT });
    expect(p1.body.items.length).toBe(1);
    expect(p1.body.next_cursor).toBeTruthy();
    const p2 = await json('GET', `/v1/admin/audit?scope=global&limit=1&cursor=${encodeURIComponent(p1.body.next_cursor)}`, { token: superT });
    expect(p2.body.items.length).toBe(1);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);

    // request_id is captured on events written through the shared audit helper (e.g. reward changes).
    await json('POST', '/v1/admin/rewards/avatars/families', { token: superT, body: { key: 'audreq_' + Date.now(), name: 'AuditReqFam' } });
    const avatarEvents = await json('GET', '/v1/admin/audit?scope=global&event=avatar.family', { token: superT });
    expect(avatarEvents.body.items.some((r: any) => r.request_id)).toBe(true);

    // Global-only filter (actor) is ignored under self scope; facets still RBAC-gated.
    const support = (await adminLogin('support@cm.ca')).body.access_token;
    expect((await json('GET', '/v1/admin/audit/facets?scope=global', { token: support })).status).toBe(403);
  });

  it('unauthenticated admin request rejected', async () => {
    expect((await json('GET', '/v1/admin/students')).status).toBe(401);
  });
});
