import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// Phase-3 polish: BOOKS-2 (retailer link `kind`) and AUDIT-1 (audit facets expose distinct actors).
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

describe('BOOKS-2: retailer link kind', () => {
  it('a buy link carries a format kind that round-trips', async () => {
    const book = (await j('POST', '/v1/admin/books', { token: su, body: { title: 'Kinded Book', retailer: 'Amazon', url: 'https://www.amazon.ca/dp/BKIND' } })).body;
    const link = await j('POST', `/v1/admin/books/${book.id}/links`, { token: su, body: { retailer: 'Apple Books', url: 'https://books.apple.com/ca/x', kind: 'eBook' } });
    expect(link.status).toBe(200);
    const got = (await j('GET', '/v1/admin/books', { token: su })).body.items.find((b: any) => b.id === book.id);
    expect(got.retailers.some((r: any) => r.kind === 'eBook')).toBe(true);
    // patch the kind
    const lid = got.retailers.find((r: any) => r.kind === 'eBook').id;
    expect((await j('PATCH', `/v1/admin/books/${book.id}/links/${lid}`, { token: su, body: { kind: 'Audiobook' } })).status).toBe(200);
    const got2 = (await j('GET', '/v1/admin/books', { token: su })).body.items.find((b: any) => b.id === book.id);
    expect(got2.retailers.find((r: any) => r.id === lid).kind).toBe('Audiobook');
  });
});

describe('AUDIT-1: whose-activity actors facet', () => {
  it('global facets list distinct actors; self scope does not', async () => {
    // generate an audit entry as super
    await j('POST', '/v1/admin/announcements', { token: su, body: { title: 'Facet Ann', body_text: 'Hi families.', channel: 'carousel' } });
    const glob = await j('GET', '/v1/admin/audit/facets?scope=global', { token: su });
    expect(glob.status).toBe(200);
    expect(Array.isArray(glob.body.actors)).toBe(true);
    expect(glob.body.actors.length).toBeGreaterThan(0);
    expect(glob.body.actors[0]).toHaveProperty('name');
    const self = await j('GET', '/v1/admin/audit/facets?scope=self', { token: su });
    expect(self.body.actors).toEqual([]); // self scope has no actor drilldown
  });
});
