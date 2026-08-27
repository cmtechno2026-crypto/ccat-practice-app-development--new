import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// GAM-1: avatar stage art. Uploading persists a real content_asset and attaches it to the stage;
// Assets are reachable by content.create OR avatar.manage; avatar stage art is set via manual upload.
let app: FastifyInstance; let db: ReturnType<typeof createPool>;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
let su = '';
const SUP_ID = 'a9000000-0000-0000-0000-000000000002';
const SUPER_ID = 'a9000000-0000-0000-0000-000000000001';

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); db = createPool(process.env.DATABASE_URL!); su = (await login('super@cm.ca')).body.access_token; });
afterAll(async () => { await app.close(); await db.end(); });

describe('avatar stage art (GAM-1)', () => {
  it('upload persists an asset and attaches to a stage; GET reflects it', async () => {
    const up = await j('POST', '/v1/admin/content/assets', { token: su, body: { mime_type: 'image/png', data_base64: PNG, alt_text: 'stage art' } });
    expect(up.status).toBe(200);
    const assetId = up.body.id;
    const row = await db.query('select 1 from ccat.content_assets where id=$1', [assetId]);
    expect(row.rows.length).toBe(1);

    // pick an existing stage and attach the asset
    const avatars = await j('GET', '/v1/admin/rewards/avatars', { token: su });
    const stage = avatars.body.items.flatMap((f: any) => f.stages).find((s: any) => s && s.id);
    expect(stage).toBeTruthy();
    const p = await j('PATCH', `/v1/admin/rewards/avatars/stages/${stage.id}`, { token: su, body: { asset_id: assetId } });
    expect(p.status).toBe(200);
    const after = await j('GET', '/v1/admin/rewards/avatars', { token: su });
    const stage2 = after.body.items.flatMap((f: any) => f.stages).find((s: any) => s && s.id === stage.id);
    expect(stage2.asset_id).toBe(assetId);
  });

  it('the removed AI art-generation endpoint is gone (manual upload only)', async () => {
    const r = await j('POST', '/v1/admin/content/assets/ai-generate', { token: su, body: { prompt: 'a friendly fox avatar' } });
    expect(r.status).toBe(404); // no AI seam; stage art is set by uploading an image
  });

  it('RBAC: assets need content.create OR avatar.manage', async () => {
    // support has neither → 403
    const sup = (await login('support@cm.ca')).body.access_token;
    const denied = await j('POST', '/v1/admin/content/assets', { token: sup, body: { mime_type: 'image/png', data_base64: PNG } });
    expect(denied.status).toBe(403);
    // grant avatar.manage → now allowed (proves the OR path, not just content.create)
    await db.query(`insert into ccat.admin_permissions(admin_id,permission_key,granted_by) values ($1,'avatar.manage',$2) on conflict do nothing`, [SUP_ID, SUPER_ID]);
    const sup2 = (await login('support@cm.ca')).body.access_token;
    const allowed = await j('POST', '/v1/admin/content/assets', { token: sup2, body: { mime_type: 'image/png', data_base64: PNG } });
    expect(allowed.status).toBe(200);
  });
});
