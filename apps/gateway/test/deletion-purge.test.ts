import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// ADMIN-2: student erasure by anonymize + tombstone (Option A). Proves the purge succeeds WITHOUT
// tripping the append-only trigger (a naive hard-DELETE would cascade a DELETE into the append-only
// xp/coin/achievement ledgers and consents, which tg_forbid_mutation rejects), that reversible PII
// is scrubbed, and that the immutable ledger/consent history survives keyed by the opaque UUID.

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
let app: FastifyInstance;
let db: pg.Client;

async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
async function makeStudent(u: string, d: string) {
  const s = await j('POST', '/v1/registration/contact/start', { body: { guardian_name: 'Guardian', email: `${u}@g.test`, phone: '+14165551234' } });
  const c = await j('POST', '/v1/registration/consent', { body: { registration_grant: s.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  const stu = await j('POST', '/v1/registration/student', { body: { registration_grant: c.body.registration_grant, display_name: 'Kiddo', username: u, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: d } });
  return stu.body.id as string;
}

let su = '', sup = '';
beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  su = (await login('super@cm.ca')).body.access_token;
  sup = (await login('support@cm.ca')).body.access_token;
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect(); await db.query('set search_path = ccat, public');
});
afterAll(async () => { await app.close(); await db.end(); });

const count = async (sql: string, id: string) => Number((await db.query(sql, [id])).rows[0].c);

describe('ADMIN-2 — student purge (anonymize + tombstone)', () => {
  it('purges a pending_deletion student without tripping the append-only invariant', async () => {
    const id = await makeStudent('purgekid', 'devPurge1');
    // Give the student an append-only ledger row so we can prove it survives the purge.
    await db.query(`insert into ccat.xp_transactions(student_id,delta,source_kind,source_id,reason) values ($1,25,'admin_adjustment','purge-seed-1','test_seed')`, [id]);

    // Registration created an immutable consent row; capture the pre-purge ledger footprint.
    expect(await count(`select count(*) c from ccat.consents where student_id=$1`, id)).toBeGreaterThan(0);
    expect(await count(`select count(*) c from ccat.xp_transactions where student_id=$1`, id)).toBe(1);
    expect(await count(`select count(*) c from ccat.student_credentials where student_id=$1`, id)).toBe(1);

    // Request deletion first (§7) — purge is only valid from pending_deletion.
    expect((await j('POST', `/v1/admin/students/${id}/deletion`, { token: su, body: { reference: 'REQ-1' } })).status).toBe(200);

    // Support agent lacks student.deletion.override → forbidden.
    expect((await j('POST', `/v1/admin/students/${id}/purge`, { token: sup, body: {} })).status).toBe(403);

    // Super-Admin purges. The key regression check: this returns 200 — a hard-DELETE would raise
    // 'Table ccat.xp_transactions is append-only' inside the transaction.
    const purge = await j('POST', `/v1/admin/students/${id}/purge`, { token: su, body: { reference: 'REQ-1' } });
    expect(purge.status).toBe(200);
    expect(purge.body.purged).toBe(true);
    expect(purge.body.status).toBe('purged');

    // Reversible PII scrubbed on the (surviving) student row.
    const s = (await db.query(`select status,display_name,username_normalized,birth_year from ccat.students where id=$1`, [id])).rows[0];
    expect(s.status).toBe('purged');
    expect(s.display_name).toBe('[deleted student]');
    expect(String(s.username_normalized)).toMatch(/^deleted_/);
    expect(s.display_name).not.toContain('Kiddo');

    // Auth material gone.
    expect(await count(`select count(*) c from ccat.student_credentials where student_id=$1`, id)).toBe(0);
    expect(await count(`select count(*) c from ccat.student_devices where student_id=$1`, id)).toBe(0);
    expect(await count(`select count(*) c from ccat.student_guardians where student_id=$1`, id)).toBe(0);

    // Append-only ledger + consent history SURVIVE (the whole point of Option A).
    expect(await count(`select count(*) c from ccat.xp_transactions where student_id=$1`, id)).toBe(1);
    expect(await count(`select count(*) c from ccat.consents where student_id=$1`, id)).toBeGreaterThan(0);
    // Purge recorded a status transition on the append-only history.
    expect(await count(`select count(*) c from ccat.student_status_events where student_id=$1 and to_status='purged'`, id)).toBe(1);

    // Deletion request closed; audit written with no PII.
    expect(await count(`select count(*) c from ccat.deletion_requests where student_id=$1 and state='purged'`, id)).toBe(1);
    const audit = (await db.query(`select new_value from ccat.audit_log where target_id=$1 and event_type='student.purged'`, [id])).rows[0];
    expect(audit.new_value).toEqual({ status: 'purged' });

    // Orphaned guardian contact scrubbed (this student's guardian is not shared).
    const g = (await db.query(`select email::text, phone from ccat.guardian_contacts gc
      where exists (select 1 from ccat.consents c where c.student_id=$1 and c.guardian_id=gc.id)`, [id])).rows;
    for (const row of g) {
      expect(row.email).toMatch(/^deleted\+/);
      expect(row.phone).toBeNull();
    }
  });

  it('rejects a second purge (no longer pending_deletion)', async () => {
    const id = await makeStudent('purgekid2', 'devPurge2');
    await j('POST', `/v1/admin/students/${id}/deletion`, { token: su, body: {} });
    expect((await j('POST', `/v1/admin/students/${id}/purge`, { token: su, body: {} })).status).toBe(200);
    const again = await j('POST', `/v1/admin/students/${id}/purge`, { token: su, body: {} });
    expect(again.status).toBe(422);
  });

  it('cannot purge a student that was never requested for deletion', async () => {
    const id = await makeStudent('activekid', 'devActive1');
    const r = await j('POST', `/v1/admin/students/${id}/purge`, { token: su, body: {} });
    expect(r.status).toBe(422);
  });
});
