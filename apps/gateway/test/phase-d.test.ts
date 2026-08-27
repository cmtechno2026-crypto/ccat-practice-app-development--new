import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Admin → Practice control. Two backend controls proven to reflect on the student surface:
//  (1) Grade practice switch — disabling it blocks practice session-start (422) AND strips
//      'practice' from the student catalog's allowed_modes; exam is unaffected.
//  (2) Retiring a published set removes it from the student catalog (published sets are immutable
//      and may only be retired, never unpublished — /unpublish returns a clean 409, never a 500).
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const PRACTICE_SET = 'e1000000-0000-0000-0000-000000000001'; // practice+exam, published
const EXAM_ONLY_SET = 'e1000000-0000-0000-0000-0000000000b2'; // exam-only, published

let app: FastifyInstance;
async function json(method: string, url: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await app.inject({ method: method as any, url, payload: body as any, headers });
  let parsed: any = null; try { parsed = res.json(); } catch { /* */ }
  return { status: res.statusCode, body: parsed };
}

async function adminToken(): Promise<string> {
  const r = await json('POST', '/v1/admin/auth/login', { email: 'super@cm.ca', password: 'Passw0rd!' });
  expect(r.status).toBe(200);
  return r.body.access_token;
}

async function studentToken(username: string, device: string): Promise<string> {
  const c = await json('POST', '/v1/registration/contact/start', { guardian_name: 'Pat', email: `${username}@x.test`, phone: '+14165551234' });
  const consent = await json('POST', '/v1/registration/consent', { registration_grant: c.body.registration_grant, policy_version: 'v1', consent_hash: 'h' });
  await json('POST', '/v1/registration/student', { registration_grant: consent.body.registration_grant, display_name: 'Kid', username, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: device });
  const login = await json('POST', '/v1/auth/login', { username, pin: '1234', device_hash: device });
  expect(login.status).toBe(200);
  return login.body.access_token;
}

function modesFor(catalog: any[], setId: string): string[] | null {
  const row = catalog.find((s) => s.set_version_id === setId);
  return row ? row.allowed_modes : null;
}

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); });
afterAll(async () => { await app.close(); });

describe('Admin Practice control — reflects on the student surface', () => {
  it('grade practice switch gates practice start (422) and strips practice from the catalog; exam unaffected; reversible', async () => {
    const admin = await adminToken();
    const stu = await studentToken('pdgate', 'dev-pdgate');

    // Baseline: catalog offers practice on the practice set; practice start would be allowed.
    const before = await json('GET', '/v1/catalog', undefined, stu);
    expect(before.status).toBe(200);
    expect(modesFor(before.body, PRACTICE_SET)).toContain('practice');

    // Disable practice for the grade.
    const off = await json('PATCH', `/v1/admin/config/grades/${GRADE5}`, { practice_enabled: false }, admin);
    expect(off.status).toBe(200);

    const during = await json('GET', '/v1/catalog', undefined, stu);
    expect(modesFor(during.body, PRACTICE_SET)).not.toContain('practice');
    expect(modesFor(during.body, PRACTICE_SET)).toContain('exam'); // exam still offered

    const startBlocked = await json('POST', '/v1/sessions/start', { set_version_id: PRACTICE_SET, mode: 'practice', timer_type: 'untimed' }, stu);
    expect(startBlocked.status).toBe(422);
    expect(startBlocked.body.error.details?.code ?? startBlocked.body.error.code).toBe('PRACTICE_DISABLED_FOR_GRADE');

    // Re-enable — practice returns.
    const on = await json('PATCH', `/v1/admin/config/grades/${GRADE5}`, { practice_enabled: true }, admin);
    expect(on.status).toBe(200);
    const after = await json('GET', '/v1/catalog', undefined, stu);
    expect(modesFor(after.body, PRACTICE_SET)).toContain('practice');
  });

  it('unpublishing a published set is refused with a clean 409 (immutable — retire instead)', async () => {
    const admin = await adminToken();
    const r = await json('POST', `/v1/admin/content/sets/${EXAM_ONLY_SET}/unpublish`, {}, admin);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IMMUTABLE_PUBLISHED');
  });

  it('retiring a published set removes it from the student catalog', async () => {
    // Seed a throwaway published grade-5 set (its own set + version) so we retire it without touching
    // the shared fixtures other test files depend on. Reuses the seed's published question as member.
    const SET = 'e0000000-0000-0000-0000-0000000000d1';
    const SV = 'e1000000-0000-0000-0000-0000000000d1';
    const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect(); await db.query('set search_path = ccat, public');
    await db.query(`insert into question_sets(id,grade_id,category_id,subcategory_id,name)
      values ($1,'a0000000-0000-0000-0000-000000000005','b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','Retire Me') on conflict do nothing`, [SET]);
    await db.query(`insert into question_set_versions(id,question_set_id,version_number,difficulty_id,question_count,allowed_practice,allowed_exam,state,published_at)
      values ($1,$2,1,'c0000000-0000-0000-0000-000000000001',1,true,false,'published',now()) on conflict do nothing`, [SV, SET]);
    await db.query(`insert into set_version_questions(set_version_id,question_version_id,position)
      values ($1,'d1000000-0000-0000-0000-000000000001',1) on conflict do nothing`, [SV]);
    await db.end();

    const admin = await adminToken();
    const stu = await studentToken('pdretire', 'dev-pdretire');

    const before = await json('GET', '/v1/catalog', undefined, stu);
    expect(before.body.some((s: any) => s.set_version_id === SV)).toBe(true);

    const retire = await json('POST', `/v1/admin/content/sets/${SV}/retire`, {}, admin);
    expect(retire.status).toBe(200);
    expect(retire.body.state).toBe('retired');

    const after = await json('GET', '/v1/catalog', undefined, stu);
    expect(after.body.some((s: any) => s.set_version_id === SV)).toBe(false);
  });
});
