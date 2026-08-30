import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool, type DB } from '../src/db.js';

// CONTENT — permanent set deletion (DELETE /v1/admin/content/sets/:id).
//
// Delete is a HARD delete, distinct from Retire, and works for draft / published / retired sets — but
// ONLY when the set has never been played. A set with student sessions is refused (SET_HAS_ACTIVITY)
// because sessions/results are append-only (§9/§13); the admin retires such a set instead. Deletion is
// scoped to the exact set: it removes the version + its membership (+ the parent set when it was the
// last version) and NOTHING else — member question_versions and unrelated sets are untouched — and it
// takes effect immediately on the student side (catalog omits it; session-start 404s).
//
// Conventions: shares the single seeded test DB with every other suite (globalSetup), runs in a
// parallel worker, so this file only ever operates on fixtures it creates itself (unique ids) and never
// mutates shared seed rows. Grade 5 + Verbal/Analogies/Easy taxonomy come from setup.ts.

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const uniq = Math.random().toString(36).slice(2, 8); // isolate this run's students/labels from other workers

let app: FastifyInstance;
let db: DB;

async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({
    method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
  });
  let b: any = null; try { b = res.json(); } catch { /* empty body */ }
  return { status: res.statusCode, body: b, raw: res.body };
}

const adminLogin = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });

// Full student registration + login (mirrors practice-loop.test.ts), grade 5 by default.
async function studentToken(username: string, gradeId: string = GRADE5) {
  const c = await j('POST', '/v1/registration/contact/start', { body: { guardian_name: 'G', email: `${username}@ex.test`, phone: '+14165551234' } });
  const consent = await j('POST', '/v1/registration/consent', { body: { registration_grant: c.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  await j('POST', '/v1/registration/student', { body: { registration_grant: consent.body.registration_grant, display_name: 'K', username, grade_id: gradeId, birth_month: 6, birth_year: 2015, pin: '1234', device_hash: `dev-${username}` } });
  return (await j('POST', '/v1/auth/login', { body: { username, pin: '1234', device_hash: `dev-${username}` } })).body.access_token as string;
}

// A valid 5-question row batch for the scoped importer — all rows share one scope, so the gateway
// groups them into ONE draft practice set with 5 questions.
const rows = (label: string) => Array.from({ length: 5 }, (_, i) => ({
  grade: '5', battery: 'Verbal', category: 'Analogies', difficulty: 'Easy',
  stem: `${label} Q${i + 1}: Cat is to Kitten as Dog is to ?`, type: 'analogy',
  options: [{ text: 'Puppy', correct: true }, { text: 'Cub', correct: false }, { text: 'Foal', correct: false }],
  explanation: 'A kitten is a baby cat; a puppy is a baby dog.',
}));

let su = '', editor = '', support = '';

// Create a fresh DRAFT set (unique scope-content) and return its set_version id.
async function makeDraftSet(label: string): Promise<string> {
  const imp = await j('POST', '/v1/admin/content/import', { token: editor, body: { rows: rows(`${uniq}-${label}`) } });
  expect(imp.status).toBe(200);
  expect(imp.body.imported).toBe(5);
  return imp.body.sets[0].set_version_id as string;
}
async function publish(sv: string) {
  const p = await j('POST', `/v1/admin/content/sets/${sv}/publish`, { token: editor });
  expect(p.status).toBe(200); expect(p.body.state).toBe('published');
}
async function retire(sv: string) {
  // Unpublish = retire (published -> retired only, §8.1). content.publish is sufficient.
  const u = await j('POST', `/v1/admin/content/sets/${sv}/unpublish`, { token: editor });
  expect(u.status).toBe(200); expect(u.body.state).toBe('retired');
}
const dbNum = async (sql: string, p: any[] = []) => Number((await db.query(sql, p)).rows[0].c);
const setVersionExists = (sv: string) => dbNum('select count(*)::int c from ccat.question_set_versions where id=$1', [sv]).then(n => n === 1);
const catalogHas = async (token: string, sv: string) => {
  const cat = await j('GET', '/v1/catalog', { token });
  return Array.isArray(cat.body) && cat.body.some((r: any) => r.set_version_id === sv);
};

beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  db = createPool(process.env.DATABASE_URL!);
  su = (await adminLogin('super@cm.ca')).body.access_token;         // super_admin — every permission
  editor = (await adminLogin('content@cm.ca')).body.access_token;   // content.create + content.publish
  support = (await adminLogin('support@cm.ca')).body.access_token;  // no content.* permissions
});
afterAll(async () => { await db.end(); await app.close(); });

describe('CONTENT — permanent set delete', () => {
  it('deletes a DRAFT set', async () => {
    const sv = await makeDraftSet('draft');
    expect(await setVersionExists(sv)).toBe(true);
    const del = await j('DELETE', `/v1/admin/content/sets/${sv}`, { token: editor });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect(await setVersionExists(sv)).toBe(false);
  });

  it('deletes a PUBLISHED but never-played set (no retire step required)', async () => {
    const sv = await makeDraftSet('pub');
    await publish(sv);
    const del = await j('DELETE', `/v1/admin/content/sets/${sv}`, { token: editor });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect(await setVersionExists(sv)).toBe(false);
  });

  it('deletes a RETIRED set', async () => {
    const sv = await makeDraftSet('ret');
    await publish(sv);
    await retire(sv);
    const del = await j('DELETE', `/v1/admin/content/sets/${sv}`, { token: editor });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect(await setVersionExists(sv)).toBe(false);
  });

  it('refuses to delete a PLAYED set with 409 SET_HAS_ACTIVITY (and leaves it intact)', async () => {
    const sv = await makeDraftSet('played');
    await publish(sv);
    // A student starts a session on it -> the set now has append-only play history.
    const stu = await studentToken(`del_played_${uniq}`);
    const start = await j('POST', '/v1/sessions/start', { token: stu, body: { set_version_id: sv, mode: 'practice', timer_type: 'untimed' } });
    expect(start.status).toBe(201);

    const del = await j('DELETE', `/v1/admin/content/sets/${sv}`, { token: editor });
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('SET_HAS_ACTIVITY');
    // The set (and the student's session) survive the refused delete.
    expect(await setVersionExists(sv)).toBe(true);
    expect(await dbNum('select count(*)::int c from ccat.sessions where set_version_id=$1', [sv])).toBe(1);
  });

  it('returns 404 for a non-existent set', async () => {
    const del = await j('DELETE', '/v1/admin/content/sets/00000000-0000-0000-0000-0000000000de', { token: editor });
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects an admin lacking content.create (403) without deleting', async () => {
    const sv = await makeDraftSet('authz');
    const del = await j('DELETE', `/v1/admin/content/sets/${sv}`, { token: support });
    expect(del.status).toBe(403);
    expect(await setVersionExists(sv)).toBe(true); // untouched by the rejected request
  });

  it('does NOT delete the set\'s question records (only membership)', async () => {
    const sv = await makeDraftSet('keepq');
    // Capture the member question_version ids before deletion.
    const members = (await db.query('select question_version_id from ccat.set_version_questions where set_version_id=$1', [sv])).rows.map(r => r.question_version_id);
    expect(members.length).toBe(5);
    await publish(sv); // members become published question_versions
    const del = await j('DELETE', `/v1/admin/content/sets/${sv}`, { token: editor });
    expect(del.status).toBe(200);
    // Membership rows are gone; the question_versions themselves remain in the pool.
    expect(await dbNum('select count(*)::int c from ccat.set_version_questions where set_version_id=$1', [sv])).toBe(0);
    expect(await dbNum('select count(*)::int c from ccat.question_versions where id = any($1::uuid[])', [members])).toBe(5);
  });

  it('does NOT affect unrelated sets', async () => {
    const a = await makeDraftSet('unrel-a');
    const b = await makeDraftSet('unrel-b');
    const bMembersBefore = await dbNum('select count(*)::int c from ccat.set_version_questions where set_version_id=$1', [b]);
    const bParent = (await db.query('select question_set_id from ccat.question_set_versions where id=$1', [b])).rows[0].question_set_id;

    const del = await j('DELETE', `/v1/admin/content/sets/${a}`, { token: editor });
    expect(del.status).toBe(200);

    // A is gone; B (version, parent, membership) is entirely intact.
    expect(await setVersionExists(a)).toBe(false);
    expect(await setVersionExists(b)).toBe(true);
    expect(await dbNum('select count(*)::int c from ccat.question_sets where id=$1', [bParent])).toBe(1);
    expect(await dbNum('select count(*)::int c from ccat.set_version_questions where set_version_id=$1', [b])).toBe(bMembersBefore);
    // A seeded shared set is likewise untouched.
    expect(await setVersionExists('e1000000-0000-0000-0000-000000000001')).toBe(true);
  });

  it('a deleted published set leaves the student catalog and cannot be started', async () => {
    const sv = await makeDraftSet('catalog');
    await publish(sv);
    const stu = await studentToken(`del_catalog_${uniq}`);

    // Visible while published...
    expect(await catalogHas(stu, sv)).toBe(true);

    const del = await j('DELETE', `/v1/admin/content/sets/${sv}`, { token: editor });
    expect(del.status).toBe(200);

    // ...gone from the catalog immediately, and un-startable (non-leaking 404, same as a nonexistent set).
    expect(await catalogHas(stu, sv)).toBe(false);
    const start = await j('POST', '/v1/sessions/start', { token: stu, body: { set_version_id: sv, mode: 'practice', timer_type: 'untimed' } });
    expect(start.status).toBe(404);
    expect(start.body.error.code).toBe('NOT_FOUND');
  });
});
