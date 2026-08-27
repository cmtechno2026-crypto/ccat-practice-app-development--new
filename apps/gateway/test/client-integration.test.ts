import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
// Drive the SHARED api-client (the one the Expo app / Admin Web use) against a real listening
// Gateway over HTTP. Proves the client wiring end-to-end, not just server internals.
import { CcatClient, MemoryTokenStore, ApiError } from '../../../packages/api-client/src/index.js';

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const SETV = 'e1000000-0000-0000-0000-000000000001';
const QV = 'd1000000-0000-0000-0000-000000000001';

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});
afterAll(async () => { await app.close(); });

describe('api-client ↔ Gateway (HTTP)', () => {
  it('runs the full student flow through the client', async () => {
    const client = new CcatClient({ baseUrl, tokens: new MemoryTokenStore() });

    // health + catalog
    expect((await client.health()).status).toBe('ready');
    const grades = await client.grades();
    expect(grades.some((g) => g.grade_number === 5)).toBe(true);

    // registration (unified guardian contact — validate-only, no OTP)
    const contact = await client.registrationContact({ guardianName: 'Client Guardian', email: 'client@guardian.test', phone: '+14165551234' });
    const consent = await client.registrationConsent(contact.registration_grant, 'v1', 'hash');
    const profile = await client.registrationStudent({
      registration_grant: consent.registration_grant, display_name: 'Client Kid', username: 'client_kid',
      grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: 'client-dev',
    });
    expect(profile.username).toBe('client_kid');
    expect(typeof profile.age_years).toBe('number');

    // login (client stores tokens)
    await client.login('client_kid', '1234', 'client-dev');

    // home data
    const me = await client.profile();
    expect(me.username).toBe('client_kid');
    expect((await client.rewardsSummary()).xp_total).toBe(0);
    expect((await client.readiness()).insufficient_data).toBe(true);

    // catalog lists the published set for the student's grade
    const catalog = await client.catalog();
    expect(catalog.some((c) => c.set_version_id === SETV)).toBe(true);
    expect(catalog[0]!.allowed_modes.length).toBeGreaterThan(0);

    // play a session: start → fetch questions → answer correctly → submit
    const session = await client.sessionStart(SETV, 'practice', 'untimed');
    const withQ = await client.getSession(session.id);
    expect(withQ.questions.length).toBeGreaterThan(0);
    expect(withQ.questions[0]!.question_version_id).toBe(QV);
    await client.saveAnswers(session.id, [{ question_version_id: QV, selected_option_ids: ['o1'], answer_version: 1 }]);
    const result = await client.submit(session.id, 'client-sub-1', session.session_version);
    expect(result.terminal_state).toBe('SUBMITTED');
    expect(result.score_correct).toBe(1);
    expect(result.xp_awarded).toBe(10);

    // rewards reflect the win: 10 base + 25 first-completion achievement
    expect((await client.rewardsSummary()).xp_total).toBe(35);

    // idempotent replay through the client
    const replay = await client.submit(session.id, 'client-sub-1', session.session_version);
    expect(replay).toEqual(result);
  });

  it('surfaces structured ApiError for a bad login', async () => {
    const client = new CcatClient({ baseUrl });
    await expect(client.login('nobody', '0000', 'x')).rejects.toBeInstanceOf(ApiError);
    try { await client.login('nobody', '0000', 'x'); } catch (e) {
      expect((e as ApiError).status).toBe(401);
    }
  });
});
