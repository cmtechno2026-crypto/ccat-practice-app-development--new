import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Content FIX 2 — exam papers. Runtime scaffold: a grade with no exam papers gets exactly 3 empty
// draft "Exam Paper A/B/C", attributed to the calling admin; idempotent (re-run creates nothing while
// papers exist); RBAC content.create. (The demo-removal is migration 0024, verified separately.)

// A dedicated grade for this file so parallel suites sharing the test DB can't add exam sets to it.
const GRADEX = 'a0000000-0000-0000-0000-0000000000e9';
let app: FastifyInstance;
let db: pg.Client;
async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
const num = async (sql: string, p: any[] = []) => Number((await db.query(sql, p)).rows[0].c);

let su = '', sup = '', suId = '';
beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  su = (await login('super@cm.ca')).body.access_token;
  sup = (await login('support@cm.ca')).body.access_token;
  suId = (await j('GET', '/v1/admin/me', { token: su })).body.id;
  db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); await db.query('set search_path = ccat, public');
  await db.query(`insert into ccat.grades(id,grade_number,name,age_min_years,age_max_years) values ($1,99,'Test Grade X',8,14) on conflict do nothing`, [GRADEX]);
  // A DEMO/seed exam paper under GRADEX (created_by NULL, published, practice+exam) — the thing the
  // demo-removal migration clears. Everything here is ISOLATED to GRADEX so we never mutate shared
  // grade-5 fixtures (e.g. SETV) that other test files depend on as exam sets.
  const demoSet = 'a0000000-0000-0000-0000-0000000000f1';
  await db.query(`insert into ccat.question_sets(id,grade_id,category_id,subcategory_id,name,created_by)
    values ($1,$2,'b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','Demo Exam X',null) on conflict do nothing`, [demoSet, GRADEX]);
  await db.query(`insert into ccat.question_set_versions(id,question_set_id,version_number,difficulty_id,question_count,allowed_practice,allowed_exam,state,published_at)
    values ('a0000000-0000-0000-0000-0000000000f2',$1,1,'c0000000-0000-0000-0000-000000000001',5,true,true,'published',now()) on conflict do nothing`, [demoSet]);
  // Simulate migration 0024's demo-clear, SCOPED to GRADEX. Bypass the published-immutability trigger
  // exactly as the (fixed) migration does: disable/enable the trigger (owner-privileged; portable).
  await db.query('alter table ccat.question_set_versions disable trigger set_version_immutable');
  await db.query(`update ccat.question_set_versions sv set allowed_exam=false from ccat.question_sets qs
    where qs.id=sv.question_set_id and qs.created_by is null and sv.allowed_exam=true and sv.allowed_practice=true and qs.grade_id=$1`, [GRADEX]);
  await db.query('alter table ccat.question_set_versions enable trigger set_version_immutable');
});
afterAll(async () => { await app.close(); await db.end(); });

describe('exam scaffold (runtime) + demo removal', () => {
  it('demo (created_by NULL) sets are no longer exam papers but survive as practice', async () => {
    // Scoped to GRADEX (this file's isolated grade): the demo exam paper was cleared (no longer exam)
    // yet still exists as practice content.
    expect(await num(`select count(*) c from ccat.question_set_versions sv join ccat.question_sets qs on qs.id=sv.question_set_id where qs.created_by is null and sv.allowed_exam=true and qs.grade_id=$1`, [GRADEX])).toBe(0);
    expect(await num(`select count(*) c from ccat.question_set_versions sv join ccat.question_sets qs on qs.id=sv.question_set_id where qs.created_by is null and sv.allowed_practice=true and qs.grade_id=$1`, [GRADEX])).toBeGreaterThan(0);
  });

  it('scaffolds exactly 3 empty draft exam papers for a grade with none', async () => {
    expect(await num(`select count(*) c from ccat.question_set_versions sv join ccat.question_sets qs on qs.id=sv.question_set_id where qs.grade_id=$1 and sv.allowed_exam=true`, [GRADEX])).toBe(0);
    // support lacks content.create → forbidden
    expect((await j('POST', '/v1/admin/content/exam-papers/scaffold', { token: sup, body: { grade_id: GRADEX } })).status).toBe(403);
    const r = await j('POST', '/v1/admin/content/exam-papers/scaffold', { token: su, body: { grade_id: GRADEX } });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(3);
    const papers = (await db.query(`select qs.name, sv.state, sv.question_count, qs.created_by from ccat.question_set_versions sv
      join ccat.question_sets qs on qs.id=sv.question_set_id where qs.grade_id=$1 and sv.allowed_exam=true order by qs.name`, [GRADEX])).rows;
    expect(papers.map((p: any) => p.name)).toEqual(['Exam Paper A', 'Exam Paper B', 'Exam Paper C']);
    for (const p of papers) { expect(p.state).toBe('draft'); expect(Number(p.question_count)).toBe(0); expect(p.created_by).toBe(suId); }
  });

  it('is idempotent — a second scaffold creates nothing', async () => {
    const r = await j('POST', '/v1/admin/content/exam-papers/scaffold', { token: su, body: { grade_id: GRADEX } });
    expect(r.body.created).toBe(0);
    expect(await num(`select count(*) c from ccat.question_set_versions sv join ccat.question_sets qs on qs.id=sv.question_set_id where qs.grade_id=$1 and sv.allowed_exam=true`, [GRADEX])).toBe(3);
  });

  it('a scaffolded paper opens as a real editable exam set (3 batteries via categories)', async () => {
    const paper = (await db.query(`select sv.id from ccat.question_set_versions sv join ccat.question_sets qs on qs.id=sv.question_set_id where qs.grade_id=$1 and sv.allowed_exam=true order by qs.name limit 1`, [GRADEX])).rows[0];
    const detail = await j('GET', `/v1/admin/content/sets/${paper.id}`, { token: su });
    expect(detail.status).toBe(200);
    expect(detail.body.allowed_exam).toBe(true);
    expect(Array.isArray(detail.body.questions)).toBe(true);
    expect(detail.body.category_id).toBeTruthy(); // linkage data present for the editor
  });
});
