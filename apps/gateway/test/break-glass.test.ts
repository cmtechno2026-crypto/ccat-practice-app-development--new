import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// STUDENTS-1: break-glass device enrollment. Super signs directly (old device revoked, new sole
// active); a non-super holder of device.break_glass only files a co-sign request; without the perm → 403.
let app: FastifyInstance; let db: ReturnType<typeof createPool>;
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';

async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
let su = '';

let n = 0;
async function makeStudentWithDevice(): Promise<{ studentId: string; deviceId: string }> {
  n++;
  const s = await db.query(
    `insert into ccat.students(username_normalized, display_name, grade_id, birth_month, birth_year)
     values ($1,$2,$3,6,2016) returning id`, [`bg_kid_${n}_${Date.now()}`, 'BG Kid', GRADE5]);
  const sid = s.rows[0]!.id;
  const d = await db.query(
    `insert into ccat.student_devices(student_id, device_hash, platform, status, enrolled_at, attestation_state)
     values ($1,$2,'ios','active',now(),'pass') returning id`, [sid, `hash_old_${n}`]);
  return { studentId: sid, deviceId: d.rows[0]!.id };
}
const activeDevices = (sid: string) => db.query(`select id, device_hash from ccat.student_devices where student_id=$1 and status='active'`, [sid]);
const adminIdByEmail = async (email: string) => (await db.query('select id from ccat.admin_profiles where email=$1', [email])).rows[0]!.id;

const goodBody = { platform: 'ios', device_hash: 'newhash_4b71c208', verification_note: 'Called guardian on file, confirmed DOB.' };

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); db = createPool(process.env.DATABASE_URL!); su = (await login('super@cm.ca')).body.access_token; });
afterAll(async () => { await app.close(); await db.end(); });

describe('break-glass device enrollment (STUDENTS-1)', () => {
  it('super enrolls directly: old device revoked, new device is the sole active one', async () => {
    const { studentId, deviceId } = await makeStudentWithDevice();
    const r = await j('POST', `/v1/admin/students/${studentId}/device/break-glass`, { token: su, body: goodBody });
    expect(r.status).toBe(200);
    expect(r.body.enrolled).toBe(true);
    const act = await activeDevices(studentId);
    expect(act.rows.length).toBe(1);               // exactly one active
    expect(act.rows[0]!.id).not.toBe(deviceId);    // it's the new one
    const old = await db.query('select status from ccat.student_devices where id=$1', [deviceId]);
    expect(old.rows[0]!.status).toBe('revoked');
    const aud = await db.query(`select 1 from ccat.audit_log where event_type='device.break_glass.enrolled' and target_id=$1`, [act.rows[0]!.id]);
    expect(aud.rows.length).toBe(1);
  });

  it('validation: a too-short verification note is rejected', async () => {
    const { studentId } = await makeStudentWithDevice();
    const r = await j('POST', `/v1/admin/students/${studentId}/device/break-glass`, { token: su, body: { ...goodBody, verification_note: 'too short' } });
    expect(r.status).toBe(422);
  });

  it('RBAC: an admin without device.break_glass gets 403', async () => {
    const { studentId } = await makeStudentWithDevice();
    const sup = (await login('support@cm.ca')).body.access_token;
    const r = await j('POST', `/v1/admin/students/${studentId}/device/break-glass`, { token: sup, body: goodBody });
    expect(r.status).toBe(403);
  });

  it('non-super with the perm files a co-sign request; a super approves it to enroll', async () => {
    const { studentId, deviceId } = await makeStudentWithDevice();
    // grant device.break_glass to the (non-super) content admin
    const ceId = await adminIdByEmail('content@cm.ca');
    const superId = await adminIdByEmail('super@cm.ca');
    await db.query(`insert into ccat.admin_permissions(admin_id, permission_key, granted_by) values ($1,'device.break_glass',$2) on conflict do nothing`, [ceId, superId]);
    const ce = (await login('content@cm.ca')).body.access_token;

    const req = await j('POST', `/v1/admin/students/${studentId}/device/break-glass`, { token: ce, body: goodBody });
    expect(req.status).toBe(200);
    expect(req.body.status).toBe('pending_cosign');
    // nothing enrolled yet — old device still the sole active one
    let act = await activeDevices(studentId);
    expect(act.rows.length).toBe(1);
    expect(act.rows[0]!.id).toBe(deviceId);

    // a non-super cannot approve
    const denyByCe = await j('POST', `/v1/admin/students/${studentId}/device/break-glass/${req.body.request_id}/approve`, { token: ce });
    expect(denyByCe.status).toBe(403);

    // super approves → enrolls
    const appr = await j('POST', `/v1/admin/students/${studentId}/device/break-glass/${req.body.request_id}/approve`, { token: su });
    expect(appr.status).toBe(200);
    expect(appr.body.enrolled).toBe(true);
    act = await activeDevices(studentId);
    expect(act.rows.length).toBe(1);
    expect(act.rows[0]!.id).not.toBe(deviceId);
    const rq = await db.query('select status from ccat.student_break_glass_requests where id=$1', [req.body.request_id]);
    expect(rq.rows[0]!.status).toBe('approved');
  });
});
