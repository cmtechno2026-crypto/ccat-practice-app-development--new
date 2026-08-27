import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';

const email = process.env.VERIFY_ADMIN_EMAIL;
const password = process.env.VERIFY_ADMIN_PASSWORD;
if (!email || !password) throw new Error('VERIFY_ADMIN_EMAIL and VERIFY_ADMIN_PASSWORD are required');

const app = await buildApp(loadConfig());
await app.ready();
const db = createPool(process.env.DATABASE_URL!);
const run = Date.now().toString(36);
const username = `e2e_${run}`;
const device = `web-e2e-${randomUUID()}`;
const createdSetIds: string[] = [];
const createdQuestionIds: string[] = [];
let studentId: string | null = null;
let adminToken = '';
let studentToken = '';

type CallOptions = { token?: string; body?: unknown; headers?: Record<string, string> };
async function call(method: string, url: string, opts: CallOptions = {}) {
  const res = await app.inject({
    method: method as any,
    url,
    payload: opts.body as any,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}
function ok(result: Awaited<ReturnType<typeof call>>, label: string, expected = 200) {
  if (result.status !== expected) throw new Error(`${label}: expected ${expected}, got ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

const report: Record<string, unknown> = { run, checks: [] as string[] };
const checked = (label: string) => (report.checks as string[]).push(label);

try {
  const admin = ok(await call('POST', '/v1/admin/auth/login', { body: { email, password } }), 'admin login');
  adminToken = admin.access_token;
  const taxonomy = ok(await call('GET', '/v1/admin/content/taxonomy', { token: adminToken }), 'taxonomy');
  const gradeRow = (await db.query(
    `select id, age_min_years, age_max_years from ccat.grades
      where active=true and retired_at is null and registration_enabled=true order by grade_number limit 1`,
  )).rows[0];
  assert(gradeRow, 'No registration-enabled grade');
  const category = taxonomy.categories.find((c: any) => taxonomy.subcategories.some((s: any) => s.category_id === c.id));
  const subcategory = taxonomy.subcategories.find((s: any) => s.category_id === category?.id);
  const difficulty = taxonomy.difficulties[0];
  assert(category && subcategory && difficulty, 'Active content taxonomy is incomplete');
  const grade = taxonomy.grades.find((g: any) => g.id === gradeRow.id);
  assert(grade, 'Registration grade absent from Admin taxonomy');

  const age = Math.max(Number(gradeRow.age_min_years ?? 9), Math.min(Number(gradeRow.age_max_years ?? 12), 10));
  const birthYear = new Date().getUTCFullYear() - age;
  const contact = ok(await call('POST', '/v1/registration/contact/start', { body: {
    guardian_name: `E2E Guardian ${run}`, email: `${username}@example.test`, phone: '+14165551234',
  } }), 'registration contact');
  const consent = ok(await call('POST', '/v1/registration/consent', { body: {
    registration_grant: contact.registration_grant, policy_version: `e2e-${run}`, consent_hash: `e2e-${run}`,
  } }), 'registration consent', 201);
  const student = ok(await call('POST', '/v1/registration/student', { body: {
    registration_grant: consent.registration_grant, display_name: `E2E Student ${run}`, username,
    grade_id: grade.id, birth_month: 1, birth_year: birthYear, pin: '4826', device_hash: device,
  } }), 'student registration', 201);
  studentId = student.id;
  assert((await db.query('select 1 from ccat.students where id=$1', [studentId])).rowCount === 1, 'Student not persisted in PostgreSQL');
  const directory = ok(await call('GET', `/v1/admin/students?q=${username}`, { token: adminToken }), 'Admin student directory');
  assert(directory.items.some((s: any) => s.id === studentId), 'Registered student missing from Admin');
  assert(directory.items[0]?.guardian_email?.includes('*'), 'Guardian email was not masked by default');
  checked('student registration persisted and appeared in Admin with masked guardian PII');

  const login = ok(await call('POST', '/v1/auth/login', { body: { username, pin: '4826', device_hash: device } }), 'student login');
  studentToken = login.access_token;
  const refreshed = ok(await call('POST', '/v1/auth/refresh', { body: { refresh_token: login.refresh_token } }), 'refresh rotation');
  studentToken = refreshed.access_token;
  const oldRefresh = await call('POST', '/v1/auth/refresh', { body: { refresh_token: login.refresh_token } });
  assert(oldRefresh.status === 401, 'Rotated refresh token was reusable');
  checked('student login and one-time refresh rotation');

  const stems = Array.from({ length: 5 }, (_, i) => `E2E ${run} question ${i + 1}`);
  const rows = stems.map((stem) => ({
    grade: String(grade.grade_number), battery: category.name, category: subcategory.name,
    difficulty: difficulty.name, stem, question_type: `e2e_${run}`,
    options: [{ text: 'Correct', correct: true }, { text: 'Incorrect', correct: false }],
    explanation: `E2E explanation ${run}`,
  }));
  const imported = ok(await call('POST', '/v1/admin/content/import', { token: adminToken, body: { rows } }), 'valid import');
  assert(imported.imported === 5 && imported.sets.length === 1 && imported.rejected.length === 0, 'Valid import did not create one five-question draft set');
  const setId = imported.sets[0].set_version_id as string;
  createdSetIds.push(setId);
  const members = await db.query(
    `select qv.id from ccat.set_version_questions svq join ccat.question_versions qv on qv.id=svq.question_version_id
      where svq.set_version_id=$1 order by svq.position`, [setId]);
  createdQuestionIds.push(...members.rows.map(r => r.id as string));
  assert(members.rowCount === 5, 'Imported questions were not persisted in PostgreSQL');
  const duplicate = ok(await call('POST', '/v1/admin/content/import', { token: adminToken, body: { rows } }), 'duplicate import replay');
  assert(duplicate.imported === 0 && duplicate.sets.length === 0 && duplicate.rejected.length === 5, 'Duplicate import created records');
  const invalid = ok(await call('POST', '/v1/admin/content/import', { token: adminToken, body: { rows: [{ ...rows[0], stem: '', options: [{ text: '', correct: true }] }] } }), 'invalid import');
  assert(invalid.imported === 0 && invalid.rejected.length === 1, 'Invalid import was not safely rejected');
  checked('valid import persisted; invalid and duplicate imports rejected without extra sets');

  ok(await call('POST', `/v1/admin/content/sets/${setId}/publish`, { token: adminToken }), 'set publication');
  const published = await db.query(
    `select sv.state, sv.question_count, count(*) filter(where svq.active)::int active_count
       from ccat.question_set_versions sv join ccat.set_version_questions svq on svq.set_version_id=sv.id
      where sv.id=$1 group by sv.id`, [setId]);
  assert(published.rows[0]?.state === 'published' && Number(published.rows[0]?.question_count) === 5 && Number(published.rows[0]?.active_count) === 5, 'Published set is inconsistent in PostgreSQL');
  const catalog = ok(await call('GET', '/v1/catalog', { token: studentToken }), 'student catalog');
  assert(catalog.some((s: any) => s.set_version_id === setId), 'Published set missing from student website catalog');
  const session = ok(await call('POST', '/v1/sessions/start', { token: studentToken, body: { set_version_id: setId, mode: 'practice', timer_type: 'untimed' } }), 'session start', 201);
  const sessionView = ok(await call('GET', `/v1/sessions/${session.id}`, { token: studentToken }), 'session questions');
  assert(sessionView.questions.length === 5 && sessionView.questions.some((q: any) => JSON.stringify(q.prompt_blocks).includes(stems[0])), 'New question missing from practice session');
  const answers = sessionView.questions.map((q: any) => ({ question_version_id: q.question_version_id, selected_option_ids: ['a'], answer_version: 1 }));
  ok(await call('PATCH', `/v1/sessions/${session.id}/answers`, { token: studentToken, body: { answers } }), 'answer persistence');
  const result = ok(await call('POST', `/v1/sessions/${session.id}/submit`, { token: studentToken, body: { submission_id: randomUUID(), expected_session_version: session.session_version } }), 'session submit');
  assert(result.score_total === 5 && (await db.query('select 1 from ccat.session_results where session_id=$1', [session.id])).rowCount === 1, 'Result was not persisted');
  const adminDetail = ok(await call('GET', `/v1/admin/students/${studentId}/detail`, { token: adminToken }), 'Admin activity detail');
  assert(adminDetail.recent_sessions.some((s: any) => s.id === session.id && Number(s.score_total) === 5), 'Student result missing from Admin');
  checked('published content appeared in catalog/practice; answers and result persisted back to Admin');

  const revised = ok(await call('POST', `/v1/admin/content/questions/${createdQuestionIds[0]}/revise`, { token: adminToken }), 'question revision');
  createdQuestionIds.push(revised.id);
  const revisedStem = `${stems[0]} UPDATED`;
  ok(await call('PATCH', `/v1/admin/content/questions/${revised.id}`, { token: adminToken, body: { prompt_blocks: [{ type: 'text', value: revisedStem }] } }), 'revision edit');
  ok(await call('POST', `/v1/admin/content/questions/${revised.id}/review`, { token: adminToken, body: { decision: 'approved' } }), 'revision approval');
  ok(await call('POST', `/v1/admin/content/questions/${revised.id}/publish`, { token: adminToken }), 'revision publication');
  const copied = ok(await call('POST', `/v1/admin/content/sets/${setId}/copy`, { token: adminToken }), 'set copy');
  createdSetIds.push(copied.id);
  const replacementMembers = createdQuestionIds.slice(0, 5).map((id, index) => index === 0 ? revised.id : id);
  ok(await call('POST', `/v1/admin/content/sets/${copied.id}/questions`, { token: adminToken, body: { question_version_ids: replacementMembers } }), 'replace revised membership');
  ok(await call('POST', `/v1/admin/content/sets/${copied.id}/publish`, { token: adminToken }), 'revised set publication');
  const second = ok(await call('POST', '/v1/sessions/start', { token: studentToken, body: { set_version_id: copied.id, mode: 'practice', timer_type: 'untimed' } }), 'revised session start', 201);
  const secondView = ok(await call('GET', `/v1/sessions/${second.id}`, { token: studentToken }), 'revised session content');
  assert(secondView.questions.some((q: any) => JSON.stringify(q.prompt_blocks).includes(revisedStem)), 'Published revision was not served to student');
  ok(await call('POST', `/v1/sessions/${second.id}/abandon`, { token: studentToken, body: { confirm: true } }), 'abandon verification session');
  checked('immutable question revision was published through a copied set and served to student');

  const suspended = ok(await call('POST', `/v1/admin/students/${studentId}/status`, { token: adminToken, body: { to_status: 'suspended', reason_code: 'e2e.verify' }, headers: { 'if-match': String(adminDetail.version) } }), 'Admin suspend');
  assert(suspended.status === 'suspended', 'Admin status change did not persist');
  assert((await call('POST', '/v1/auth/login', { body: { username, pin: '4826', device_hash: device } })).status === 403, 'Suspended student could still log in');
  const suspendedDetail = ok(await call('GET', `/v1/admin/students/${studentId}/detail`, { token: adminToken }), 'suspended detail');
  ok(await call('POST', `/v1/admin/students/${studentId}/status`, { token: adminToken, body: { to_status: 'active', reason_code: 'e2e.verify.complete' }, headers: { 'if-match': String(suspendedDetail.version) } }), 'Admin unsuspend');
  const relogin = ok(await call('POST', '/v1/auth/login', { body: { username, pin: '4826', device_hash: device } }), 'login after Admin unsuspend');
  studentToken = relogin.access_token;
  checked('Admin status management persisted and was enforced by student authentication');

  report.student_id = studentId;
  report.set_version_ids = createdSetIds;
  report.question_version_ids = createdQuestionIds;
  report.status = 'passed';
} finally {
  // Preserve immutable session/result history, but remove all verification content from the live
  // catalog and tombstone the verification student. Cleanup failures are reported, never hidden.
  const cleanup: string[] = [];
  if (adminToken) {
    for (const id of [...createdSetIds].reverse()) {
      const r = await call('POST', `/v1/admin/content/sets/${id}/unpublish`, { token: adminToken });
      cleanup.push(`set ${id}: ${r.status}`);
    }
    for (const id of [...createdQuestionIds].reverse()) {
      const r = await call('POST', `/v1/admin/content/questions/${id}/retire`, { token: adminToken });
      cleanup.push(`question ${id}: ${r.status}`);
    }
    if (studentId) {
      const detail = await call('GET', `/v1/admin/students/${studentId}/detail`, { token: adminToken });
      if (detail.status === 200 && detail.body.status !== 'pending_deletion')
        await call('POST', `/v1/admin/students/${studentId}/deletion`, { token: adminToken, body: { reference: `E2E-${run}` } });
      const purge = await call('POST', `/v1/admin/students/${studentId}/purge`, { token: adminToken, body: { reference: `E2E-${run}` } });
      cleanup.push(`student ${studentId}: ${purge.status}`);
    }
  }
  report.cleanup = cleanup;
  console.log(JSON.stringify(report, null, 2));
  await app.close();
  await db.end();
}
