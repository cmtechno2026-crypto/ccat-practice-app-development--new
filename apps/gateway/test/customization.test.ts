import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const SETV = 'e1000000-0000-0000-0000-000000000001';
const QV = 'd1000000-0000-0000-0000-000000000001';
const STAGE2 = 'c2100000-0000-0000-0000-000000000002'; // 20 XP
const STAGE3 = 'c2100000-0000-0000-0000-000000000003'; // 100 XP
const THEME_XP = 'c3000000-0000-0000-0000-000000000002'; // 30 XP

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
async function playSets(t: string, n: number) {
  // Each perfect set = 10 base + (first time) 25 achievement. We just need XP to accrue.
  for (let i = 0; i < n; i++) {
    const s = await json('POST', '/v1/sessions/start', { body: { set_version_id: SETV, mode: 'practice', timer_type: 'untimed' }, token: t });
    await json('PATCH', `/v1/sessions/${s.body.id}/answers`, { body: { answers: [{ question_version_id: QV, selected_option_ids: ['o1'], answer_version: 1 }] }, token: t });
    await json('POST', `/v1/sessions/${s.body.id}/submit`, { body: { submission_id: `sub-${i}`, expected_session_version: s.body.session_version }, token: t });
  }
}

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); });
afterAll(async () => { await app.close(); });

describe('avatars (§20.1)', () => {
  it('locks stages behind XP; unlocks and equips at threshold', async () => {
    const t = await login('av_kid', 'av-dev');
    // Fresh: stage 1 free/owned, stage 2 (20xp) and 3 (100xp) locked.
    const a0 = await json('GET', '/v1/avatars', { token: t });
    const stages = a0.body.families[0].stages;
    expect(stages.find((s: any) => s.stage_number === 1).owned).toBe(true);
    expect(stages.find((s: any) => s.stage_id === STAGE2).owned).toBe(false);

    // Equipping a locked stage is refused.
    const denied = await json('POST', '/v1/avatars/equip', { body: { avatar_stage_id: STAGE3 }, token: t });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('NOT_OWNED');

    // Earn XP (one perfect set = 10 + 25 first-completion = 35 ≥ 20) → stage 2 unlocks.
    await playSets(t, 1);
    const a1 = await json('GET', '/v1/avatars', { token: t });
    expect(a1.body.xp_total).toBeGreaterThanOrEqual(20);
    expect(a1.body.families[0].stages.find((s: any) => s.stage_id === STAGE2).owned).toBe(true);

    const equip = await json('POST', '/v1/avatars/equip', { body: { avatar_stage_id: STAGE2 }, token: t });
    expect(equip.status).toBe(200);
    expect(equip.body.active_avatar_stage_id).toBe(STAGE2);

    // Reflected in profile + marked active.
    const prof = await json('GET', '/v1/profile', { token: t });
    expect(prof.body.active_avatar_stage_id).toBe(STAGE2);
  });
});

describe('themes (§20.2)', () => {
  it('free theme equips; XP-gated theme unlocks after enough XP', async () => {
    const t = await login('th_kid', 'th-dev');
    const t0 = await json('GET', '/v1/themes', { token: t });
    const free = t0.body.find((x: any) => x.key === 'sky');
    const gated = t0.body.find((x: any) => x.id === THEME_XP);
    expect(free.owned).toBe(true);
    expect(gated.owned).toBe(false);

    // Free theme equips immediately.
    expect((await json('POST', '/v1/themes/equip', { body: { theme_id: free.id }, token: t })).status).toBe(200);

    // Gated (30 XP) refused before, allowed after earning.
    expect((await json('POST', '/v1/themes/equip', { body: { theme_id: THEME_XP }, token: t })).status).toBe(403);
    await playSets(t, 1); // ≥35 XP
    const eq = await json('POST', '/v1/themes/equip', { body: { theme_id: THEME_XP }, token: t });
    expect(eq.status).toBe(200);
    const prof = await json('GET', '/v1/profile', { token: t });
    expect(prof.body.active_theme_id).toBe(THEME_XP);
  });
});
