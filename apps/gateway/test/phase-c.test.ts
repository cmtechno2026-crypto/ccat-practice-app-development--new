import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Onboarding — unified guardian contact, email + phone VALIDATED (not OTP-verified). No code is
// generated, sent, or checked. The account is created once the contact validates + consent is given;
// email is normalized (lowercased), phone normalized to E.164 with a country code. Single-device login.
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';

let app: FastifyInstance;
async function json(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: body as any, headers: { 'content-type': 'application/json' } });
  let parsed: any = null; try { parsed = res.json(); } catch { /* */ }
  return { status: res.statusCode, body: parsed };
}

// Full validate-only onboarding.
async function onboard(username: string, deviceHash: string, email: string, phone: string) {
  const c = await json('POST', '/v1/registration/contact/start', { guardian_name: 'Pat Guardian', email, phone });
  expect(c.status).toBe(200);
  const consent = await json('POST', '/v1/registration/consent', { registration_grant: c.body.registration_grant, policy_version: 'v1', consent_hash: 'h' });
  expect(consent.status).toBe(201);
  const created = await json('POST', '/v1/registration/student', { registration_grant: consent.body.registration_grant, display_name: 'Kid', username, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: deviceHash });
  return { contact: c.body, created };
}

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); });
afterAll(async () => { await app.close(); });

describe('Onboarding — validate-only (no OTP)', () => {
  it('creates a student behind ONE validated guardian contact (lowercased email + E.164 phone + name); no verified flags set', async () => {
    const { contact, created } = await onboard('valkid', 'dev-val-1', 'Mixed.Case@Example.COM', '+1 416 555 1234');
    expect(created.status).toBe(201);
    expect(contact.guardian_email).toBe('mixed.case@example.com');   // normalized lowercase
    expect(contact.guardian_phone).toBe('+14165551234');             // normalized E.164
    const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect(); await db.query('set search_path = ccat, public');
    const { rows } = await db.query(
      `select g.name, g.email, g.phone, g.email_verified_at, g.phone_verified_at,
              (select count(*) from ccat.student_guardians sg join ccat.students s on s.id=sg.student_id
                where sg.guardian_id=g.id and s.username_normalized='valkid') as links
         from ccat.guardian_contacts g where g.email='mixed.case@example.com'`);
    await db.end();
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('Pat Guardian');
    expect(rows[0].phone).toBe('+14165551234');
    // Contacts are VALIDATED, not verified — the *_verified_at markers stay null (truthful).
    expect(rows[0].email_verified_at).toBeNull();
    expect(rows[0].phone_verified_at).toBeNull();
    expect(Number(rows[0].links)).toBe(1);
  });

  it('rejects an invalid email with 422', async () => {
    const c = await json('POST', '/v1/registration/contact/start', { guardian_name: 'G', email: 'not-an-email', phone: '+14165551234' });
    expect(c.status).toBe(422);
  });

  it('rejects a phone with no / wrong country code with 422', async () => {
    const noCc = await json('POST', '/v1/registration/contact/start', { guardian_name: 'G', email: 'g@x.test', phone: '4165551234' });
    expect(noCc.status).toBe(422);
    const tooShort = await json('POST', '/v1/registration/contact/start', { guardian_name: 'G', email: 'g2@x.test', phone: '+1416' });
    expect(tooShort.status).toBe(422);
  });

  it('consent + student succeed with NO verified channel (validate-only, gate removed)', async () => {
    const { created } = await onboard('nogate', 'dev-nogate-1', 'nogate@x.test', '+14165550000');
    expect(created.status).toBe(201);
  });

  it('logs in with userID + PIN; wrong PIN 401; a different device is rejected (single-device)', async () => {
    await onboard('loginval', 'dev-loginval-1', 'loginval@x.test', '+14165550001');
    const good = await json('POST', '/v1/auth/login', { username: 'loginval', pin: '1234', device_hash: 'dev-loginval-1' });
    expect(good.status).toBe(200);
    expect(good.body.access_token).toBeTruthy();
    const wrong = await json('POST', '/v1/auth/login', { username: 'loginval', pin: '9999', device_hash: 'dev-loginval-1' });
    expect(wrong.status).toBe(401);
    const otherDevice = await json('POST', '/v1/auth/login', { username: 'loginval', pin: '1234', device_hash: 'a-different-device' });
    expect(otherDevice.status).toBe(403);
    expect(otherDevice.body.error.code).toBe('DEVICE_NOT_ENROLLED');
  });
});
