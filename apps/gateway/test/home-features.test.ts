import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const SETV = 'e1000000-0000-0000-0000-000000000001';
const QV = 'd1000000-0000-0000-0000-000000000001';
const LQ = 'd0000000-0000-0000-0000-000000000001'; // logical question id for QV

let app: FastifyInstance;
async function json(method: string, url: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) } });
  let parsed: any = null; try { parsed = res.json(); } catch {}
  return { status: res.statusCode, body: parsed };
}
async function registerAndLogin(username: string, deviceHash: string) {
  const s = await json('POST', '/v1/registration/contact/start', { body: { guardian_name: 'Guardian', email: `${username}@g.test`, phone: '+14165551234' } });
  const c = await json('POST', '/v1/registration/consent', { body: { registration_grant: s.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  await json('POST', '/v1/registration/student', { body: { registration_grant: c.body.registration_grant, display_name: 'K', username, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: deviceHash } });
  const l = await json('POST', '/v1/auth/login', { body: { username, pin: '1234', device_hash: deviceHash } });
  return l.body.access_token as string;
}

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); });
afterAll(async () => { await app.close(); });

describe('bookmarks (§32.4)', () => {
  it('add, list (with preview), remove', async () => {
    const t = await registerAndLogin('bm_kid', 'bm-dev');
    expect((await json('GET', '/v1/bookmarks', { token: t })).body).toEqual([]);

    const add = await json('PUT', '/v1/bookmarks', { token: t, body: { logical_question_id: LQ, note: 'tricky' } });
    expect(add.status).toBe(200);

    const list = await json('GET', '/v1/bookmarks', { token: t });
    expect(list.body.length).toBe(1);
    expect(list.body[0].logical_question_id).toBe(LQ);
    expect(list.body[0].note).toBe('tricky');
    expect(list.body[0].preview.length).toBeGreaterThan(0);

    const del = await json('DELETE', `/v1/bookmarks?logical_question_id=${LQ}`, { token: t });
    expect(del.status).toBe(204);
    expect((await json('GET', '/v1/bookmarks', { token: t })).body).toEqual([]);
  });

  it('rejects bookmarking a non-existent question', async () => {
    const t = await registerAndLogin('bm_bad', 'bm-dev2');
    const r = await json('PUT', '/v1/bookmarks', { token: t, body: { logical_question_id: '00000000-0000-0000-0000-000000000000' } });
    expect(r.status).toBe(404);
  });
});

describe('achievements (§19.4, §32.5)', () => {
  it('lists definitions and grants on submit with atomic rewards', async () => {
    const t = await registerAndLogin('ach_kid', 'ach-dev');

    // Before playing: the seeded achievements are listed, none earned yet for this student.
    const before = await json('GET', '/v1/achievements', { token: t });
    expect(before.body.length).toBeGreaterThanOrEqual(2); // shared DB may hold admin-created ones
    expect(before.body.every((a: any) => a.earned === false)).toBe(true);

    // Play a perfect set → unlocks both first_set and perfectionist.
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    await json('PATCH', `/v1/sessions/${s.body.id}/answers`, { token: t, body: { answers: [{ question_version_id: QV, selected_option_ids: ['o1'], answer_version: 1 }] } });
    const sub = await json('POST', `/v1/sessions/${s.body.id}/submit`, { token: t, body: { submission_id: 'ach-sub-1', expected_session_version: s.body.session_version } });
    expect(sub.status).toBe(200);
    const keys = (sub.body.achievements_unlocked ?? []).map((a: any) => a.key).sort();
    expect(keys).toEqual(['first_set', 'perfectionist']);

    // Rewards applied atomically: base XP 10 (easy) + achievement XP 25 = 35; coins 5.
    const rw = await json('GET', '/v1/rewards/summary', { token: t });
    expect(rw.body.xp_total).toBe(35);
    expect(rw.body.coin_balance).toBe(5);

    // Now listed as earned.
    const after = await json('GET', '/v1/achievements', { token: t });
    expect(after.body.filter((a: any) => a.earned).length).toBe(2);
  });

  it('does not double-grant on idempotent resubmit', async () => {
    const t = await registerAndLogin('ach_idem', 'ach-dev2');
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    await json('PATCH', `/v1/sessions/${s.body.id}/answers`, { token: t, body: { answers: [{ question_version_id: QV, selected_option_ids: ['o1'], answer_version: 1 }] } });
    await json('POST', `/v1/sessions/${s.body.id}/submit`, { token: t, body: { submission_id: 'idem', expected_session_version: s.body.session_version } });
    const replay = await json('POST', `/v1/sessions/${s.body.id}/submit`, { token: t, body: { submission_id: 'idem', expected_session_version: s.body.session_version } });
    expect(replay.status).toBe(200);
    const rw = await json('GET', '/v1/rewards/summary', { token: t });
    expect(rw.body.xp_total).toBe(35); // not doubled
    expect(rw.body.coin_balance).toBe(5);
  });
});
