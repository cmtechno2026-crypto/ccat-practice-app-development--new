import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Practice per-question feedback endpoint. The seeded question QV has correct option 'o1' (Puppy),
// wrong 'o2' (Cub), and NO explanation authored → reveal.explanation must be null (graceful).
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const SETV = 'e1000000-0000-0000-0000-000000000001';
const QV = 'd1000000-0000-0000-0000-000000000001';

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
const attempt = (id: string, opt: string, t: string) =>
  json('POST', `/v1/practice/sessions/${id}/questions/${QV}/attempt`, { token: t, body: { selectedOptionId: opt } });

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); });
afterAll(async () => { await app.close(); });

describe('practice per-question feedback', () => {
  it('never leaks the answer key in the question payload', async () => {
    const t = await login('pf_leak', 'dev-pf1');
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    const q = await json('GET', `/v1/sessions/${s.body.id}`, { token: t });
    expect(q.raw).not.toContain('correct_option_ids');
    expect(q.raw).not.toContain('explanation');
  });

  it('correct on first attempt → correct + reveal, scores full XP at submit', async () => {
    const t = await login('pf_correct', 'dev-pf2');
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    const r = await attempt(s.body.id, 'o1', t);
    expect(r.status).toBe(200);
    expect(r.body.correct).toBe(true);
    expect(r.body.attemptsUsed).toBe(1);
    expect(r.body.revealed.correctOptionId).toBe('o1');
    expect(r.body.revealed.explanation).toBeNull(); // no authored explanation → graceful
    const sub = await json('POST', `/v1/sessions/${s.body.id}/submit`, { token: t, body: { submission_id: 'pf-c', expected_session_version: s.body.session_version } });
    expect(sub.body.score_correct).toBe(1);
    expect(sub.body.xp_awarded).toBe(10);
  });

  it('wrong → no reveal + retry; 2nd wrong → reveal (2-attempt cap); scores 0', async () => {
    const t = await login('pf_wrong', 'dev-pf3');
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    const r1 = await attempt(s.body.id, 'o2', t);
    expect(r1.body.correct).toBe(false);
    expect(r1.body.attemptsUsed).toBe(1);
    expect(r1.body.attemptsRemaining).toBe(1);
    expect(r1.body.revealed).toBeUndefined(); // no reveal before commit
    const r2 = await attempt(s.body.id, 'o2', t);
    expect(r2.body.correct).toBe(false);
    expect(r2.body.attemptsUsed).toBe(2);
    expect(r2.body.attemptsRemaining).toBe(0);
    expect(r2.body.revealed.correctOptionId).toBe('o1'); // revealed only after attempts used
    // locked: a 3rd attempt returns the revealed state, remaining 0
    const r3 = await attempt(s.body.id, 'o1', t);
    expect(r3.body.attemptsRemaining).toBe(0);
    expect(r3.body.revealed.correctOptionId).toBe('o1');
    const sub = await json('POST', `/v1/sessions/${s.body.id}/submit`, { token: t, body: { submission_id: 'pf-w', expected_session_version: s.body.session_version } });
    expect(sub.body.score_correct).toBe(0); // committed wrong answer → incorrect
  });

  it('exam sessions cannot call the practice-attempt endpoint', async () => {
    const t = await login('pf_exam', 'dev-pf4');
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'exam', timer_type: 'timed', duration_seconds: 600 } });
    const r = await attempt(s.body.id, 'o1', t);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('PRACTICE_ONLY');
  });
});
