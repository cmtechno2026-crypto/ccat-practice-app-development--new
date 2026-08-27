import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// ADMIN → WEBSITE control + access boundary.
//  (A) CONTROL: an admin toggles the per-client channel flag; the public /v1/channel-status contract
//      (which any client reads) reflects it immediately, with no redeploy.
//  (B) BOUNDARY: RLS denies the browser-reachable anon/authenticated roles ALL direct table access;
//      only the least-privilege ccat_gateway role (the gateway's own DB path) can read.

let app: FastifyInstance;
let db: pg.Client;

async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });

let su = '', sup = '';
beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  su = (await login('super@cm.ca')).body.access_token;
  sup = (await login('support@cm.ca')).body.access_token;
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect(); await db.query('set search_path = ccat, public');
});
afterAll(async () => { await app.close(); await db.end(); });

// Set a flag to a known value via the admin endpoint (also the real control path). The test DB is
// shared across files in the full suite, so each test establishes its own preconditions rather than
// relying on defaults.
const setFlag = (key: string, value: boolean) => j('POST', '/v1/admin/config/flags', { token: su, body: { key, value } });

describe('CONTROL — per-client channel enable flag', () => {
  it('public /v1/channel-status is unauthenticated and reflects both channels enabled', async () => {
    await setFlag('maintenance_mode', false);
    await setFlag('channel_web_enabled', true);
    await setFlag('channel_app_enabled', true);
    const r = await j('GET', '/v1/channel-status');
    expect(r.status).toBe(200);
    expect(r.body.channels.web.enabled).toBe(true);
    expect(r.body.channels.app.enabled).toBe(true);
    expect(r.body.channels.web.message).toBeNull();
  });

  it('an admin toggle of the website channel is reflected on the public contract with no redeploy', async () => {
    await setFlag('maintenance_mode', false);
    await setFlag('channel_app_enabled', true);
    // support lacks flags.emergency (Super-Admin only) → forbidden.
    expect((await j('POST', '/v1/admin/config/flags', { token: sup, body: { key: 'channel_web_enabled', value: false } })).status).toBe(403);

    // Super turns the website channel OFF.
    const set = await j('POST', '/v1/admin/config/flags', { token: su, body: { key: 'channel_web_enabled', value: false, reason: 'test' } });
    expect(set.status).toBe(200);

    // The public contract reflects it immediately; the app channel is untouched.
    const after = await j('GET', '/v1/channel-status');
    expect(after.body.channels.web.enabled).toBe(false);
    expect(after.body.channels.web.message).toMatch(/unavailable/i);
    expect(after.body.channels.app.enabled).toBe(true);

    // The change is audited.
    const audited = Number((await db.query(`select count(*) c from ccat.audit_log where event_type='flag.changed' and new_value->>'key'='channel_web_enabled'`)).rows[0].c);
    expect(audited).toBeGreaterThan(0);

    // Turn it back on.
    await j('POST', '/v1/admin/config/flags', { token: su, body: { key: 'channel_web_enabled', value: true } });
    expect((await j('GET', '/v1/channel-status')).body.channels.web.enabled).toBe(true);
  });

  it('maintenance_mode disables every channel with a maintenance message', async () => {
    await j('POST', '/v1/admin/config/flags', { token: su, body: { key: 'maintenance_mode', value: true } });
    const r = await j('GET', '/v1/channel-status');
    expect(r.body.maintenance_mode).toBe(true);
    expect(r.body.channels.web.enabled).toBe(false);
    expect(r.body.channels.app.enabled).toBe(false);
    expect(r.body.channels.app.message).toMatch(/maintenance/i);
    await j('POST', '/v1/admin/config/flags', { token: su, body: { key: 'maintenance_mode', value: false } });
  });

  it('rejects unknown flag keys', async () => {
    expect((await j('POST', '/v1/admin/config/flags', { token: su, body: { key: 'not_a_real_flag', value: true } })).status).toBe(422);
  });
});

describe('BOUNDARY — RLS denies direct table access to browser-reachable roles', () => {
  const denied = async (role: string) => {
    let msg = '';
    try {
      await db.query(`set role ${role}`);
      await db.query('select 1 from ccat.grades limit 1');
    } catch (e) { msg = (e as Error).message; }
    finally { await db.query('reset role'); }
    return msg;
  };

  it('the anon role (website anon key) cannot read any ccat table', async () => {
    expect(await denied('anon')).toMatch(/permission denied/i);
  });

  it('the authenticated role (post-login Supabase JWT) cannot read any ccat table', async () => {
    expect(await denied('authenticated')).toMatch(/permission denied/i);
  });

  it('only the least-privilege ccat_gateway role can read (the gateway is the sole data path)', async () => {
    let ok = true, msg = '';
    try {
      await db.query('set role ccat_gateway');
      await db.query('select 1 from ccat.grades limit 1');
    } catch (e) { ok = false; msg = (e as Error).message; }
    finally { await db.query('reset role'); }
    expect(ok, msg).toBe(true);
  });
});
