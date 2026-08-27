import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const SETV = 'e1000000-0000-0000-0000-000000000001';

let app: FastifyInstance;

async function json(method: string, url: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await app.inject({
    method: method as any,
    url,
    payload: opts.body as any,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  let parsed: any = null;
  try { parsed = res.json(); } catch { /* empty */ }
  return { status: res.statusCode, body: parsed };
}

// Full registration → login helper. Returns tokens.
async function registerAndLogin(username: string, deviceHash: string) {
  const contact = await json('POST', '/v1/registration/contact/start', {
    body: { guardian_name: 'Guardian', email: `${username}@guardian.test`, phone: '+14165551234' },
  });
  expect(contact.status).toBe(200);
  const consent = await json('POST', '/v1/registration/consent', {
    body: { registration_grant: contact.body.registration_grant, policy_version: 'v1', consent_hash: 'abc123' },
  });
  expect(consent.status).toBe(201);
  const student = await json('POST', '/v1/registration/student', {
    body: {
      registration_grant: consent.body.registration_grant,
      display_name: 'Test Kid', username, grade_id: GRADE5,
      birth_month: 6, birth_year: 2016, pin: '1234', device_hash: deviceHash,
    },
  });
  expect(student.status).toBe(201);
  const login = await json('POST', '/v1/auth/login', {
    body: { username, pin: '1234', device_hash: deviceHash },
  });
  expect(login.status).toBe(200);
  return { studentId: student.body.id, age: student.body.age_years, tokens: login.body };
}

beforeAll(async () => {
  app = await buildApp(loadConfig());
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe('health & catalog', () => {
  it('liveness + readiness', async () => {
    expect((await json('GET', '/health/live')).status).toBe(200);
    expect((await json('GET', '/health/ready')).status).toBe(200);
  });
  it('grades are data-driven', async () => {
    const g = await json('GET', '/v1/grades');
    expect(g.status).toBe(200);
    expect(g.body.some((x: any) => x.grade_number === 5)).toBe(true);
  });
});

describe('registration + identity', () => {
  it('registers a child, computes age, logs in, returns profile', async () => {
    const { age, tokens } = await registerAndLogin('kid_one', 'device-A');
    // 2026 - 2016, birthday month 6 -> depends on run month; assert plausible range.
    expect(age).toBeGreaterThanOrEqual(9);
    expect(age).toBeLessThanOrEqual(10);
    const profile = await json('GET', '/v1/profile', { token: tokens.access_token });
    expect(profile.status).toBe(200);
    expect(profile.body.username).toBe('kid_one');
    expect(typeof profile.body.age_years).toBe('number');
  });

  it('rejects duplicate username', async () => {
    await registerAndLogin('dupe_kid', 'device-D');
    // second registration with same username is rejected with a friendly 422 USERNAME_TAKEN
    const start = await json('POST', '/v1/registration/contact/start', { body: { guardian_name: 'Guardian', email: 'x@guardian.test', phone: '+14165551234' } });
    const consent = await json('POST', '/v1/registration/consent', { body: { registration_grant: start.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
    const student = await json('POST', '/v1/registration/student', {
      body: { registration_grant: consent.body.registration_grant, display_name: 'D', username: 'dupe_kid', grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: 'device-D2' },
    });
    expect(student.status).toBe(422);
    expect(student.body.error.code).toBe('USERNAME_TAKEN');
  });

  it('rejects login from a non-enrolled device (single-device, §5)', async () => {
    await registerAndLogin('kid_two', 'device-B');
    const bad = await json('POST', '/v1/auth/login', { body: { username: 'kid_two', pin: '1234', device_hash: 'device-OTHER' } });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('DEVICE_NOT_ENROLLED');
  });

  it('rejects wrong PIN', async () => {
    await registerAndLogin('kid_pin', 'device-P');
    const bad = await json('POST', '/v1/auth/login', { body: { username: 'kid_pin', pin: '9999', device_hash: 'device-P' } });
    expect(bad.status).toBe(401);
  });
});

describe('sessions: one-active + exactly-once', () => {
  it('starts a session, blocks a second, submits exactly-once', async () => {
    const { tokens } = await registerAndLogin('kid_sess', 'device-S');
    const t = tokens.access_token;

    const s1 = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    expect(s1.status).toBe(201);
    const sessionId = s1.body.id;

    // Second start while active → ACTIVE_SESSION_EXISTS
    const s2 = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    expect(s2.status).toBe(409);
    expect(s2.body.error.code).toBe('ACTIVE_SESSION_EXISTS');

    // Submit
    const sub1 = await json('POST', `/v1/sessions/${sessionId}/submit`, {
      token: t, headers: { 'idempotency-key': 'idem-1' },
      body: { submission_id: 'idem-1', expected_session_version: s1.body.session_version },
    });
    expect(sub1.status).toBe(200);
    expect(sub1.body.terminal_state).toBe('SUBMITTED');

    // Idempotent replay: same submission_id → same result, no reprocess
    const sub2 = await json('POST', `/v1/sessions/${sessionId}/submit`, {
      token: t, headers: { 'idempotency-key': 'idem-1' },
      body: { submission_id: 'idem-1', expected_session_version: s1.body.session_version },
    });
    expect(sub2.status).toBe(200);
    expect(sub2.body).toEqual(sub1.body);

    // After submit, a new session can start (previous is terminal)
    const s3 = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    expect(s3.status).toBe(201);

    // Result recovery endpoint
    const result = await json('GET', `/v1/sessions/${sessionId}/result`, { token: t });
    expect(result.status).toBe(200);
    expect(result.body.terminal_state).toBe('SUBMITTED');
  });

  it('unauthenticated session start is rejected', async () => {
    const r = await json('POST', '/v1/sessions/start', { body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    expect(r.status).toBe(401);
  });
});
