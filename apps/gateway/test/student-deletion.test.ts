import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// STUDENTS-2: admin-recorded deletion request moves the student to pending_deletion, opens a 30-day
// restore window, and is gated by deletion.support. (DSAR export is a client-side download — no route.)
let app: FastifyInstance; let db: ReturnType<typeof createPool>;
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';

async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
let su = '';
let n = 0;
async function makeStudent(): Promise<string> {
  n++;
  const s = await db.query(`insert into ccat.students(username_normalized, display_name, grade_id, birth_month, birth_year) values ($1,'Del Kid',$2,6,2016) returning id`, [`del_kid_${n}_${Date.now()}`, GRADE5]);
  return s.rows[0]!.id;
}

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); db = createPool(process.env.DATABASE_URL!); su = (await login('super@cm.ca')).body.access_token; });
afterAll(async () => { await app.close(); await db.end(); });

describe('student deletion request (STUDENTS-2)', () => {
  it('records a deletion request → pending_deletion + 30-day restore window + audit', async () => {
    const id = await makeStudent();
    const r = await j('POST', `/v1/admin/students/${id}/deletion`, { token: su, body: { reference: 'CASE-1042' } });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('pending_deletion');
    const s = await db.query('select status from ccat.students where id=$1', [id]);
    expect(s.rows[0]!.status).toBe('pending_deletion');
    const dr = await db.query(`select restore_deadline from ccat.deletion_requests where student_id=$1`, [id]);
    expect(dr.rows.length).toBe(1);
    expect(new Date(dr.rows[0]!.restore_deadline).getTime()).toBeGreaterThan(Date.now());
    const aud = await db.query(`select 1 from ccat.audit_log where event_type='student.deletion.requested' and target_id=$1`, [id]);
    expect(aud.rows.length).toBe(1);
  });

  it('RBAC: an admin without deletion.support gets 403', async () => {
    const id = await makeStudent();
    // content admin does not hold deletion.support
    const ce = (await login('content@cm.ca')).body.access_token;
    const r = await j('POST', `/v1/admin/students/${id}/deletion`, { token: ce, body: {} });
    expect(r.status).toBe(403);
  });
});
