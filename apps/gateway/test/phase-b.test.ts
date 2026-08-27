import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Phase B — exam 3-battery composite: per-question category on the session payload, a by-battery
// result breakdown, and the exam-history endpoint. Fixture: a 2-battery exam paper (Verbal +
// Quantitative), one question each.
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const EXAM = 'e1000000-0000-0000-0000-0000000000b2';

let app: FastifyInstance;
async function json(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let parsed: any = null; try { parsed = res.json(); } catch { /* */ }
  return { status: res.statusCode, body: parsed };
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

describe('Phase B — exam batteries', () => {
  it('session questions carry category; result + exam-history break down by battery', async () => {
    const t = await login('pb_exam', 'dev-pb1');
    const s = await json('POST', '/v1/sessions/start', { token: t, body: { set_version_id: EXAM, mode: 'exam', timer_type: 'timed', duration_seconds: 900 } });
    const g = await json('GET', `/v1/sessions/${s.body.id}`, { token: t });
    // two questions, spanning two categories (batteries)
    const cats = new Set(g.body.questions.map((q: any) => q.category_key));
    expect(cats.has('verbal')).toBe(true);
    expect(cats.has('quantitative')).toBe(true);
    // answer both correctly (silent exam autosave)
    const answers = g.body.questions.map((q: any) => ({ question_version_id: q.question_version_id, selected_option_ids: ['o1'], answer_version: 1 }));
    await json('PATCH', `/v1/sessions/${s.body.id}/answers`, { token: t, body: { answers } });
    const sub = await json('POST', `/v1/sessions/${s.body.id}/submit`, { token: t, body: { submission_id: 'pb-1', expected_session_version: s.body.session_version } });
    expect(sub.body.score_correct).toBe(2);
    // result by_battery: one row per category, each 1/1
    const r = await json('GET', `/v1/sessions/${s.body.id}/result`, { token: t });
    expect(r.body.attempted_count).toBe(2);
    expect(r.body.by_battery.length).toBe(2);
    for (const b of r.body.by_battery) { expect(b.total).toBe(1); expect(b.correct).toBe(1); }
    // exam history
    const h = await json('GET', '/v1/exams/history', { token: t });
    expect(h.body.length).toBe(1);
    expect(h.body[0].set_name).toBe('Mock Exam');
    expect(h.body[0].accuracy_pct).toBe(100);
    expect(h.body[0].by_battery.length).toBe(2);
    expect(['SUBMITTED', 'AUTO_SUBMITTED']).toContain(h.body[0].end_reason);
  });
});
