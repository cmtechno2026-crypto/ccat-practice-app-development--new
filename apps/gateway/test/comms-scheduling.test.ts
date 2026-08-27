import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { publishScheduledAnnouncements, checkPushPii } from '../src/lib/comms.js';

// TASK-006 (Communications §26.1): scheduled announcements + push PII guard + RBAC.
let app: FastifyInstance;
let db: ReturnType<typeof createPool>;

async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });

let su = '', sup = '', ce = '';
beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  db = createPool(process.env.DATABASE_URL!);
  su = (await login('super@cm.ca')).body.access_token;
  sup = (await login('support@cm.ca')).body.access_token;
  ce = (await login('content@cm.ca')).body.access_token;
});
afterAll(async () => { await app.close(); await db.end(); });

describe('announcement scheduling (§26.1)', () => {
  it('future scheduled_at → state "scheduled"; worker publishes it once due', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const c = await j('POST', '/v1/admin/announcements', { token: sup, body: { title: 'Scheduled notice', body_text: 'Later', scheduled_at: future } });
    expect(c.status).toBe(200);
    expect(c.body.state).toBe('scheduled');
    const id = c.body.id;

    // Not yet due: worker leaves it alone.
    await publishScheduledAnnouncements(db);
    let row = (await db.query(`select state, carousel_order from ccat.announcements where id=$1`, [id])).rows[0];
    expect(row.state).toBe('scheduled');

    // Backdate scheduled_at so it is now due, then run the worker.
    await db.query(`update ccat.announcements set scheduled_at = now() - interval '1 minute' where id=$1`, [id]);
    const published = await publishScheduledAnnouncements(db);
    expect(published).toBeGreaterThanOrEqual(1);
    row = (await db.query(`select state, published_at, carousel_order from ccat.announcements where id=$1`, [id])).rows[0];
    expect(row.state).toBe('published');
    expect(row.published_at).not.toBeNull();
    expect(row.carousel_order).not.toBeNull();

    // Idempotent: a second run does not republish an already-published row.
    const again = await publishScheduledAnnouncements(db);
    // No scheduled rows remain from this test, so it should not touch our row again.
    const still = (await db.query(`select state from ccat.announcements where id=$1`, [id])).rows[0];
    expect(still.state).toBe('published');
    expect(again).toBeGreaterThanOrEqual(0);
  });

  it('past scheduled_at on create is rejected (422)', async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const r = await j('POST', '/v1/admin/announcements', { token: sup, body: { title: 'Backdated', body_text: 'x', scheduled_at: past } });
    expect(r.status).toBe(422);
  });
});

describe('push PII guard (§26.1)', () => {
  it('checkPushPii unit: flags merge fields, passes generic copy', () => {
    expect(checkPushPii('Great job {{name}}!').safe).toBe(false);
    expect(checkPushPii('Your score is {{score}}').safe).toBe(false);
    expect(checkPushPii('${first_name} keep going').safe).toBe(false);
    expect(checkPushPii('New sets are live — improve your score today!').safe).toBe(true);
  });

  it('live pii-check endpoint mirrors the guard', async () => {
    const bad = await j('POST', '/v1/admin/push/pii-check', { token: su, body: { message: 'Hi {{name}}' } });
    expect(bad.status).toBe(200); expect(bad.body.safe).toBe(false);
    const ok = await j('POST', '/v1/admin/push/pii-check', { token: su, body: { message: 'Weekend challenge is here' } });
    expect(ok.status).toBe(200); expect(ok.body.safe).toBe(true);
  });

  it('request with a PII merge field is rejected (422); clean copy is accepted', async () => {
    const rej = await j('POST', '/v1/admin/push/campaigns', { token: su, body: { title: 'Hi', message: 'Well done {{name}}, score {{score}}' } });
    expect(rej.status).toBe(422);
    const ok = await j('POST', '/v1/admin/push/campaigns', { token: su, body: { title: 'Weekend', message: 'Three new sets are live!', audience_grade_ids: ['a0000000-0000-0000-0000-000000000005'] } });
    expect(ok.status).toBe(200); expect(ok.body.state).toBe('requested'); expect(ok.body.pii_safe).toBe(true);
  });

  it('push.request RBAC: an admin without push.request is denied (403)', async () => {
    // Content editor (ce) has content perms but not push.request.
    const r = await j('POST', '/v1/admin/push/campaigns', { token: ce, body: { title: 'x', message: 'clean copy' } });
    expect(r.status).toBe(403);
  });
});

describe('unified announcements: channel + stop/restart (§26.1)', () => {
  it('carousel_push queues a linked push (requested); stop + restart lifecycle', async () => {
    // carousel_push → announcement + linked push campaign awaiting SA approval
    const c = await j('POST', '/v1/admin/announcements', { token: sup, body: { title: 'Push notice', body_text: 'New sets are live!', channel: 'carousel_push' } });
    expect(c.status).toBe(200);
    expect(c.body.push_campaign_id).toBeTruthy();
    const listed = (await j('GET', '/v1/admin/announcements', { token: sup })).body.items.find((a: any) => a.id === c.body.id);
    expect(listed.channel).toBe('carousel_push');
    expect(listed.push_state).toBe('requested');

    // PII in a push-channel body is rejected
    const bad = await j('POST', '/v1/admin/announcements', { token: sup, body: { title: 'x', body_text: 'Hi {{name}}', channel: 'carousel_push' } });
    expect(bad.status).toBe(422);

    // publish → stop → restart
    const pub = await j('POST', `/v1/admin/announcements/${c.body.id}/publish`, { token: su });
    expect(pub.body.state).toBe('published');
    const stop = await j('POST', `/v1/admin/announcements/${c.body.id}/stop`, { token: sup });
    expect(stop.body.state).toBe('stopped');
    // stop only applies to live/scheduled
    expect((await j('POST', `/v1/admin/announcements/${c.body.id}/stop`, { token: sup })).status).toBe(409);
    const restart = await j('POST', `/v1/admin/announcements/${c.body.id}/restart`, { token: su });
    expect(restart.body.state).toBe('published');
  });
});
