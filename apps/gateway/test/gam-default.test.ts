import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// GAM-3: exactly one theme is the brand default; make-default moves it atomically.
let app: FastifyInstance; let db: ReturnType<typeof createPool>;
async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
let su = '';
beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready(); db = createPool(process.env.DATABASE_URL!);
  su = (await login('super@cm.ca')).body.access_token;
  // ensure at least two themes exist
  const n = await db.query('select count(*)::int c from ccat.themes');
  if (n.rows[0]!.c < 2) {
    await db.query(`insert into ccat.themes(key,name,active) values ('t_a_'||floor(random()*1e9),'Theme A',true),('t_b_'||floor(random()*1e9),'Theme B',true)`);
  }
});
afterAll(async () => { await app.close(); await db.end(); });

describe('theme make-default (GAM-3)', () => {
  it('make-default is exclusive — moving it clears the previous default', async () => {
    const themes = (await j('GET', '/v1/admin/rewards/themes', { token: su })).body.items;
    const A = themes[0].id, B = themes[1].id;
    expect((await j('POST', `/v1/admin/rewards/themes/${A}/make-default`, { token: su })).status).toBe(200);
    let list = (await j('GET', '/v1/admin/rewards/themes', { token: su })).body.items;
    expect(list.filter((t: any) => t.is_default).length).toBe(1);
    expect(list.find((t: any) => t.id === A).is_default).toBe(true);
    // move it to B → A clears
    expect((await j('POST', `/v1/admin/rewards/themes/${B}/make-default`, { token: su })).status).toBe(200);
    list = (await j('GET', '/v1/admin/rewards/themes', { token: su })).body.items;
    expect(list.filter((t: any) => t.is_default).length).toBe(1);
    expect(list.find((t: any) => t.id === B).is_default).toBe(true);
    expect(list.find((t: any) => t.id === A).is_default).toBe(false);
  });

  it('RBAC: make-default needs theme.manage', async () => {
    const sup = (await login('support@cm.ca')).body.access_token;
    const tid = (await j('GET', '/v1/admin/rewards/themes', { token: su })).body.items[0].id;
    expect((await j('POST', `/v1/admin/rewards/themes/${tid}/make-default`, { token: sup })).status).toBe(403);
  });
});
