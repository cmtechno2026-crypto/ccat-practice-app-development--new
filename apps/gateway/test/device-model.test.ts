import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Device model: FREE SWITCHING, one active device at a time (no OTP, no admin). A valid login always binds
// to the presenting device; logging in on a different device signs the old one out. Preview ids are shared
// and never revoke each other. (PIN-recovery behavior lives with the recovery route's own tests.)
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
let appLocal: FastifyInstance;
let db: pg.Client;

function inj(app: FastifyInstance, token?: string) {
  return async (method: string, url: string, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await app.inject({ method: method as any, url, payload: body as any, headers });
    let parsed: any = null; try { parsed = res.json(); } catch { /* */ }
    return { status: res.statusCode, body: parsed };
  };
}
const jLocal = () => inj(appLocal);

// Create a student (registration enrolls its first device) and return its id.
async function makeStudent(username: string, deviceHash: string, email = `${username}@ex.com`) {
  const j = inj(appLocal);
  const c = await j('POST', '/v1/registration/contact/start', { guardian_name: 'Guardian', email, phone: '+14165551234' });
  const consent = await j('POST', '/v1/registration/consent', { registration_grant: c.body.registration_grant, policy_version: 'v1', consent_hash: 'h' });
  const created = await j('POST', '/v1/registration/student', { registration_grant: consent.body.registration_grant, display_name: 'Kid', username, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: deviceHash });
  return created.body.id as string;
}
const login = (username: string, device_hash: string) =>
  jLocal()('POST', '/v1/auth/login', { username, pin: '1234', device_hash });

beforeAll(async () => {
  const base = loadConfig();
  appLocal = await buildApp({ ...base });
  await appLocal.ready();
  db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect(); await db.query('set search_path = ccat, public');
});
afterAll(async () => { await appLocal.close(); await db.end(); });

async function activeDevices(studentId: string) {
  const d = await db.query(`select device_hash from ccat.student_devices where student_id=$1 and status='active'`, [studentId]);
  return d.rows.map((r) => r.device_hash as string);
}

describe('device model — free switching, one active at a time', () => {
  it('re-login on the SAME device reuses it (no switch; existing session keeps working)', async () => {
    const id = await makeStudent('dm_same', 'dev-1');
    const a = await login('dm_same', 'dev-1');
    expect(a.status).toBe(200);
    const tokenA = a.body.access_token as string;
    const b = await login('dm_same', 'dev-1');
    expect(b.status).toBe(200);
    // still exactly one active device, and the first session's token still works.
    expect(await activeDevices(id)).toEqual(['dev-1']);
    const req = await inj(appLocal, tokenA)('GET', '/v1/profile');
    expect(req.status).toBe(200);
  });

  it('login on a NEW device switches: old device signed out, new one active (no code, no admin)', async () => {
    const id = await makeStudent('dm_switch', 'dev-A');
    const a = await login('dm_switch', 'dev-A');
    expect(a.status).toBe(200);
    const tokenA = a.body.access_token as string;
    const b = await login('dm_switch', 'dev-B');
    expect(b.status).toBe(200);
    const tokenB = b.body.access_token as string;
    // exactly one active device, and it is the new one.
    expect(await activeDevices(id)).toEqual(['dev-B']);
    // the old device's session is no longer usable (device revoked on switch).
    const oldReq = await inj(appLocal, tokenA)('GET', '/v1/profile');
    expect([401, 403]).toContain(oldReq.status);
    // the new device works.
    const newReq = await inj(appLocal, tokenB)('GET', '/v1/profile');
    expect(newReq.status).toBe(200);
  });

  it('a valid login with zero active devices enrolls the presenting browser', async () => {
    const id = await makeStudent('dm_reenroll', 'dev-1');
    await db.query(`update ccat.student_devices set status='revoked', revoked_at=now(), revoked_reason='lost' where student_id=$1 and status='active'`, [id]);
    const r = await login('dm_reenroll', 'dev-2');
    expect(r.status).toBe(200);
    expect(await activeDevices(id)).toEqual(['dev-2']);
  });

  it('preview account: different browsers share one device and do NOT sign each other out', async () => {
    const id = await makeStudent('dm_preview', 'dev-1');
    await db.query(`update ccat.students set is_preview=true where id=$1`, [id]);
    const a = await login('dm_preview', 'dev-1');
    expect(a.status).toBe(200);
    const tokenA = a.body.access_token as string;
    const b = await login('dm_preview', 'dev-2');
    expect(b.status).toBe(200);
    // preview reuses the single shared device; the first session is NOT revoked.
    expect(await activeDevices(id)).toEqual(['dev-1']);
    const stillOk = await inj(appLocal, tokenA)('GET', '/v1/profile');
    expect(stillOk.status).toBe(200);
  });
});
