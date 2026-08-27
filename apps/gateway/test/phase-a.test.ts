import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Phase A backend-foundation additions (client-agnostic; front-end parity depends on these):
//  - GET /v1/sessions/:id now carries set metadata (set_name/subcategory/difficulty)
//  - GET /v1/sessions/:id/result now carries time_spent_seconds + timed_out
//  - GET /v1/catalog now carries per-set progress
//  - practice attempt accepts a multi-select set and grades by set-equality
//  - GET /v1/bookmarks/:lqid/review returns the full published question (answer revealed, owned-only)
//  - GET /v1/achievements now carries progress_pct + howto
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const SETV = 'e1000000-0000-0000-0000-000000000001';       // single-answer set (o1 correct)
const SETV_MULTI = 'e1000000-0000-0000-0000-0000000000e1'; // multi set (o1,o3 correct)
const QV_MULTI = 'd1000000-0000-0000-0000-0000000000e1';
const LQID = 'd0000000-0000-0000-0000-000000000001';       // bookmarkable logical question

let app: FastifyInstance;

async function json(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({
    method: method as any, url, payload: opts.body as any,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
  });
  let parsed: any = null; try { parsed = res.json(); } catch { /* */ }
  return { status: res.statusCode, body: parsed, raw: res.body };
}
async function login(username: string, deviceHash: string) {
  // Validate-only guardian contact (email + E.164 phone with country code; NO OTP).
  const c = await json('POST', '/v1/registration/contact/start', { body: { guardian_name: 'Guardian', email: `${username}@g.test`, phone: '+14165551234' } });
  const consent = await json('POST', '/v1/registration/consent', { body: { registration_grant: c.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  await json('POST', '/v1/registration/student', { body: { registration_grant: consent.body.registration_grant, display_name: 'K', username, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: deviceHash } });
  const l = await json('POST', '/v1/auth/login', { body: { username, pin: '1234', device_hash: deviceHash } });
  return l.body.access_token as string;
}

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); });
afterAll(async () => { await app.close(); });

describe('Phase A — session metadata + result timing', () => {
  it('GET session carries set metadata; result carries time + timed_out=false on manual submit', async () => {
    const t = await login('pa_meta', 'dev-pa1');
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    const g = await json('GET', `/v1/sessions/${s.body.id}`, { token: t });
    expect(g.body.set_name).toBe('Analogies 1');
    expect(g.body.subcategory).toBe('Analogies');
    expect(g.body.difficulty).toBe('easy');
    // answer + submit
    const qv = g.body.questions[0].question_version_id;
    await json('POST', `/v1/practice/sessions/${s.body.id}/questions/${qv}/attempt`, { token: t, body: { selectedOptionId: 'o1' } });
    await json('POST', `/v1/sessions/${s.body.id}/submit`, { token: t, body: { submission_id: 'pa-c', expected_session_version: s.body.session_version } });
    const r = await json('GET', `/v1/sessions/${s.body.id}/result`, { token: t });
    expect(r.body.timed_out).toBe(false);
    expect(typeof r.body.time_spent_seconds).toBe('number');
    expect(r.body.time_spent_seconds).toBeGreaterThanOrEqual(0);
  });
});

describe('Phase A — catalog per-set progress', () => {
  it('a set moves not_started → completed with score after a submit', async () => {
    const t = await login('pa_prog', 'dev-pa2');
    const before = await json('GET', '/v1/catalog', { token: t });
    const row0 = before.body.find((r: any) => r.set_version_id === SETV);
    expect(row0.progress.status).toBe('not_started');
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    const g = await json('GET', `/v1/sessions/${s.body.id}`, { token: t });
    const qv = g.body.questions[0].question_version_id;
    await json('POST', `/v1/practice/sessions/${s.body.id}/questions/${qv}/attempt`, { token: t, body: { selectedOptionId: 'o1' } });
    await json('POST', `/v1/sessions/${s.body.id}/submit`, { token: t, body: { submission_id: 'pa-p', expected_session_version: s.body.session_version } });
    const after = await json('GET', '/v1/catalog', { token: t });
    const row1 = after.body.find((r: any) => r.set_version_id === SETV);
    expect(row1.progress.status).toBe('completed');
    expect(row1.progress.score_correct).toBe(1);
    expect(row1.progress.score_total).toBe(1);
  });
});

describe('Phase A — multi-correct practice attempt (set-equality grading)', () => {
  it('partial pick is wrong; full correct set is correct and reveals all correct ids', async () => {
    const t = await login('pa_multi', 'dev-pa3');
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV_MULTI, mode: 'practice', timer_type: 'untimed' } });
    // first attempt: only one of the two correct → wrong, retry allowed
    const r1 = await json('POST', `/v1/practice/sessions/${s.body.id}/questions/${QV_MULTI}/attempt`, { token: t, body: { selectedOptionIds: ['o1'] } });
    expect(r1.body.correct).toBe(false);
    expect(r1.body.attemptsRemaining).toBe(1);
    expect(r1.body.revealed).toBeUndefined();
    // second attempt: full correct set → correct + reveal
    const r2 = await json('POST', `/v1/practice/sessions/${s.body.id}/questions/${QV_MULTI}/attempt`, { token: t, body: { selectedOptionIds: ['o3', 'o1'] } });
    expect(r2.body.correct).toBe(true);
    expect([...r2.body.revealed.correctOptionIds].sort()).toEqual(['o1', 'o3']);
  });
});

describe('Phase A — bookmark review (owned-only, answer revealed for study)', () => {
  it('returns the full question with correct_option_ids for an owned bookmark; 404 otherwise', async () => {
    const t = await login('pa_bm', 'dev-pa4');
    // not bookmarked yet → 404
    const miss = await json('GET', `/v1/bookmarks/${LQID}/review`, { token: t });
    expect(miss.status).toBe(404);
    // bookmark, then review reveals the answer key (study, not a graded attempt)
    await json('PUT', '/v1/bookmarks', { token: t, body: { logical_question_id: LQID } });
    const rev = await json('GET', `/v1/bookmarks/${LQID}/review`, { token: t });
    expect(rev.status).toBe(200);
    expect(rev.body.correct_option_ids).toContain('o1');
    expect(Array.isArray(rev.body.option_blocks)).toBe(true);
    expect(rev.body.subcategory).toBe('Analogies');
  });
});

describe('Phase A — achievements progress', () => {
  it('unearned achievements carry a numeric progress_pct and a howto hint', async () => {
    const t = await login('pa_ach', 'dev-pa5');
    const a = await json('GET', '/v1/achievements', { token: t });
    expect(Array.isArray(a.body)).toBe(true);
    for (const ach of a.body) {
      expect(typeof ach.progress_pct).toBe('number');
      expect(ach.progress_pct).toBeGreaterThanOrEqual(0);
      expect(ach.progress_pct).toBeLessThanOrEqual(100);
      expect(typeof ach.howto).toBe('string');
    }
  });
});
