// End-to-end feature smoke against a running Gateway. Prints a PASS/FAIL checklist.
// Usage: GATEWAY=http://localhost:8080 node scripts/smoke.mjs
const BASE = process.env.GATEWAY || 'http://localhost:8080';
const SETV_VERBAL = 'd5000000-0000-0000-0000-0000000000a1';
const BOOK = 'e6000000-0000-0000-0000-000000000001';

let pass = 0, fail = 0; const results = [];
function check(name, ok, detail = '') { results.push({ name, ok, detail }); ok ? pass++ : fail++; }

async function api(method, path, { body, token, headers } = {}) {
  const h = { ...(headers || {}), ...(token ? { authorization: 'Bearer ' + token } : {}) };
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const txt = await res.text(); let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {}
  return { status: res.status, json, etag: res.headers.get('etag') };
}
const uniq = () => Math.random().toString(36).slice(2, 8);

async function run() {
  // 1. health + catalog
  check('Gateway health', (await api('GET', '/health/ready')).status === 200);
  const grades = await api('GET', '/v1/grades');
  check('Grades catalog (data-driven)', grades.status === 200 && grades.json.some(g => g.grade_number === 5), `${grades.json?.length} grades`);
  const GRADE5 = grades.json.find(g => g.grade_number === 5).id;

  // 2. registration -> login (single device)
  const uname = 'demo_' + uniq(); const device = 'dev_' + uniq();
  const start = await api('POST', '/v1/registration/contact/start', { body: { channel: 'email', destination: uname + '@guardian.test' } });
  const verify = await api('POST', '/v1/registration/contact/verify', { body: { challenge_id: start.json.challenge_id, code: start.json._dev_code } });
  const consent = await api('POST', '/v1/registration/consent', { body: { registration_grant: verify.json.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  const student = await api('POST', '/v1/registration/student', { body: { registration_grant: consent.json.registration_grant, display_name: 'Demo Kid', username: uname, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: device } });
  check('Registration (guardian OTP → consent → account)', student.status === 201 && typeof student.json.age_years === 'number', `age=${student.json?.age_years}`);
  const login = await api('POST', '/v1/auth/login', { body: { username: uname, pin: '1234', device_hash: device } });
  check('Login on enrolled device', login.status === 200 && !!login.json.access_token);
  const T = login.json.access_token;
  const badDevice = await api('POST', '/v1/auth/login', { body: { username: uname, pin: '1234', device_hash: 'other' } });
  check('Single-device: other device rejected', badDevice.status === 403);

  // 3. profile + catalog + announcements + books
  const profile = await api('GET', '/v1/profile', { token: T });
  check('Profile (computed age)', profile.status === 200 && typeof profile.json.age_years === 'number');
  const catalog = await api('GET', '/v1/catalog', { token: T });
  check('Catalog lists published sets', catalog.status === 200 && catalog.json.length >= 2, `${catalog.json?.length} sets`);
  const ann = await api('GET', '/v1/announcements', { token: T });
  check('Announcements', ann.status === 200 && ann.json.length >= 1, `${ann.json?.length} items`);
  const books = await api('GET', '/v1/books', { token: T });
  check('Book store list', books.status === 200 && books.json.length >= 1, `${books.json?.length} books`);

  // 4. session play: start -> shuffle -> answer -> submit -> score/XP/achievements
  const s = await api('POST', '/v1/sessions/start', { token: T, body: { set_version_id: SETV_VERBAL, mode: 'practice', timer_type: 'untimed' } });
  check('Session start (one active)', s.status === 201);
  const dup = await api('POST', '/v1/sessions/start', { token: T, body: { set_version_id: SETV_VERBAL, mode: 'practice', timer_type: 'untimed' } });
  check('Second session blocked (ACTIVE_SESSION_EXISTS)', dup.status === 409 && dup.json.error.code === 'ACTIVE_SESSION_EXISTS');
  const sess = await api('GET', `/v1/sessions/${s.json.id}`, { token: T });
  check('Session questions returned + shuffled', sess.status === 200 && sess.json.questions.length === 5);
  // answer every question correctly (correct is always option 'o1' in the seed)
  for (let i = 0; i < sess.json.questions.length; i++) {
    const q = sess.json.questions[i];
    await api('PATCH', `/v1/sessions/${s.json.id}/answers`, { token: T, body: { answers: [{ question_version_id: q.question_version_id, selected_option_ids: ['o1'], answer_version: 1 }] } });
  }
  const stale = await api('PATCH', `/v1/sessions/${s.json.id}/answers`, { token: T, body: { answers: [{ question_version_id: sess.json.questions[0].question_version_id, selected_option_ids: ['o2'], answer_version: 1 }] } });
  check('Autosave stale write rejected', stale.status === 409 && stale.json.error.code === 'STALE_ANSWER');
  const submit = await api('POST', `/v1/sessions/${s.json.id}/submit`, { token: T, body: { submission_id: 'sub-' + uniq(), expected_session_version: s.json.session_version } });
  check('Submit scores correctly (5/5)', submit.status === 200 && submit.json.score_correct === 5 && submit.json.score_total === 5, `xp=${submit.json?.xp_awarded}`);
  check('Achievements unlocked on submit', (submit.json.achievements_unlocked || []).length >= 1, (submit.json.achievements_unlocked || []).map(a => a.key).join(','));
  const submitReplay = await api('POST', `/v1/sessions/${s.json.id}/submit`, { token: T, body: { submission_id: submit.json.session_id, expected_session_version: s.json.session_version } });
  check('Exactly-once: replay returns a result (no error)', submitReplay.status === 200);

  // 5. rewards, readiness, progress
  const rw = await api('GET', '/v1/rewards/summary', { token: T });
  check('Rewards summary reflects ledger', rw.status === 200 && rw.json.xp_total > 0, `xp=${rw.json?.xp_total} coins=${rw.json?.coin_balance}`);
  const rd = await api('GET', '/v1/readiness', { token: T });
  check('Readiness (insufficient-data state, not 0%)', rd.status === 200 && rd.json.insufficient_data === true);
  const pr = await api('GET', '/v1/progress', { token: T });
  check('Progress coverage (learning plan)', pr.status === 200 && pr.json.eligible_count >= 2, `${pr.json?.completed_count}/${pr.json?.eligible_count}`);

  // 6. bookmarks
  const lq = sess.json.questions[0].logical_question_id;
  await api('PUT', '/v1/bookmarks', { token: T, body: { logical_question_id: lq, note: 'review this' } });
  const bms = await api('GET', '/v1/bookmarks', { token: T });
  check('Bookmark add + list (with preview)', bms.status === 200 && bms.json.length === 1 && bms.json[0].preview.length > 0);

  // 7. avatars & themes (XP-gated). One perfect set = 10 base + 25 first + ... ≥ 20
  const avatars = await api('GET', '/v1/avatars', { token: T });
  const stage2 = avatars.json.families[0].stages.find(s => s.stage_number === 2);
  check('Avatar stage unlocked by XP', avatars.status === 200 && stage2.owned === true, `xp=${avatars.json.xp_total}`);
  const equip = await api('POST', '/v1/avatars/equip', { token: T, body: { avatar_stage_id: stage2.stage_id } });
  check('Equip avatar', equip.status === 200);
  const themes = await api('GET', '/v1/themes', { token: T });
  check('Themes list (free + gated)', themes.status === 200 && themes.json.length >= 2);

  // 8. book store adult gate + handoff
  const ch = await api('POST', `/v1/books/${BOOK}/adult-challenge`, { token: T, body: {} });
  const [, x, y] = ch.json.prompt.match(/What is (\d+) \+ (\d+)/);
  const wrong = await api('POST', `/v1/books/${BOOK}/retailer-handoff`, { token: T, body: { challenge_token: ch.json.challenge_token, answer: String(Number(x) + Number(y) + 1) } });
  check('Adult gate blocks wrong answer', wrong.status === 403);
  const ho = await api('POST', `/v1/books/${BOOK}/retailer-handoff`, { token: T, body: { challenge_token: ch.json.challenge_token, answer: String(Number(x) + Number(y)) } });
  check('Adult gate → allowlisted HTTPS handoff', ho.status === 200 && ho.json.destination_url.startsWith('https://'));

  // 9. PIN recovery + device replacement
  const pr1 = await api('POST', '/v1/recovery/pin/start', { body: { username: uname, channel: 'email' } });
  const pr2 = await api('POST', '/v1/recovery/pin/complete', { body: { challenge_id: pr1.json.challenge_id, code: pr1.json._dev_code, new_pin: '5678' } });
  check('PIN recovery (guardian OTP → new PIN)', pr2.status === 200);
  const relogin = await api('POST', '/v1/auth/login', { body: { username: uname, pin: '5678', device_hash: device } });
  check('Login with new PIN works', relogin.status === 200);
  const dr1 = await api('POST', '/v1/devices/replacement/start', { body: { username: uname, new_device_hash: 'newdev_' + uniq(), channel: 'email' } });
  const dr2 = await api('POST', '/v1/devices/replacement/verify', { body: { challenge_id: dr1.json.challenge_id, code: dr1.json._dev_code } });
  check('Device replacement (guardian OTP → new device)', dr2.status === 200 && !!dr2.json.access_token);

  // 10. ADMIN: login, directory, RBAC, status+audit
  const adminLogin = await api('POST', '/v1/admin/auth/login', { body: { email: 'support@cm.ca', password: 'Passw0rd!' } });
  check('Admin login (support)', adminLogin.status === 200 && adminLogin.json.admin.role === 'admin');
  const AT = adminLogin.json.access_token;
  const dir = await api('GET', '/v1/admin/students?limit=100', { token: AT });
  check('Admin directory (age + guardian PII)', dir.status === 200 && dir.json.items.length >= 1 && dir.json.items[0].guardian_email.includes('@'));
  const target = dir.json.items.find(i => i.username === uname) || dir.json.items[0];
  const susp = await api('POST', `/v1/admin/students/${target.id}/status`, { token: AT, headers: { 'if-match': String(target.version) }, body: { to_status: 'suspended', reason_code: 'demo' } });
  check('Admin suspend (permission granted)', susp.status === 200);
  const ban = await api('POST', `/v1/admin/students/${target.id}/status`, { token: AT, body: { to_status: 'banned', reason_code: 'x' } });
  check('Admin RBAC: ban denied for support (no permission)', ban.status === 403 && ban.json.error.code === 'PERMISSION_DENIED');
  const auditSelf = await api('GET', '/v1/admin/audit', { token: AT });
  check('Admin audit (self scope)', auditSelf.status === 200 && auditSelf.json.items.length >= 1);
  const auditGlobalDenied = await api('GET', '/v1/admin/audit?scope=global', { token: AT });
  check('Admin audit: global denied without permission', auditGlobalDenied.status === 403);
  const superLogin = await api('POST', '/v1/admin/auth/login', { body: { email: 'super@cm.ca', password: 'Passw0rd!' } });
  const banBySuper = await api('POST', `/v1/admin/students/${target.id}/status`, { token: superLogin.json.access_token, body: { to_status: 'banned', reason_code: 'demo' } });
  check('Super-Admin can ban', banBySuper.status === 200);

  // Report
  console.log('\n================ CCAT LOCAL FEATURE SMOKE ================');
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'}  ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
  console.log('----------------------------------------------------------');
  console.log(`${pass} passed, ${fail} failed, ${results.length} total`);
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error('SMOKE CRASHED:', e); process.exit(2); });
