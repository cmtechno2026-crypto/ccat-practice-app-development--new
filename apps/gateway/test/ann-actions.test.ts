import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// ANN-1: Duplicate, Run again (stopped/ended), Extend (ends_at), Reschedule (future scheduled_at).
let app: FastifyInstance; let db: ReturnType<typeof createPool>;
async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
let su = '';
const mkAnn = async (title: string) => (await j('POST', '/v1/admin/announcements', { token: su, body: { title, body_text: 'Hello families, a friendly update.', channel: 'carousel' } })).body;
const getAnn = async (id: string) => (await j('GET', '/v1/admin/announcements', { token: su })).body.items.find((a: any) => a.id === id);

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); db = createPool(process.env.DATABASE_URL!); su = (await login('super@cm.ca')).body.access_token; });
afterAll(async () => { await app.close(); await db.end(); });

describe('announcement actions (ANN-1)', () => {
  it('duplicate creates a fresh draft copy', async () => {
    const a = await mkAnn('Field Trip');
    const dup = await j('POST', `/v1/admin/announcements/${a.id}/duplicate`, { token: su });
    expect(dup.status).toBe(200);
    const copy = await getAnn(dup.body.id);
    expect(copy.title).toBe('Field Trip (copy)');
    expect(copy.state).toBe('draft');
  });

  it('extend sets a later ends_at on a live announcement', async () => {
    const a = await mkAnn('Extendable');
    await j('POST', `/v1/admin/announcements/${a.id}/publish`, { token: su });
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    expect((await j('PATCH', `/v1/admin/announcements/${a.id}`, { token: su, body: { ends_at: future } })).status).toBe(200);
    const after = await getAnn(a.id);
    expect(new Date(after.ends_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('reschedule a draft to a future time moves it to scheduled', async () => {
    const a = await mkAnn('Reschedulable');
    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    expect((await j('PATCH', `/v1/admin/announcements/${a.id}`, { token: su, body: { scheduled_at: future } })).status).toBe(200);
    expect((await getAnn(a.id)).state).toBe('scheduled');
    // past time is rejected
    expect((await j('PATCH', `/v1/admin/announcements/${a.id}`, { token: su, body: { scheduled_at: new Date(Date.now() - 1000).toISOString() } })).status).toBe(422);
  });

  it('run again re-publishes a stopped or ended announcement', async () => {
    const a = await mkAnn('Rerunnable');
    await j('POST', `/v1/admin/announcements/${a.id}/publish`, { token: su });
    await j('POST', `/v1/admin/announcements/${a.id}/stop`, { token: su });
    expect((await getAnn(a.id)).state).toBe('stopped');
    expect((await j('POST', `/v1/admin/announcements/${a.id}/restart`, { token: su })).status).toBe(200);
    expect((await getAnn(a.id)).state).toBe('published');
    // ended (archived) can also run again
    await j('POST', `/v1/admin/announcements/${a.id}/archive`, { token: su });
    expect((await getAnn(a.id)).state).toBe('archived');
    expect((await j('POST', `/v1/admin/announcements/${a.id}/restart`, { token: su })).status).toBe(200);
    expect((await getAnn(a.id)).state).toBe('published');
  });

  it('RBAC: duplicate and reschedule need announcement.manage', async () => {
    const a = await mkAnn('Guarded');
    const ce = (await login('content@cm.ca')).body.access_token; // no announcement.manage
    expect((await j('POST', `/v1/admin/announcements/${a.id}/duplicate`, { token: ce })).status).toBe(403);
    expect((await j('PATCH', `/v1/admin/announcements/${a.id}`, { token: ce, body: { ends_at: new Date(Date.now() + 1e6).toISOString() } })).status).toBe(403);
  });
});
