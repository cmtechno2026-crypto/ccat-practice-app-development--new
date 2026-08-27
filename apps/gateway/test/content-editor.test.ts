import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// CONTENT editor (Google-Forms-style authoring): batch "add one or many" into a set/battery, exam
// batteries = the 3 CCAT categories (scope-aware author preserves the other two), publish validates
// every card and auto-approves+publishes the authored draft questions with the set.

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const VERBAL = 'b0000000-0000-0000-0000-000000000001';
const VERBAL_SUB = 'b1000000-0000-0000-0000-000000000001';
const EASY = 'c0000000-0000-0000-0000-000000000001';
// Reuse the quantitative category/subcategory the harness already seeds (setup.ts). Creating a second
// 'quantitative' category collided on the unique key (on-conflict no-op) then FK-failed the
// subcategory insert — so point at the seeded ids instead.
const QUANT = 'b0000000-0000-0000-0000-000000000002'; // seeded by setup.ts
const QUANT_SUB = 'b1000000-0000-0000-0000-000000000002';

let app: FastifyInstance;
let db: pg.Client;
async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });

// One authored card, valid by default; override to make it invalid.
const card = (i: number, over: any = {}, cat = VERBAL, sub = VERBAL_SUB) => ({
  category_id: cat, subcategory_id: sub, grade_id: GRADE5, difficulty_id: EASY, question_type: 'verbal_analogy',
  prompt_blocks: [{ type: 'text', value: `Q${i}: Cat is to Kitten as Dog is to?` }],
  option_blocks: [
    { option_id: 'a', content: [{ type: 'text', value: 'Puppy' }] },
    { option_id: 'b', content: [{ type: 'text', value: 'Cub' }] },
  ],
  correct_option_ids: ['a'], active: true, ...over,
});

let su = '', ce = '', sup = '';
beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  su = (await login('super@cm.ca')).body.access_token;
  ce = (await login('content@cm.ca')).body.access_token; // content editor (create/edit/publish)
  sup = (await login('support@cm.ca')).body.access_token; // no content perms
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect(); await db.query('set search_path = ccat, public');
  await db.query(`insert into ccat.categories(id,key,name) values ($1,'quantitative','Quantitative') on conflict do nothing`, [QUANT]);
  await db.query(`insert into ccat.subcategories(id,category_id,key,name) values ($1,$2,'ns','Number Series') on conflict do nothing`, [QUANT_SUB, QUANT]);
});
afterAll(async () => { await app.close(); await db.end(); });

const newSet = async (over: any = {}) => {
  const r = await j('POST', '/v1/admin/content/sets', { token: su, body: {
    name: 'Editor Test Set', grade_id: GRADE5, category_id: VERBAL, subcategory_id: VERBAL_SUB, difficulty_id: EASY,
    allowed_practice: true, allowed_exam: false, question_version_ids: [], ...over } });
  return r.body.set_version_id as string;
};

describe('CONTENT editor — batch author + publish', () => {
  it('adds MANY questions in one pass, then publishes (auto-approving the questions)', async () => {
    const id = await newSet();
    // Support (no content perms) is denied the author endpoint.
    expect((await j('POST', `/v1/admin/content/sets/${id}/author`, { token: sup, body: { questions: [card(1)] } })).status).toBe(403);

    // One save of 5 cards.
    const authored = await j('POST', `/v1/admin/content/sets/${id}/author`, { token: su, body: { questions: [1, 2, 3, 4, 5].map((i) => card(i)) } });
    expect(authored.status).toBe(200);
    expect(authored.body.question_count).toBe(5);
    // All are draft until the set publishes.
    const draftStates = (await db.query(`select distinct qv.state from ccat.question_versions qv join ccat.set_version_questions svq on svq.question_version_id=qv.id where svq.set_version_id=$1`, [id])).rows.map((r) => r.state);
    expect(draftStates).toEqual(['draft']);

    // Publish → set live AND member questions auto-promoted to published (immutable).
    const pub = await j('POST', `/v1/admin/content/sets/${id}/publish`, { token: su });
    expect(pub.status).toBe(200);
    const states = (await db.query(`select distinct qv.state from ccat.question_versions qv join ccat.set_version_questions svq on svq.question_version_id=qv.id where svq.set_version_id=$1`, [id])).rows.map((r) => r.state);
    expect(states).toEqual(['published']);
    // Audit records the question promotions.
    const promoted = Number((await db.query(`select count(*) c from ccat.audit_log where event_type='content.published' and target_kind='question_version' and new_value->>'via'='set_publish'`)).rows[0].c);
    expect(promoted).toBeGreaterThanOrEqual(5);
  });

  it('blocks publish when a card is invalid (empty stem)', async () => {
    const id = await newSet();
    await j('POST', `/v1/admin/content/sets/${id}/author`, { token: su, body: { questions: [
      card(1), card(2), card(3), card(4), card(5, { prompt_blocks: [{ type: 'text', value: '' }] }),
    ] } });
    const pub = await j('POST', `/v1/admin/content/sets/${id}/publish`, { token: su });
    expect(pub.status).toBe(422);
    expect(pub.body.error?.message || pub.body.message).toMatch(/stem/i);
  });

  it('rejects an answer key that does not reference an option', async () => {
    const id = await newSet();
    const r = await j('POST', `/v1/admin/content/sets/${id}/author`, { token: su, body: { questions: [card(1, { correct_option_ids: ['zzz'] })] } });
    expect(r.status).toBe(422);
  });

  it('scope_category_id authors one battery without wiping the others (exam paper)', async () => {
    const id = await newSet({ allowed_exam: true, allowed_practice: false, duration_minutes: 30 });
    // Verbal battery: 3 questions.
    await j('POST', `/v1/admin/content/sets/${id}/author`, { token: su, body: { scope_category_id: VERBAL, questions: [card(1), card(2), card(3)] } });
    // Quantitative battery: 2 questions — must NOT remove the verbal ones.
    await j('POST', `/v1/admin/content/sets/${id}/author`, { token: su, body: { scope_category_id: QUANT, questions: [card(4, {}, QUANT, QUANT_SUB), card(5, {}, QUANT, QUANT_SUB)] } });
    const detail = await j('GET', `/v1/admin/content/sets/${id}`, { token: su });
    expect(detail.body.question_count).toBe(5);
    const byCat = detail.body.questions.reduce((m: any, q: any) => { m[q.category_key] = (m[q.category_key] || 0) + 1; return m; }, {});
    expect(byCat.verbal).toBe(3);
    expect(byCat.quantitative).toBe(2);
    // Re-authoring the verbal battery replaces only verbal, keeps quantitative.
    await j('POST', `/v1/admin/content/sets/${id}/author`, { token: su, body: { scope_category_id: VERBAL, questions: [card(6)] } });
    const d2 = await j('GET', `/v1/admin/content/sets/${id}`, { token: su });
    const byCat2 = d2.body.questions.reduce((m: any, q: any) => { m[q.category_key] = (m[q.category_key] || 0) + 1; return m; }, {});
    expect(byCat2.verbal).toBe(1);
    expect(byCat2.quantitative).toBe(2);
  });
});
