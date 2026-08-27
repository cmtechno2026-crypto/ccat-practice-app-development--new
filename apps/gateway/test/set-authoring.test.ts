import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// CONTENT-3: inline set authoring — per-question active toggle, per-set order policy (preserve_order),
// and publish counting only ACTIVE questions.
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

async function makeQuestions(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const lq = await db.query(`insert into ccat.logical_questions(category_id,subcategory_id) values ($1,$2) returning id`, [CAT_VERBAL, SUB_AN]);
    const qv = await db.query(
      `insert into ccat.question_versions(logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state,published_at)
       values ($1,1,$2,$3,'analogy',$4,$5,'{o1}','published',now()) returning id`,
      [lq.rows[0]!.id, GRADE5, DIFF_EASY,
       JSON.stringify([{ type: 'text', value: `SA Q${i} :: ?` }]),
       JSON.stringify([{ option_id: 'o1', content: [{ type: 'text', value: 'A' }] }, { option_id: 'o2', content: [{ type: 'text', value: 'B' }] }])]);
    ids.push(qv.rows[0]!.id);
  }
  return ids;
}
async function newSet(ids: string[]): Promise<string> {
  const c = await j('POST', '/v1/admin/content/sets', { token: su, body: {
    name: 'Authoring set', grade_id: GRADE5, category_id: CAT_VERBAL, subcategory_id: SUB_AN,
    allowed_practice: true, allowed_exam: false, question_version_ids: ids } });
  expect(c.status).toBe(200);
  return c.body.set_version_id;
}

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); db = createPool(process.env.DATABASE_URL!); su = (await login('super@cm.ca')).body.access_token; });
afterAll(async () => { await app.close(); await db.end(); });

describe('inline set authoring (CONTENT-3)', () => {
  it('order policy: toggle preserve_order on a draft, blocked once published', async () => {
    const q5 = await makeQuestions(5);
    const id = await newSet(q5);
    // default fixed / by authoring order (true) — owner decision, migration 0028_order_default_fixed
    let d = await j('GET', `/v1/admin/content/sets/${id}`, { token: su });
    expect(d.body.preserve_order).toBe(true);
    // toggle to shuffled on the draft
    expect((await j('PATCH', `/v1/admin/content/sets/${id}`, { token: su, body: { preserve_order: false } })).status).toBe(200);
    d = await j('GET', `/v1/admin/content/sets/${id}`, { token: su });
    expect(d.body.preserve_order).toBe(false);
    // publish, then order changes are refused (immutable)
    expect((await j('POST', `/v1/admin/content/sets/${id}/publish`, { token: su })).status).toBe(200);
    expect((await j('PATCH', `/v1/admin/content/sets/${id}`, { token: su, body: { preserve_order: false } })).status).toBe(422);
  });

  it('active toggle: inactive questions do not count toward the publish minimum', async () => {
    const q5 = await makeQuestions(5);
    const id = await newSet(q5);
    // deactivate one → 4 active
    expect((await j('PATCH', `/v1/admin/content/sets/${id}/questions/${q5[0]}`, { token: su, body: { active: false } })).status).toBe(200);
    let d = await j('GET', `/v1/admin/content/sets/${id}`, { token: su });
    expect(d.body.questions.find((x: any) => x.id === q5[0]).active).toBe(false);
    // publish refused with only 4 active
    expect((await j('POST', `/v1/admin/content/sets/${id}/publish`, { token: su })).status).toBe(422);
    // reactivate → 5 active → publish ok
    expect((await j('PATCH', `/v1/admin/content/sets/${id}/questions/${q5[0]}`, { token: su, body: { active: true } })).status).toBe(200);
    expect((await j('POST', `/v1/admin/content/sets/${id}/publish`, { token: su })).status).toBe(200);
  });

  it('membership edits preserve a question’s inactive flag', async () => {
    const q6 = await makeQuestions(6);
    const id = await newSet(q6.slice(0, 5));
    // deactivate q6[0], then change membership (add q6[5])
    expect((await j('PATCH', `/v1/admin/content/sets/${id}/questions/${q6[0]}`, { token: su, body: { active: false } })).status).toBe(200);
    expect((await j('POST', `/v1/admin/content/sets/${id}/questions`, { token: su, body: { question_version_ids: q6 } })).status).toBe(200);
    const d = await j('GET', `/v1/admin/content/sets/${id}`, { token: su });
    expect(d.body.questions.find((x: any) => x.id === q6[0]).active).toBe(false); // still inactive
    expect(d.body.questions.find((x: any) => x.id === q6[5]).active).toBe(true);  // new one active
  });

  it('RBAC: an admin without content.create cannot toggle active', async () => {
    const q5 = await makeQuestions(5);
    const id = await newSet(q5);
    const sup = (await login('support@cm.ca')).body.access_token;
    const r = await j('PATCH', `/v1/admin/content/sets/${id}/questions/${q5[0]}`, { token: sup, body: { active: false } });
    expect(r.status).toBe(403);
  });
});
