import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool, type DB } from '../src/db.js';

// The Practice content loop, end-to-end through the real gateway endpoints:
//   ADMIN bulk-authors a scoped set (grade+battery+subcategory+difficulty, +answer keys server-side)
//   -> publish -> the STUDENT catalog (their grade, published, practice) shows it by scope
//   -> UNPUBLISH retires it (§8.1 immutability: published -> retired only) -> it disappears.
// Seeded taxonomy (setup.ts): grade 5, battery Verbal (subcategory "Analogies"/key 'an'), difficulty Easy.
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const GRADE4 = 'a0000000-0000-0000-0000-000000000004';

let app: FastifyInstance;
async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b, raw: res.body };
}
const adminLogin = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
async function studentToken(username: string, gradeId: string = GRADE5) {
  const c = await j('POST', '/v1/registration/contact/start', { body: { guardian_name: 'G', email: `${username}@ex.test`, phone: '+14165551234' } });
  const consent = await j('POST', '/v1/registration/consent', { body: { registration_grant: c.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  await j('POST', '/v1/registration/student', { body: { registration_grant: consent.body.registration_grant, display_name: 'K', username, grade_id: gradeId, birth_month: 6, birth_year: 2015, pin: '1234', device_hash: `dev-${username}` } });
  return (await j('POST', '/v1/auth/login', { body: { username, pin: '1234', device_hash: `dev-${username}` } })).body.access_token as string;
}
const q = (i: number) => ({ grade: '5', battery: 'Verbal', category: 'Analogies', difficulty: 'Easy',
  stem: `Cat is to Kitten as Dog is to ? (Q${i})`, type: 'analogy',
  options: [{ text: 'Puppy', correct: true }, { text: 'Cub', correct: false }, { text: 'Foal', correct: false }],
  explanation: 'A kitten is a baby cat; a puppy is a baby dog.' });

let editor = '', student = '';
let db: DB;
beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  db = createPool(process.env.DATABASE_URL!);
  // The base fixture seeds only Grade 5; add Grade 4 so grade-isolation can be exercised.
  await db.query(
    `insert into ccat.grades(id, grade_number, name, age_min_years, age_max_years)
       values ($1, 4, 'Grade 4', 7, 12) on conflict (id) do nothing`,
    [GRADE4],
  );
  editor = (await adminLogin('content@cm.ca')).body.access_token; // content.create + content.publish
  student = await studentToken('loopkid5');
});
afterAll(async () => { await db.end(); await app.close(); });

describe('Practice content loop (author -> publish -> catalog-by-grade -> unpublish)', () => {
  it('scoped bulk author -> publish -> student catalog shows it by battery/subcategory/difficulty; answer key stays server-side', async () => {
    const imp = await j('POST', '/v1/admin/content/import', { token: editor, body: { rows: Array.from({ length: 5 }, (_, i) => q(i + 1)) } });
    expect(imp.status).toBe(200);
    expect(imp.body.imported).toBe(5);
    expect(imp.body.rejected).toEqual([]);
    const sv = imp.body.sets[0].set_version_id as string;

    // Not visible while draft.
    const beforePub = await j('GET', '/v1/catalog', { token: student });
    expect(beforePub.body.find((c: any) => c.set_version_id === sv)).toBeUndefined();

    // Publish → visible to the grade-5 student, scoped, practice-only, answer key never sent.
    const pub = await j('POST', `/v1/admin/content/sets/${sv}/publish`, { token: editor });
    expect(pub.status).toBe(200); expect(pub.body.state).toBe('published');

    const cat = await j('GET', '/v1/catalog', { token: student });
    const row = cat.body.find((c: any) => c.set_version_id === sv);
    expect(row).toBeTruthy();
    expect(row.category_key).toBe('verbal');
    expect(row.subcategory).toBe('Analogies');
    expect(String(row.difficulty)).toBe('easy');
    expect(row.allowed_modes).toContain('practice');
    expect(row.question_count).toBe(5);
    expect(cat.raw).not.toContain('correct_option_ids'); // answer key never leaves the server

    // Unpublish = RETIRE (published -> retired only, §8.1). It disappears from the catalog.
    const unp = await j('POST', `/v1/admin/content/sets/${sv}/unpublish`, { token: editor });
    expect(unp.status).toBe(200);
    expect(unp.body.state).toBe('retired');
    const after = await j('GET', '/v1/catalog', { token: student });
    expect(after.body.find((c: any) => c.set_version_id === sv)).toBeUndefined();
  });

  it('unpublishing a non-published (draft) set is rejected', async () => {
    const imp = await j('POST', '/v1/admin/content/import', { token: editor, body: { rows: Array.from({ length: 5 }, (_, i) => q(i + 10)) } });
    const sv = imp.body.sets[0].set_version_id as string; // still draft
    const unp = await j('POST', `/v1/admin/content/sets/${sv}/unpublish`, { token: editor });
    expect(unp.status).toBe(409);
    expect(unp.body.error.code).toBe('BAD_STATE');
  });
});

// Grade isolation on session START (§8 / §32.3). The catalog read is grade-scoped; a student must
// ALSO be unable to *start* a set outside their grade by supplying its id directly. The guard fires
// before the published/mode checks and returns a non-leaking 404 (a cross-grade set is
// indistinguishable from a nonexistent one) — for BOTH practice and exam modes.
describe('Grade isolation on session start (author -> publish -> only the owning grade may start)', () => {
  it('owning grade starts (201); another grade gets a non-leaking 404 for practice AND exam', async () => {
    const imp = await j('POST', '/v1/admin/content/import', { token: editor, body: { rows: Array.from({ length: 5 }, (_, i) => q(i + 100)) } });
    expect(imp.status).toBe(200);
    const sv = imp.body.sets[0].set_version_id as string;
    const pub = await j('POST', `/v1/admin/content/sets/${sv}/publish`, { token: editor });
    expect(pub.status).toBe(200); expect(pub.body.state).toBe('published');

    const g5 = await studentToken('iso_grade5', GRADE5);
    const g4 = await studentToken('iso_grade4', GRADE4);

    // Owning grade (5) may start it.
    const ok = await j('POST', '/v1/sessions/start', { token: g5, body: { set_version_id: sv, mode: 'practice', timer_type: 'untimed' } });
    expect(ok.status).toBe(201);
    expect(ok.body.set_version_id).toBe(sv);

    // Grade 4 may NOT start it — practice.
    const noPractice = await j('POST', '/v1/sessions/start', { token: g4, body: { set_version_id: sv, mode: 'practice', timer_type: 'untimed' } });
    expect(noPractice.status).toBe(404);
    expect(noPractice.body.error.code).toBe('NOT_FOUND');

    // Grade 4 may NOT start it — exam (grade guard precedes the mode/allowed_exam checks).
    const noExam = await j('POST', '/v1/sessions/start', { token: g4, body: { set_version_id: sv, mode: 'exam', timer_type: 'untimed' } });
    expect(noExam.status).toBe(404);
    expect(noExam.body.error.code).toBe('NOT_FOUND');

    // Non-leaking: the cross-grade 404 is byte-for-byte the same envelope as a nonexistent-set 404,
    // and reveals nothing about the set's grade or publish state.
    const ghost = await j('POST', '/v1/sessions/start', { token: g4, body: { set_version_id: '00000000-0000-0000-0000-0000000000ff', mode: 'practice', timer_type: 'untimed' } });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error.code).toBe('NOT_FOUND');
    expect(noPractice.body.error.message).toBe(ghost.body.error.message);
    expect(noPractice.raw).not.toContain(GRADE5);           // no grade id leaked
    expect(noPractice.raw).not.toContain('SET_NOT_PUBLISHED'); // 404 precedes the published gate
    expect(noPractice.raw.toLowerCase()).not.toContain('grade');
  });
});
