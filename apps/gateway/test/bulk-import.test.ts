import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Scoped bulk import (POST /v1/admin/content/import): each row names its scope (grade + battery +
// category + difficulty) by NAME; the gateway resolves names -> ids against the live taxonomy, groups
// good rows by scope into DRAFT practice sets (split at the 20-question cap), and rejects rows it can't
// place (with reasons). RBAC content.create; answer keys stay server-side; nothing publishes.
// The harness seeds: grade 5, battery Verbal (category "Analogies"/key 'an'), difficulty Easy.

let app: FastifyInstance;
let db: pg.Client;
async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
const q = (grade: number, battery: string, category: string, difficulty: string, stem: string, extra: any = {}) =>
  ({ grade, battery, category, difficulty, stem, options: [{ text: 'A', correct: true }, { text: 'B', correct: false }], ...extra });

let su = '', sup = '';
beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  su = (await login('super@cm.ca')).body.access_token;
  sup = (await login('support@cm.ca')).body.access_token; // no content.create
  db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); await db.query('set search_path = ccat, public');
});
afterAll(async () => { await app.close(); await db.end(); });

describe('scoped bulk import', () => {
  it('forbids an admin without content.create', async () => {
    const r = await j('POST', '/v1/admin/content/import', { token: sup, body: { rows: [q(5, 'Verbal', 'Analogies', 'Easy', 'x')] } });
    expect(r.status).toBe(403);
  });

  it('imports valid rows into a DRAFT practice set with the resolved scope + server-side answer key', async () => {
    const rows = [
      q(5, 'Verbal', 'Analogies', 'Easy', 'Import Q1'),
      q(5, 'Verbal', 'Analogies', 'Easy', 'Import Q2', { explanation: 'because' }),
    ];
    const r = await j('POST', '/v1/admin/content/import', { token: su, body: { rows } });
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(2);
    expect(r.body.sets.length).toBe(1);           // same scope → one set
    expect(r.body.rejected.length).toBe(0);
    const svId = r.body.sets[0].set_version_id;

    const set = (await db.query(
      `select sv.state, sv.allowed_practice, sv.allowed_exam, sv.question_count,
              c.key battery, s.key category, g.grade_number grade, d.key difficulty
         from ccat.question_set_versions sv
         join ccat.question_sets qs on qs.id = sv.question_set_id
         join ccat.categories c on c.id = qs.category_id
         join ccat.subcategories s on s.id = qs.subcategory_id
         join ccat.grades g on g.id = qs.grade_id
         join ccat.difficulties d on d.id = sv.difficulty_id
        where sv.id = $1`, [svId])).rows[0];
    expect(set.state).toBe('draft');             // nothing publishes on import
    expect(set.allowed_practice).toBe(true);
    expect(set.allowed_exam).toBe(false);
    expect(Number(set.question_count)).toBe(2);
    expect(set.battery).toBe('verbal');
    expect(set.category).toBe('an');
    expect(Number(set.grade)).toBe(5);
    expect(set.difficulty).toBe('easy');

    // answer keys stored server-side on each member question
    const keys = (await db.query(
      `select qv.correct_option_ids, qv.state from ccat.question_versions qv
         join ccat.set_version_questions svq on svq.question_version_id = qv.id
        where svq.set_version_id = $1`, [svId])).rows;
    expect(keys.length).toBe(2);
    expect(keys.every((k: any) => k.state === 'draft' && Array.isArray(k.correct_option_ids) && k.correct_option_ids.length >= 1)).toBe(true);
  });

  it('is replay-safe: importing the same normalized rows again creates no duplicate records', async () => {
    const rows = [
      q(5, 'Verbal', 'Analogies', 'Easy', 'Replay-safe Q1'),
      q(5, 'Verbal', 'Analogies', 'Easy', 'Replay-safe Q2'),
    ];
    const first = await j('POST', '/v1/admin/content/import', { token: su, body: { rows } });
    expect(first.body.imported).toBe(2);
    const second = await j('POST', '/v1/admin/content/import', { token: su, body: { rows } });
    expect(second.status).toBe(200);
    expect(second.body.imported).toBe(0);
    expect(second.body.sets).toEqual([]);
    expect(second.body.rejected).toHaveLength(2);
    expect(second.body.rejected.every((x: any) => x.reasons.join(' ').match(/already imported/i))).toBe(true);
  });

  it('rejects rows with unresolvable scope and imports the rest (reasons returned, nothing silent)', async () => {
    const rows = [
      q(5, 'Klingon', 'Analogies', 'Easy', 'bad battery'),
      q(5, 'Verbal', 'NoSuchTopic', 'Easy', 'bad category'),
      q(5, 'Verbal', 'Analogies', 'Easy', 'good one'),
    ];
    const r = await j('POST', '/v1/admin/content/import', { token: su, body: { rows } });
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(1);
    expect(r.body.rejected.map((x: any) => x.index).sort()).toEqual([0, 1]);
    expect(r.body.rejected.find((x: any) => x.index === 0).reasons.join(' ')).toMatch(/battery/i);
    expect(r.body.rejected.find((x: any) => x.index === 1).reasons.join(' ')).toMatch(/category/i);
  });

  it('splits a scope of >20 questions into multiple ≤20 draft sets (set-size cap)', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => q(5, 'Verbal', 'Analogies', 'Easy', `Split Q${i + 1}`));
    const r = await j('POST', '/v1/admin/content/import', { token: su, body: { rows } });
    expect(r.body.imported).toBe(21);
    expect(r.body.sets.length).toBe(2);
    const counts = r.body.sets.map((s: any) => s.question_count).sort((a: number, b: number) => b - a);
    expect(counts).toEqual([20, 1]);
  });
});
