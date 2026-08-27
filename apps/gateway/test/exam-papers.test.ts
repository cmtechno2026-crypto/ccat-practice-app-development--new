import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// CONTENT-2: exam papers = allowed_exam sets with a timed duration and questions spanning the three
// sections (categories). Empty drafts allowed; publish still enforces ≥5 (§18).
let app: FastifyInstance; let db: ReturnType<typeof createPool>;
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const CAT_VERBAL = 'b0000000-0000-0000-0000-000000000001';
const SUB_AN = 'b1000000-0000-0000-0000-000000000001';
const DIFF_EASY = 'c0000000-0000-0000-0000-000000000001';

async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
let su = '';
// Insert N published Verbal questions for Grade 5 and return their version ids.
async function makeQuestions(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const lq = await db.query(`insert into ccat.logical_questions(category_id,subcategory_id) values ($1,$2) returning id`, [CAT_VERBAL, SUB_AN]);
    const qv = await db.query(
      `insert into ccat.question_versions(logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state,published_at)
       values ($1,1,$2,$3,'analogy',$4,$5,'{o1}','published',now()) returning id`,
      [lq.rows[0]!.id, GRADE5, DIFF_EASY,
       JSON.stringify([{ type: 'text', value: `Exam Q${i} :: ?` }]),
       JSON.stringify([{ option_id: 'o1', content: [{ type: 'text', value: 'A' }] }, { option_id: 'o2', content: [{ type: 'text', value: 'B' }] }])]);
    ids.push(qv.rows[0]!.id);
  }
  return ids;
}

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); db = createPool(process.env.DATABASE_URL!); su = (await login('super@cm.ca')).body.access_token; });
afterAll(async () => { await app.close(); await db.end(); });

describe('exam papers (CONTENT-2)', () => {
  it('create empty paper + duration, add sections, publish gate ≥5', async () => {
    // Empty exam paper with a duration (previously blocked by the 5..20 hard bound).
    const c = await j('POST', '/v1/admin/content/sets', { token: su, body: {
      name: 'Form Z', grade_id: GRADE5, category_id: CAT_VERBAL, subcategory_id: SUB_AN,
      allowed_practice: false, allowed_exam: true, allowed_timers: ['timed'], question_version_ids: [], duration_minutes: 30 } });
    expect(c.status).toBe(200);
    const id = c.body.set_version_id;

    // Detail reflects exam + duration + zero questions.
    let d = await j('GET', `/v1/admin/content/sets/${id}`, { token: su });
    expect(d.body.allowed_exam).toBe(true);
    expect(d.body.duration_minutes).toBe(30);
    expect(d.body.questions.length).toBe(0);

    // Patch duration (1..180 bound).
    expect((await j('PATCH', `/v1/admin/content/sets/${id}`, { token: su, body: { duration_minutes: 45 } })).status).toBe(200);
    expect((await j('PATCH', `/v1/admin/content/sets/${id}`, { token: su, body: { duration_minutes: 999 } })).status).toBe(422);
    d = await j('GET', `/v1/admin/content/sets/${id}`, { token: su });
    expect(d.body.duration_minutes).toBe(45);

    // Add 3 questions → still below publish minimum.
    const q3 = await makeQuestions(3);
    expect((await j('POST', `/v1/admin/content/sets/${id}/questions`, { token: su, body: { question_version_ids: q3 } })).status).toBe(200);
    d = await j('GET', `/v1/admin/content/sets/${id}`, { token: su });
    expect(d.body.questions.length).toBe(3);
    expect(d.body.questions[0].category_key).toBe('verbal'); // grouped by section (category)
    // Publish with <5 is refused.
    expect((await j('POST', `/v1/admin/content/sets/${id}/publish`, { token: su })).status).toBe(422);

    // Top up to 5 and publish succeeds.
    const q2 = await makeQuestions(2);
    expect((await j('POST', `/v1/admin/content/sets/${id}/questions`, { token: su, body: { question_version_ids: [...q3, ...q2] } })).status).toBe(200);
    const pub = await j('POST', `/v1/admin/content/sets/${id}/publish`, { token: su });
    expect(pub.status).toBe(200);
    expect(pub.body.state).toBe('published');
  });

  it('RBAC: an admin without content.create cannot create an exam paper', async () => {
    const sup = (await login('support@cm.ca')).body.access_token;
    const r = await j('POST', '/v1/admin/content/sets', { token: sup, body: {
      name: 'Nope', grade_id: GRADE5, category_id: CAT_VERBAL, subcategory_id: SUB_AN, allowed_exam: true, question_version_ids: [] } });
    expect(r.status).toBe(403);
  });
});
