import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig, DEVICE_CUTOVER_REASON } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Focused tests for the one-time device-enrollment cutover + OTP fail-closed behavior.
// Three app instances differ only by config:
//   local   — cutover window OPEN (deadline in the future), env 'local' (baseline behavior + _dev_code)
//   closed  — cutover window absent (deadline null)          → normal NO_ENROLLED_DEVICE
//   prod    — env 'production', email unconfigured           → OTP fails closed, no _dev_code
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
let appOpen: FastifyInstance;   // window open, local
let appClosed: FastifyInstance; // window closed, local
let appProd: FastifyInstance;   // production, email off
let db: pg.Client;

function inj(app: FastifyInstance) {
  return async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as any, url, payload: body as any, headers: { 'content-type': 'application/json' } });
    let parsed: any = null; try { parsed = res.json(); } catch { /* */ }
    return { status: res.statusCode, body: parsed };
  };
}
const jOpen = () => inj(appOpen);
const jClosed = () => inj(appClosed);
const jProd = () => inj(appProd);

// Create a student (this enrolls its first device) and return its id.
async function makeStudent(username: string, deviceHash: string, email = `${username}@ex.com`) {
  const j = inj(appOpen);
  const c = await j('POST', '/v1/registration/contact/start', { guardian_name: 'Guardian', email, phone: '+14165551234' });
  const consent = await j('POST', '/v1/registration/consent', { registration_grant: c.body.registration_grant, policy_version: 'v1', consent_hash: 'h' });
  const created = await j('POST', '/v1/registration/student', { registration_grant: consent.body.registration_grant, display_name: 'Kid', username, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: deviceHash });
  return created.body.id as string;
}
// Revoke the student's active device with the cutover marker (mimics the cutover.sql revoke).
async function cutoverRevoke(studentId: string) {
  await db.query(`update ccat.student_devices set status='revoked', revoked_at=now(), revoked_reason=$2 where student_id=$1 and status='active'`, [studentId, DEVICE_CUTOVER_REASON]);
}

beforeAll(async () => {
  const base = loadConfig();
  appOpen = await buildApp({ ...base, deviceCutoverDeadline: new Date(Date.now() + 3600_000) });
  appClosed = await buildApp({ ...base, deviceCutoverDeadline: null });
  appProd = await buildApp({ ...base, env: 'production', email: { host: '', port: 587, user: '', pass: '', from: '' } });
  await Promise.all([appOpen.ready(), appClosed.ready(), appProd.ready()]);
  db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect(); await db.query('set search_path = ccat, public');
});
afterAll(async () => { await Promise.all([appOpen.close(), appClosed.close(), appProd.close()]); await db.end(); });

describe('device-enrollment cutover', () => {
  it('window OPEN + cutover-revoked + zero active → first login enrolls the new browser', async () => {
    const id = await makeStudent('cut_enroll', 'old-device');
    await cutoverRevoke(id);
    const r = await jOpen()('POST', '/v1/auth/login', { username: 'cut_enroll', pin: '1234', device_hash: 'new-browser' });
    expect(r.status).toBe(200);
    expect(r.body.access_token).toBeTruthy();
    const d = await db.query(`select count(*)::int n from ccat.student_devices where student_id=$1 and status='active' and device_hash='new-browser'`, [id]);
    expect(d.rows[0].n).toBe(1);
    const audit = await db.query(`select count(*)::int n from ccat.audit_log where event_type='device.enrolled.cutover' and reason=$1`, [DEVICE_CUTOVER_REASON]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('after enroll, a DIFFERENT browser is rejected (one active device)', async () => {
    const r = await jOpen()('POST', '/v1/auth/login', { username: 'cut_enroll', pin: '1234', device_hash: 'second-browser' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('DEVICE_NOT_ENROLLED');
  });

  it('window CLOSED (no deadline) → zero active is NOT auto-enrolled', async () => {
    const id = await makeStudent('cut_closed', 'old-device');
    await cutoverRevoke(id);
    const r = await jClosed()('POST', '/v1/auth/login', { username: 'cut_closed', pin: '1234', device_hash: 'new-browser' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NO_ENROLLED_DEVICE');
    const d = await db.query(`select count(*)::int n from ccat.student_devices where student_id=$1 and status='active'`, [id]);
    expect(d.rows[0].n).toBe(0);
  });

  it('window OPEN but NO cutover marker → not enrolled (bounded to cutover students only)', async () => {
    const id = await makeStudent('cut_nomark', 'old-device');
    // Revoke WITHOUT the cutover reason (ordinary revoke).
    await db.query(`update ccat.student_devices set status='revoked', revoked_at=now(), revoked_reason='other' where student_id=$1 and status='active'`, [id]);
    const r = await jOpen()('POST', '/v1/auth/login', { username: 'cut_nomark', pin: '1234', device_hash: 'new-browser' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NO_ENROLLED_DEVICE');
  });

  it('preview account is excluded from cutover enroll', async () => {
    const id = await makeStudent('cut_preview', 'old-device');
    await db.query(`update ccat.students set is_preview=true where id=$1`, [id]);
    await cutoverRevoke(id);
    const r = await jOpen()('POST', '/v1/auth/login', { username: 'cut_preview', pin: '1234', device_hash: 'new-browser' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NO_ENROLLED_DEVICE');
  });
});

describe('OTP fail-closed (email unavailable)', () => {
  it('local (dev) still returns a challenge + _dev_code when SMTP is off', async () => {
    await makeStudent('otp_local', 'dev-1');
    const r = await jOpen()('POST', '/v1/recovery/pin/start', { username: 'otp_local', channel: 'email' });
    expect(r.status).toBe(202);
    expect(r.body._dev_code).toBeTruthy();
  });

  it('production + SMTP off → /recovery/pin/start returns 503 EMAIL_UNAVAILABLE, no _dev_code', async () => {
    await makeStudent('otp_prod', 'dev-1');
    const r = await jProd()('POST', '/v1/recovery/pin/start', { username: 'otp_prod', channel: 'email' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('EMAIL_UNAVAILABLE');
    expect(r.body._dev_code).toBeUndefined();
  });

  it('production + SMTP off → /devices/replacement/start returns 503 EMAIL_UNAVAILABLE', async () => {
    await makeStudent('otp_prod2', 'dev-1');
    const r = await jProd()('POST', '/v1/devices/replacement/start', { username: 'otp_prod2', new_device_hash: 'ndh', channel: 'email' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('EMAIL_UNAVAILABLE');
  });

  it('non-email channel is refused explicitly (sms unsupported)', async () => {
    await makeStudent('otp_sms', 'dev-1');
    const r = await jOpen()('POST', '/v1/recovery/pin/start', { username: 'otp_sms', channel: 'sms' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('EMAIL_UNAVAILABLE');
  });
});
