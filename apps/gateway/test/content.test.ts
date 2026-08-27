import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const SETV = 'e1000000-0000-0000-0000-000000000001';
const BOOK = 'e6000000-0000-0000-0000-000000000001';

let app: FastifyInstance;
async function json(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let p: any = null; try { p = res.json(); } catch {}
  return { status: res.statusCode, body: p };
}
async function login(username: string, device: string) {
  const s = await json('POST', '/v1/registration/contact/start', { body: { guardian_name: 'Guardian', email: `${username}@g.test`, phone: '+14165551234' } });
  const c = await json('POST', '/v1/registration/consent', { body: { registration_grant: s.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  await json('POST', '/v1/registration/student', { body: { registration_grant: c.body.registration_grant, display_name: 'K', username, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: device } });
  return (await json('POST', '/v1/auth/login', { body: { username, pin: '1234', device_hash: device } })).body.access_token as string;
}

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); });
afterAll(async () => { await app.close(); });

describe('announcements + book store (§21, §26)', () => {
  it('lists the published announcement', async () => {
    const t = await login('cn_ann', 'cn-dev1');
    const a = await json('GET', '/v1/announcements', { token: t });
    expect(a.status).toBe(200);
    expect(a.body.some((x: any) => x.title === 'Welcome to CCAT!')).toBe(true);
  });

  it('adult gate: wrong answer blocked, correct answer returns allowlisted https url', async () => {
    const t = await login('cn_book', 'cn-dev2');
    const books = await json('GET', '/v1/books', { token: t });
    expect(books.body.some((b: any) => b.id === BOOK)).toBe(true);

    const ch = await json('POST', `/v1/books/${BOOK}/adult-challenge`, { token: t });
    expect(ch.body.prompt).toMatch(/What is \d+ \+ \d+/);
    const [, x, y] = ch.body.prompt.match(/What is (\d+) \+ (\d+)/)!;
    const answer = Number(x) + Number(y);

    const wrong = await json('POST', `/v1/books/${BOOK}/retailer-handoff`, { token: t, body: { challenge_token: ch.body.challenge_token, answer: String(answer + 1) } });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('ADULT_CHALLENGE_FAILED');

    const ok = await json('POST', `/v1/books/${BOOK}/retailer-handoff`, { token: t, body: { challenge_token: ch.body.challenge_token, answer: String(answer) } });
    expect(ok.status).toBe(200);
    expect(ok.body.destination_url).toMatch(/^https:\/\//);
  });

  it('server-shuffled session order is deterministic across fetches (§9.2)', async () => {
    const t = await login('cn_shuf', 'cn-dev3');
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' } });
    const a = await json('GET', `/v1/sessions/${s.body.id}`, { token: t });
    const b = await json('GET', `/v1/sessions/${s.body.id}`, { token: t });
    const orderA = a.body.questions.map((q: any) => q.question_version_id);
    const orderB = b.body.questions.map((q: any) => q.question_version_id);
    expect(orderA).toEqual(orderB); // stable per seed
    // options carry stable ids regardless of order
    expect(a.body.questions[0].option_blocks.every((o: any) => typeof o.option_id === 'string')).toBe(true);
  });
});
