import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// AUDIT-2: mutating writers record a before→after diff in audit_log.old_value / new_value so the
// Audit page's "what changed" column renders (mockup: "status: active → suspended", "xp: 50 → 75").
let app: FastifyInstance; let db: ReturnType<typeof createPool>;
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
async function j(method: string, url: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
let su = '';
const lastAudit = async (event: string, targetId: string) =>
  (await db.query(`select old_value, new_value from ccat.audit_log where event_type=$1 and target_id=$2 order by created_at desc limit 1`, [event, targetId])).rows[0];

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); db = createPool(process.env.DATABASE_URL!); su = (await login('super@cm.ca')).body.access_token; });
afterAll(async () => { await app.close(); await db.end(); });

describe('audit before→after diffs (AUDIT-2)', () => {
  it('student status change records old/new status', async () => {
    const s = await db.query(`insert into ccat.students(username_normalized,display_name,grade_id,birth_month,birth_year,version) values ($1,'Audit Kid',$2,6,2016,1) returning id`, [`audit_kid_${Date.now()}`, GRADE5]);
    const id = s.rows[0]!.id;
    const r = await j('POST', `/v1/admin/students/${id}/status`, { token: su, body: { to_status: 'suspended', reason_code: 'policy' }, headers: { 'if-match': '1' } });
    expect(r.status).toBe(200);
    const a = await lastAudit('student.status.changed', id);
    expect(a.old_value).toEqual({ status: 'active' });
    expect(a.new_value).toEqual({ status: 'suspended' });
  });

  it('achievement edit records old/new xp', async () => {
    const vid = (await j('GET', '/v1/admin/rewards/achievements', { token: su })).body.items[0].version_id;
    await j('PATCH', `/v1/admin/rewards/achievements/versions/${vid}`, { token: su, body: { xp: 40 } });
    await j('PATCH', `/v1/admin/rewards/achievements/versions/${vid}`, { token: su, body: { xp: 65 } });
    const a = await lastAudit('achievement.updated', vid);
    expect(a.old_value).toEqual({ xp: 40 });
    expect(a.new_value).toEqual({ xp: 65 });
  });

  it('announcement publish records old/new state', async () => {
    const ann = (await j('POST', '/v1/admin/announcements', { token: su, body: { title: 'Audit Ann', body_text: 'Hi families.', channel: 'carousel' } })).body;
    await j('POST', `/v1/admin/announcements/${ann.id}/publish`, { token: su });
    const a = await lastAudit('announcement.published', ann.id);
    expect(a.old_value).toEqual({ state: 'draft' });
    expect(a.new_value).toEqual({ state: 'published' });
  });
});
