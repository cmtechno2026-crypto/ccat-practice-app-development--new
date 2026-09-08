import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool, type DB } from '../src/db.js';

// Feature: admin student editing (name/grade) + student-initiated grade-change requests.
//   - PATCH /v1/admin/students/:id     — edit name/grade; gated on `student.update`; If-Match version.
//   - GET/POST /v1/account/grade-change — student files + views a request (no direct grade update).
//   - approve/reject /v1/admin/students/:id/grade-requests/:reqId — admin review (student.update).
// Invariant under test throughout: changing a grade is a plain column update and NEVER deletes the
// student's sessions/progress/history.
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const GRADE6 = 'a0000000-0000-0000-0000-000000000006';
const PRACTICE_SET = 'e1000000-0000-0000-0000-000000000001'; // seeded, published, grade 5, practice

let app: FastifyInstance; let db: DB;
async function j(method: string, url: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const adminLogin = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
async function studentToken(username: string, gradeId: string = GRADE5) {
  const c = await j('POST', '/v1/registration/contact/start', { body: { guardian_name: 'G', email: `${username}@ex.test`, phone: '+14165551234' } });
  const consent = await j('POST', '/v1/registration/consent', { body: { registration_grant: c.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  await j('POST', '/v1/registration/student', { body: { registration_grant: consent.body.registration_grant, display_name: 'K', username, grade_id: gradeId, birth_month: 6, birth_year: 2015, pin: '1234', device_hash: `dev-${username}` } });
  const token = (await j('POST', '/v1/auth/login', { body: { username, pin: '1234', device_hash: `dev-${username}` } })).body.access_token as string;
  const id = (await db.query('select id from ccat.students where username_normalized=$1', [username])).rows[0]!.id as string;
  return { token, id };
}

let su = '', support = '', editor = '';
let n = 0;
async function makeStudent(): Promise<string> {
  n++;
  const s = await db.query(`insert into ccat.students(username_normalized, display_name, grade_id, birth_month, birth_year) values ($1,'Grade Kid',$2,6,2015) returning id`, [`grade_kid_${n}_${Date.now()}`, GRADE5]);
  return s.rows[0]!.id;
}
const versionOf = async (id: string) => Number((await db.query('select version from ccat.students where id=$1', [id])).rows[0]!.version);
const gradeOf = async (id: string) => (await db.query('select grade_id from ccat.students where id=$1', [id])).rows[0]!.grade_id as string;

beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  db = createPool(process.env.DATABASE_URL!);
  su = (await adminLogin('super@cm.ca')).body.access_token;         // super_admin (all permissions via role)
  support = (await adminLogin('support@cm.ca')).body.access_token;  // has student.directory, NOT student.update
  editor = (await adminLogin('content@cm.ca')).body.access_token;   // granted student.update in setup
});
afterAll(async () => { await db.end(); await app.close(); });

describe('admin student edit — PATCH /v1/admin/students/:id', () => {
  it('permission catalog exposes student.update (grantable)', async () => {
    const p = await j('GET', '/v1/admin/permissions', { token: su });
    const row = (p.body.items as any[]).find((x) => x.key === 'student.update');
    expect(row).toBeTruthy();
    expect(row.super_admin_only).toBe(false);
  });

  it('super edits name + grade; validates and audits; version bumps', async () => {
    const id = await makeStudent();
    const v = await versionOf(id);
    const r = await j('PATCH', `/v1/admin/students/${id}`, { token: su, headers: { 'if-match': String(v) }, body: { display_name: 'Renamed Kid', grade_id: GRADE6 } });
    expect(r.status).toBe(200);
    expect(r.body.grade_id).toBe(GRADE6);
    expect(r.body.display_name).toBe('Renamed Kid');
    expect(r.body.version).toBe(v + 1);
    const aud = await db.query(`select 1 from ccat.audit_log where event_type='student.updated' and target_id=$1`, [id]);
    expect(aud.rows.length).toBe(1);
  });

  it('rejects an unknown / inactive grade (422)', async () => {
    const id = await makeStudent();
    const r = await j('PATCH', `/v1/admin/students/${id}`, { token: su, headers: { 'if-match': String(await versionOf(id)) }, body: { grade_id: '00000000-0000-0000-0000-0000000000ff' } });
    expect(r.status).toBe(422);
  });

  it('stale If-Match version → 409 VERSION_CONFLICT (nothing changed)', async () => {
    const id = await makeStudent();
    const stale = (await versionOf(id)) - 1;
    const before = await gradeOf(id);
    const r = await j('PATCH', `/v1/admin/students/${id}`, { token: su, headers: { 'if-match': String(stale) }, body: { grade_id: GRADE6 } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('VERSION_CONFLICT');
    expect(await gradeOf(id)).toBe(before);
  });

  it('RBAC: an admin without student.update gets 403', async () => {
    const id = await makeStudent();
    const r = await j('PATCH', `/v1/admin/students/${id}`, { token: support, headers: { 'if-match': String(await versionOf(id)) }, body: { display_name: 'Nope' } });
    expect(r.status).toBe(403);
  });

  it('editing the grade preserves the student\'s existing sessions/history', async () => {
    const { token, id } = await studentToken('gc_history');
    // Create real history: an in-progress practice session on the seeded published grade-5 set.
    const start = await j('POST', '/v1/sessions/start', { token, body: { set_version_id: PRACTICE_SET, mode: 'practice', timer_type: 'untimed' } });
    expect(start.status).toBe(201);
    const before = Number((await db.query('select count(*)::int c from ccat.sessions where student_id=$1', [id])).rows[0]!.c);
    expect(before).toBeGreaterThan(0);
    // Move the student to Grade 6.
    const r = await j('PATCH', `/v1/admin/students/${id}`, { token: su, headers: { 'if-match': String(await versionOf(id)) }, body: { grade_id: GRADE6 } });
    expect(r.status).toBe(200);
    expect(await gradeOf(id)).toBe(GRADE6);
    // Sessions untouched.
    const after = Number((await db.query('select count(*)::int c from ccat.sessions where student_id=$1', [id])).rows[0]!.c);
    expect(after).toBe(before);
  });
});

describe('student grade-change request — /v1/account/grade-change', () => {
  it('files a pending request, audited; status endpoint reflects it', async () => {
    const { token, id } = await studentToken('gc_req');
    const r = await j('POST', '/v1/account/grade-change', { token, body: { requested_grade_id: GRADE6, reason: 'Too easy' } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('pending');
    const row = await db.query(`select status, requested_grade_id from ccat.grade_change_requests where student_id=$1`, [id]);
    expect(row.rows.length).toBe(1);
    expect(row.rows[0]!.status).toBe('pending');
    const aud = await db.query(`select 1 from ccat.audit_log where event_type='student.self.grade_change_requested' and target_id=$1`, [id]);
    expect(aud.rows.length).toBe(1);
    const st = await j('GET', '/v1/account/grade-change', { token });
    expect(st.body.current_grade_number).toBe(5);
    expect(st.body.request.status).toBe('pending');
    expect(st.body.request.requested_grade_number).toBe(6);
  });

  it('blocks a duplicate pending request (409 GRADE_REQUEST_PENDING)', async () => {
    const { token } = await studentToken('gc_dup');
    const first = await j('POST', '/v1/account/grade-change', { token, body: { requested_grade_id: GRADE6 } });
    expect(first.status).toBe(200);
    const second = await j('POST', '/v1/account/grade-change', { token, body: { requested_grade_id: GRADE6 } });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('GRADE_REQUEST_PENDING');
  });

  it('rejects requesting the current grade (422)', async () => {
    const { token } = await studentToken('gc_same');
    const r = await j('POST', '/v1/account/grade-change', { token, body: { requested_grade_id: GRADE5 } });
    expect(r.status).toBe(422);
  });
});

describe('admin review — approve / reject', () => {
  it('approve updates the grade AND closes the request in one transaction; history preserved; audited', async () => {
    const { token, id } = await studentToken('gc_approve');
    // History artifact first.
    await j('POST', '/v1/sessions/start', { token, body: { set_version_id: PRACTICE_SET, mode: 'practice', timer_type: 'untimed' } });
    const sessionsBefore = Number((await db.query('select count(*)::int c from ccat.sessions where student_id=$1', [id])).rows[0]!.c);
    const req = await j('POST', '/v1/account/grade-change', { token, body: { requested_grade_id: GRADE6 } });
    const reqId = req.body.id as string;

    const ap = await j('POST', `/v1/admin/students/${id}/grade-requests/${reqId}/approve`, { token: su });
    expect(ap.status).toBe(200);
    expect(ap.body.status).toBe('approved');
    expect(ap.body.grade_id).toBe(GRADE6);
    expect(await gradeOf(id)).toBe(GRADE6);
    const row = await db.query(`select status, reviewed_by, decided_at from ccat.grade_change_requests where id=$1`, [reqId]);
    expect(row.rows[0]!.status).toBe('approved');
    expect(row.rows[0]!.reviewed_by).toBeTruthy();
    expect(row.rows[0]!.decided_at).toBeTruthy();
    const sessionsAfter = Number((await db.query('select count(*)::int c from ccat.sessions where student_id=$1', [id])).rows[0]!.c);
    expect(sessionsAfter).toBe(sessionsBefore);
    const aud = await db.query(`select 1 from ccat.audit_log where event_type='student.grade_change.approved' and target_id=$1`, [id]);
    expect(aud.rows.length).toBe(1);
  });

  it('reject leaves the grade unchanged and closes the request; audited', async () => {
    const { token, id } = await studentToken('gc_reject');
    const before = await gradeOf(id);
    const req = await j('POST', '/v1/account/grade-change', { token, body: { requested_grade_id: GRADE6 } });
    const reqId = req.body.id as string;
    const rj = await j('POST', `/v1/admin/students/${id}/grade-requests/${reqId}/reject`, { token: su });
    expect(rj.status).toBe(200);
    expect(rj.body.status).toBe('rejected');
    expect(await gradeOf(id)).toBe(before);
    const row = await db.query(`select status from ccat.grade_change_requests where id=$1`, [reqId]);
    expect(row.rows[0]!.status).toBe('rejected');
    const aud = await db.query(`select 1 from ccat.audit_log where event_type='student.grade_change.rejected' and target_id=$1`, [id]);
    expect(aud.rows.length).toBe(1);
  });

  it('a non-super holder of student.update may review (content editor approves)', async () => {
    const { token, id } = await studentToken('gc_editor_review');
    const req = await j('POST', '/v1/account/grade-change', { token, body: { requested_grade_id: GRADE6 } });
    const ap = await j('POST', `/v1/admin/students/${id}/grade-requests/${req.body.id}/approve`, { token: editor });
    expect(ap.status).toBe(200);
    expect(await gradeOf(id)).toBe(GRADE6);
  });

  it('RBAC: an admin without student.update cannot approve (403)', async () => {
    const { token, id } = await studentToken('gc_rbac');
    const req = await j('POST', '/v1/account/grade-change', { token, body: { requested_grade_id: GRADE6 } });
    const ap = await j('POST', `/v1/admin/students/${id}/grade-requests/${req.body.id}/approve`, { token: support });
    expect(ap.status).toBe(403);
  });

  it('approving an already-decided request → 404 (no pending)', async () => {
    const { token, id } = await studentToken('gc_twice');
    const req = await j('POST', '/v1/account/grade-change', { token, body: { requested_grade_id: GRADE6 } });
    const reqId = req.body.id as string;
    await j('POST', `/v1/admin/students/${id}/grade-requests/${reqId}/reject`, { token: su });
    const again = await j('POST', `/v1/admin/students/${id}/grade-requests/${reqId}/approve`, { token: su });
    expect(again.status).toBe(404);
  });

  it('grade-requests queue lists pending requests for a holder', async () => {
    const { token } = await studentToken('gc_queue');
    await j('POST', '/v1/account/grade-change', { token, body: { requested_grade_id: GRADE6 } });
    const list = await j('GET', '/v1/admin/students/grade-requests?status=pending', { token: su });
    expect(list.status).toBe(200);
    expect((list.body.items as any[]).some((x) => x.requested_grade_number === 6)).toBe(true);
  });
});
