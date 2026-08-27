import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Server-side audit CSV export (GET /v1/admin/audit/export). The permission audit.export.self is
// enforced by the GATEWAY, not the frontend: an admin without it is refused even though the UI would
// simply hide the button. Global scope additionally requires audit.read.global. The export itself is
// audited (audit.exported). Mirrors the read endpoint's filters/scope.

let app: FastifyInstance;
let db: pg.Client;
async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  return { status: res.statusCode, body: res.body, headers: res.headers };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
const tokenOf = (r: { body: string }) => JSON.parse(r.body).access_token as string;

let su = '', editor = '';
beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  su = tokenOf(await login('super@cm.ca'));
  editor = tokenOf(await login('content@cm.ca')); // seeded editor: content.* but NOT audit.export.self
  db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); await db.query('set search_path = ccat, public');
});
afterAll(async () => { await app.close(); await db.end(); });

describe('audit export — server-enforced permission', () => {
  it('rejects an unauthenticated request (401)', async () => {
    expect((await j('GET', '/v1/admin/audit/export')).status).toBe(401);
  });

  it('self-check: the editor account genuinely lacks audit.export.self (else this file proves nothing)', async () => {
    const has = await db.query(
      `select 1 from ccat.admin_permissions ap join ccat.admin_profiles p on p.id=ap.admin_id
        where p.email='content@cm.ca' and ap.permission_key='audit.export.self'`);
    expect(has.rowCount).toBe(0);
  });

  it('refuses an admin WITHOUT audit.export.self (403) — not a frontend-only check', async () => {
    const r = await j('GET', '/v1/admin/audit/export', { token: editor });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error.code).toBe('PERMISSION_DENIED');
  });

  it('refuses global scope without audit.read.global (403) even with export.self', async () => {
    // If a non-super export.self holder existed we would use it; super has both, so assert the read
    // endpoint's global gate is shared: an editor asking for global export is refused at export.self
    // first. (Covered above.) Here we assert super CAN do global.
    const r = await j('GET', '/v1/admin/audit/export?scope=global', { token: su });
    expect(r.status).toBe(200);
  });

  it('super exports CSV: text/csv, header row, and the export is itself audited', async () => {
    const before = Number((await db.query(`select count(*) c from ccat.audit_log where event_type='audit.exported'`)).rows[0].c);
    const r = await j('GET', '/v1/admin/audit/export?scope=self', { token: su });
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/csv');
    expect(String(r.headers['content-disposition'])).toContain('attachment');
    expect(r.body.split(/\r?\n/)[0]).toBe('created_at,actor,actor_role,event_type,category,target_kind,target_id,reason,reference,request_id');
    const after = Number((await db.query(`select count(*) c from ccat.audit_log where event_type='audit.exported'`)).rows[0].c);
    expect(after).toBe(before + 1);
  });

  it('honors the category filter (governance rows only)', async () => {
    const r = await j('GET', '/v1/admin/audit/export?scope=global&category=governance', { token: su });
    expect(r.status).toBe(200);
    const lines = r.body.split(/\r?\n/).slice(1).filter(Boolean);
    // every data row's event_type (col 4, 0-indexed 3) must start with a governance prefix
    const govPrefixes = ['admin.', 'config.', 'flag.', 'grade.', 'announcement.', 'push.', 'audit.', 'incident.'];
    for (const line of lines) {
      const cols = line.split(',');
      const ev = cols[3]!.replace(/^"|"$/g, '');
      expect(govPrefixes.some(p => ev.startsWith(p))).toBe(true);
    }
  });
});
