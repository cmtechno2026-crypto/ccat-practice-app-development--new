import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// GAM-2: achievement editor (name + XP/coin rewards) and theme editor (name + palette).
let app: FastifyInstance; let db: ReturnType<typeof createPool>;
async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
let su = '';
beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); db = createPool(process.env.DATABASE_URL!); su = (await login('super@cm.ca')).body.access_token; });
afterAll(async () => { await app.close(); await db.end(); });

describe('achievement & theme editors (GAM-2)', () => {
  it('edits an achievement name and its XP/coin rewards (replace semantics)', async () => {
    const list = await j('GET', '/v1/admin/rewards/achievements', { token: su });
    const a = list.body.items[0];
    const vid = a.version_id;
    expect((await j('PATCH', `/v1/admin/rewards/achievements/versions/${vid}`, { token: su, body: { name: 'Renamed Ach', xp: 75, coins: 10 } })).status).toBe(200);
    let after = (await j('GET', '/v1/admin/rewards/achievements', { token: su })).body.items.find((x: any) => x.version_id === vid);
    expect(after.name).toBe('Renamed Ach');
    expect(after.rewards.find((r: any) => r.kind === 'xp')?.xp).toBe(75);
    expect(after.rewards.find((r: any) => r.kind === 'coins')?.coins).toBe(10);
    // setting xp to 0 removes the xp reward
    expect((await j('PATCH', `/v1/admin/rewards/achievements/versions/${vid}`, { token: su, body: { xp: 0 } })).status).toBe(200);
    after = (await j('GET', '/v1/admin/rewards/achievements', { token: su })).body.items.find((x: any) => x.version_id === vid);
    expect(after.rewards.find((r: any) => r.kind === 'xp')).toBeUndefined();
  });

  it('edits a theme name and palette', async () => {
    const themes = (await j('GET', '/v1/admin/rewards/themes', { token: su })).body.items;
    const t = themes[0];
    expect((await j('PATCH', `/v1/admin/rewards/themes/${t.id}`, { token: su, body: { name: 'Midnight', palette: { background: '#0B1020', accent: '#7AA2F7' } } })).status).toBe(200);
    const after = (await j('GET', '/v1/admin/rewards/themes', { token: su })).body.items.find((x: any) => x.id === t.id);
    expect(after.name).toBe('Midnight');
    expect(after.palette.background).toBe('#0B1020');
    expect(after.palette.accent).toBe('#7AA2F7');
  });

  it('RBAC: achievement edit needs achievement.manage; theme edit needs theme.manage', async () => {
    const sup = (await login('support@cm.ca')).body.access_token; // has neither
    const vid = (await j('GET', '/v1/admin/rewards/achievements', { token: su })).body.items[0].version_id;
    const tid = (await j('GET', '/v1/admin/rewards/themes', { token: su })).body.items[0].id;
    expect((await j('PATCH', `/v1/admin/rewards/achievements/versions/${vid}`, { token: sup, body: { name: 'x' } })).status).toBe(403);
    expect((await j('PATCH', `/v1/admin/rewards/themes/${tid}`, { token: sup, body: { name: 'x' } })).status).toBe(403);
  });
});
