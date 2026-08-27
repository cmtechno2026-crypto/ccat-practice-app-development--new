import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Verifies the AI service, endpoints, and flag were removed. The manual replacements (question editor,
// batch author, CSV import that feeds it, image upload) are covered by content-editor.test.ts and
// gam-avatar-art.test.ts — this file only proves the AI surface is gone.

let app: FastifyInstance;
async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });

let su = '';
beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); su = (await login('super@cm.ca')).body.access_token; });
afterAll(async () => { await app.close(); });

describe('AI surface removed', () => {
  it('the three AI endpoints no longer exist (404)', async () => {
    expect((await j('GET', '/v1/admin/content/ai/status', { token: su })).status).toBe(404);
    expect((await j('POST', '/v1/admin/content/ai/import-questions', { token: su, body: { grade: 5, category: 'verbal', count: 5 } })).status).toBe(404);
    expect((await j('POST', '/v1/admin/content/assets/ai-generate', { token: su, body: { prompt: 'x' } })).status).toBe(404);
  });

  it('the ai_import_enabled flag is gone from the flag catalog', async () => {
    const flags = await j('GET', '/v1/admin/config/flags', { token: su });
    const keys = (flags.body.items || []).map((f: any) => f.key);
    expect(keys).not.toContain('ai_import_enabled');
    // Rejecting the removed key proves nothing can toggle it back on.
    expect((await j('POST', '/v1/admin/config/flags', { token: su, body: { key: 'ai_import_enabled', value: true } })).status).toBe(422);
  });

  it('the health console no longer lists an AI provider dependency', async () => {
    const h = await j('GET', '/v1/admin/health', { token: su });
    const deps = JSON.stringify(h.body?.dependencies ?? h.body ?? {});
    expect(deps.toLowerCase()).not.toContain('ai question import');
  });
});
