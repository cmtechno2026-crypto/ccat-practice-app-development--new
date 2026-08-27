import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { finalizeOverdueSessions } from '../src/lib/finalize.js';

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const SETV = 'e1000000-0000-0000-0000-000000000001';
const QV = 'd1000000-0000-0000-0000-000000000001'; // correct option is o1

let app: FastifyInstance;

async function json(method: string, url: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await app.inject({
    method: method as any, url, payload: opts.body as any,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
  });
  let parsed: any = null; try { parsed = res.json(); } catch { /* */ }
  return { status: res.statusCode, body: parsed };
}

async function registerAndLogin(username: string, deviceHash: string) {
  const contact = await json('POST', '/v1/registration/contact/start', { body: { guardian_name: 'Guardian', email: `${username}@g.test`, phone: '+14165551234' } });
  const consent = await json('POST', '/v1/registration/consent', { body: { registration_grant: contact.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  const student = await json('POST', '/v1/registration/student', {
    body: { registration_grant: consent.body.registration_grant, display_name: 'K', username, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: deviceHash },
  });
  expect(student.status).toBe(201);
  const login = await json('POST', '/v1/auth/login', { body: { username, pin: '1234', device_hash: deviceHash } });
  expect(login.status).toBe(200);
  return { studentId: student.body.id, tokens: login.body };
}

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); });
afterAll(async () => { await app.close(); });

describe('answers autosave + real scoring', () => {
  it('saves versioned answers, rejects stale, scores correctly, awards XP', async () => {
    const { tokens } = await registerAndLogin('lc_score', 'dev-lc1');
    const t = tokens.access_token;
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    const id = s.body.id;

    // Save a correct answer (option o1)
    const a1 = await json('PATCH', `/v1/sessions/${id}/answers`, { token: t, body: { answers: [{ question_version_id: QV, selected_option_ids: ['o1'], answer_version: 1 }] } });
    expect(a1.status).toBe(200);
    expect(a1.body[0].accepted_version).toBe(1);

    // Stale write (version 1 again) rejected
    const stale = await json('PATCH', `/v1/sessions/${id}/answers`, { token: t, body: { answers: [{ question_version_id: QV, selected_option_ids: ['o2'], answer_version: 1 }] } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_ANSWER');

    // Newer version accepted
    const a2 = await json('PATCH', `/v1/sessions/${id}/answers`, { token: t, body: { answers: [{ question_version_id: QV, selected_option_ids: ['o1'], answer_version: 2 }] } });
    expect(a2.status).toBe(200);

    // Submit → real score: 1/1 correct, easy XP = 10
    const sub = await json('POST', `/v1/sessions/${id}/submit`, { token: t, body: { submission_id: 'lc-sub-1', expected_session_version: s.body.session_version } });
    expect(sub.status).toBe(200);
    expect(sub.body.score_correct).toBe(1);
    expect(sub.body.score_total).toBe(1);
    expect(sub.body.xp_awarded).toBe(10);

    // Rewards summary reflects the ledger: 10 base (easy, correct) + 25 first-completion achievement
    const rw = await json('GET', '/v1/rewards/summary', { token: t });
    expect(rw.body.xp_total).toBe(35);

    // Readiness: only 1 answer < min threshold → insufficient_data (never 0%)
    const rd = await json('GET', '/v1/readiness', { token: t });
    expect(rd.body.insufficient_data).toBe(true);
    expect(rd.body.readiness_pct).toBeNull();
  });

  it('an incorrect answer scores zero XP', async () => {
    const { tokens } = await registerAndLogin('lc_wrong', 'dev-lc2');
    const t = tokens.access_token;
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    await json('PATCH', `/v1/sessions/${s.body.id}/answers`, { token: t, body: { answers: [{ question_version_id: QV, selected_option_ids: ['o2'], answer_version: 1 }] } });
    const sub = await json('POST', `/v1/sessions/${s.body.id}/submit`, { token: t, body: { submission_id: 'lc-sub-2', expected_session_version: s.body.session_version } });
    expect(sub.body.score_correct).toBe(0);
    expect(sub.body.xp_awarded).toBe(0);
  });
});

describe('timed session auto-finalization (§14)', () => {
  it('worker auto-submits an overdue timed session; deadline guard blocks late answers', async () => {
    const { tokens } = await registerAndLogin('lc_timed', 'dev-lc3');
    const t = tokens.access_token;
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'exam', timer_type: 'timed', duration_seconds: 1 } });
    const id = s.body.id;
    await new Promise((r) => setTimeout(r, 1200)); // let the deadline pass

    // Late answer write is rejected (and finalizes the session)
    const late = await json('PATCH', `/v1/sessions/${id}/answers`, { token: t, body: { answers: [{ question_version_id: QV, selected_option_ids: ['o1'], answer_version: 1 }] } });
    expect([409]).toContain(late.status);
    expect(late.body.error.code).toBe('DEADLINE_PASSED');

    const result = await json('GET', `/v1/sessions/${id}/result`, { token: t });
    expect(result.status).toBe(200);
    expect(result.body.terminal_state).toBe('AUTO_SUBMITTED');
  });

  it('the overdue worker finalizes independently', async () => {
    const { tokens } = await registerAndLogin('lc_worker', 'dev-lc4');
    const t = tokens.access_token;
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'exam', timer_type: 'timed', duration_seconds: 1 } });
    await new Promise((r) => setTimeout(r, 1200));
    const pool = createPool(process.env.DATABASE_URL!);
    const n = await finalizeOverdueSessions(pool);
    expect(n).toBeGreaterThanOrEqual(1);
    await pool.end();
    const result = await json('GET', `/v1/sessions/${s.body.id}/result`, { token: t });
    expect(result.body.terminal_state).toBe('AUTO_SUBMITTED');
  });
});

describe('device replacement (§5.2)', () => {
  it('revokes the old device + session and enrolls the new sole device', async () => {
    const { tokens } = await registerAndLogin('lc_dev', 'dev-old');
    const oldToken = tokens.access_token;
    // old token works now
    expect((await json('GET', '/v1/profile', { token: oldToken })).status).toBe(200);

    const start = await json('POST', '/v1/devices/replacement/start', { body: { username: 'lc_dev', new_device_hash: 'dev-new', channel: 'email' } });
    expect(start.status).toBe(202);
    const verify = await json('POST', '/v1/devices/replacement/verify', { body: { challenge_id: start.body.challenge_id, code: start.body._dev_code } });
    expect(verify.status).toBe(200);
    const newToken = verify.body.access_token;

    // old token now rejected (session + device revoked)
    expect((await json('GET', '/v1/profile', { token: oldToken })).status).toBe(401);
    // new token works
    expect((await json('GET', '/v1/profile', { token: newToken })).status).toBe(200);
    // login on old device now rejected
    const oldLogin = await json('POST', '/v1/auth/login', { body: { username: 'lc_dev', pin: '1234', device_hash: 'dev-old' } });
    expect(oldLogin.status).toBe(403);
    // login on new device works
    const newLogin = await json('POST', '/v1/auth/login', { body: { username: 'lc_dev', pin: '1234', device_hash: 'dev-new' } });
    expect(newLogin.status).toBe(200);
  });
});

describe('PIN recovery (§4.4)', () => {
  it('resets PIN via guardian OTP and revokes existing sessions', async () => {
    const { tokens } = await registerAndLogin('lc_pin', 'dev-pin');
    const oldToken = tokens.access_token;
    const start = await json('POST', '/v1/recovery/pin/start', { body: { username: 'lc_pin', channel: 'email' } });
    expect(start.status).toBe(202);
    const done = await json('POST', '/v1/recovery/pin/complete', { body: { challenge_id: start.body.challenge_id, code: start.body._dev_code, new_pin: '5678' } });
    expect(done.status).toBe(200);

    // existing session revoked
    expect((await json('GET', '/v1/profile', { token: oldToken })).status).toBe(401);
    // old PIN rejected, new PIN works (same enrolled device)
    expect((await json('POST', '/v1/auth/login', { body: { username: 'lc_pin', pin: '1234', device_hash: 'dev-pin' } })).status).toBe(401);
    expect((await json('POST', '/v1/auth/login', { body: { username: 'lc_pin', pin: '5678', device_hash: 'dev-pin' } })).status).toBe(200);
  });
});
