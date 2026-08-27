import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
let app: FastifyInstance;

async function j(method: string, url: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  let b: any = null; try { b = res.json(); } catch {}
  return { status: res.statusCode, body: b };
}
const login = (email: string) => j('POST', '/v1/admin/auth/login', { body: { email, password: 'Passw0rd!' } });
async function studentLogin(u: string, d: string) {
  const s = await j('POST', '/v1/registration/contact/start', { body: { guardian_name: 'Guardian', email: `${u}@g.test`, phone: '+14165551234' } });
  const c = await j('POST', '/v1/registration/consent', { body: { registration_grant: s.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  const stu = await j('POST', '/v1/registration/student', { body: { registration_grant: c.body.registration_grant, display_name: 'K', username: u, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: d } });
  return stu.body.id as string;
}

let su = '', sup = '', ce = '';
beforeAll(async () => {
  app = await buildApp(loadConfig()); await app.ready();
  su = (await login('super@cm.ca')).body.access_token;
  sup = (await login('support@cm.ca')).body.access_token;
  ce = (await login('content@cm.ca')).body.access_token;
});
afterAll(async () => { await app.close(); });

describe('dashboard + health (§27)', () => {
  it('dashboard KPIs', async () => {
    const d = await j('GET', '/v1/admin/dashboard', { token: su });
    expect(d.status).toBe(200);
    expect(typeof d.body.students.total).toBe('number');
    expect(d.body.content.published_questions).toBeGreaterThan(0);
  });
  it('dashboard is windowed with hero + platform state', async () => {
    const d = await j('GET', '/v1/admin/dashboard?window=30', { token: su });
    expect(d.status).toBe(200);
    expect(d.body.window).toBe(30);
    expect(d.body.hero).toBeDefined();
    expect(typeof d.body.hero.active_students.value).toBe('number');
    expect('delta_pct' in d.body.hero.sessions_scored).toBe(true);
    expect(typeof d.body.hero.session_success.dead_letter).toBe('number');
    expect(['Ready', 'Degraded', 'Incident', 'Restricted', 'Maintenance']).toContain(d.body.platform_state.label);
    expect(typeof d.body.summary).toBe('string');
  });
  it('dashboard rejects an invalid window (defaults to 7) and requires auth', async () => {
    const bad = await j('GET', '/v1/admin/dashboard?window=999', { token: su });
    expect(bad.body.window).toBe(7);
    const noauth = await j('GET', '/v1/admin/dashboard');
    expect(noauth.status).toBe(401);
  });
  it('health console is Super-Admin only (decision 4-c)', async () => {
    expect((await j('GET', '/v1/admin/health', { token: sup })).status).toBe(403); // support denied
    expect((await j('GET', '/v1/admin/health', { token: ce })).status).toBe(403);
    const h = await j('GET', '/v1/admin/health', { token: su });
    expect(h.status).toBe(200);
    expect(h.body.indicators.length).toBeGreaterThan(2);
    expect(['Healthy', 'Degraded', 'Major Incident', 'Maintenance', 'Unknown']).toContain(h.body.overall);
  });
});

describe('student detail + device (§5, §6)', () => {
  it('detail returns guardians/devices/history/readiness', async () => {
    const id = await studentLogin('af_detail', 'af-d1');
    const d = await j('GET', `/v1/admin/students/${id}/detail`, { token: su });
    expect(d.status).toBe(200);
    expect(Array.isArray(d.body.guardians)).toBe(true);
    expect(Array.isArray(d.body.devices)).toBe(true);
    expect(typeof d.body.age_years).toBe('number');
  });
  it('device revoke (permission) revokes device + sessions', async () => {
    const id = await studentLogin('af_dev', 'af-d2');
    const r = await j('POST', `/v1/admin/students/${id}/device/revoke`, { token: sup, body: { reason: 'lost' } });
    expect(r.status).toBe(200);
  });
});

describe('content management (§17, §18)', () => {
  it('taxonomy + list + create + review + publish (RBAC)', async () => {
    const tax = await j('GET', '/v1/admin/content/taxonomy', { token: ce });
    expect(tax.body.categories.length).toBeGreaterThanOrEqual(1);

    const approved = await j('GET', '/v1/admin/content/questions?state=approved', { token: ce });
    expect(approved.body.items.length).toBeGreaterThanOrEqual(1);
    const pub = await j('POST', `/v1/admin/content/questions/${approved.body.items[0].id}/publish`, { token: ce });
    expect(pub.status).toBe(200); expect(pub.body.state).toBe('published');

    const drafts = await j('GET', '/v1/admin/content/questions?state=draft', { token: ce });
    const rev = await j('POST', `/v1/admin/content/questions/${drafts.body.items[0].id}/review`, { token: ce, body: { decision: 'approved' } });
    expect(rev.status).toBe(200); expect(rev.body.state).toBe('approved');

    const created = await j('POST', '/v1/admin/content/questions', { token: ce, body: {
      category_id: tax.body.categories[0].id, subcategory_id: tax.body.subcategories[0].id,
      grade_id: GRADE5, difficulty_id: tax.body.difficulties[0].id, question_type: 'analogy',
      prompt_blocks: [{ type: 'text', value: 'A:B :: C:?' }],
      option_blocks: [{ option_id: 'o1', content: [{ type: 'text', value: 'D' }] }, { option_id: 'o2', content: [{ type: 'text', value: 'E' }] }],
      correct_option_ids: ['o1'] } });
    expect(created.status).toBe(200); expect(created.body.state).toBe('draft');
  });
  it('sets list + learning plans', async () => {
    expect((await j('GET', '/v1/admin/content/sets', { token: ce })).body.items.length).toBeGreaterThanOrEqual(1);
    expect((await j('GET', '/v1/admin/content/learning-plans', { token: ce })).status).toBe(200);
  });
});

describe('config (§28, §29)', () => {
  it('grades read + super edit; RBAC denies non-super', async () => {
    const grades = await j('GET', '/v1/admin/config/grades', { token: su });
    expect(grades.body.items.length).toBeGreaterThanOrEqual(1);
    const g = grades.body.items[0];
    expect((await j('PATCH', `/v1/admin/config/grades/${g.id}`, { token: su, body: { practice_enabled: true } })).status).toBe(200);
    expect((await j('PATCH', `/v1/admin/config/grades/${g.id}`, { token: ce, body: { practice_enabled: true } })).status).toBe(403);
  });
  it('flags read + super set; support denied', async () => {
    expect((await j('GET', '/v1/admin/config/flags', { token: su })).body.items.length).toBeGreaterThanOrEqual(8);
    expect((await j('POST', '/v1/admin/config/flags', { token: su, body: { key: 'maintenance_mode', value: true } })).status).toBe(200);
    expect((await j('POST', '/v1/admin/config/flags', { token: sup, body: { key: 'maintenance_mode', value: true } })).status).toBe(403);
    // Reset so the shared test DB doesn't leak maintenance_mode=true into other suites.
    await j('POST', '/v1/admin/config/flags', { token: su, body: { key: 'maintenance_mode', value: false } });
  });
});

describe('rewards (§19, §20)', () => {
  it('achievements list + create; avatars/themes list', async () => {
    expect((await j('GET', '/v1/admin/rewards/achievements', { token: su })).body.items.length).toBeGreaterThanOrEqual(1);
    const create = await j('POST', '/v1/admin/rewards/achievements', { token: ce, body: { key: 'streak_5_' + Date.now(), name: 'Streak 5', criteria: { type: 'xp_total', threshold: 200 }, xp: 30 } });
    expect(create.status).toBe(200);
    expect((await j('GET', '/v1/admin/rewards/avatars', { token: su })).body.items.length).toBeGreaterThanOrEqual(1);
    expect((await j('GET', '/v1/admin/rewards/themes', { token: su })).body.items.length).toBeGreaterThanOrEqual(1);
  });
  it('compensating reward adjustment (§19.3)', async () => {
    const id = await studentLogin('af_reward', 'af-r1');
    const r = await j('POST', '/v1/admin/rewards/adjust', { token: sup, body: { student_id: id, kind: 'coins', delta: 10, reason: 'goodwill', reference: 'CASE-' + Date.now() } });
    expect(r.status).toBe(200);
  });
});

describe('communications (§21, §26)', () => {
  it('announcements create + publish', async () => {
    const c = await j('POST', '/v1/admin/announcements', { token: sup, body: { title: 'Notice', body_text: 'Hello' } });
    expect(c.status).toBe(200);
    const p = await j('POST', `/v1/admin/announcements/${c.body.id}/publish`, { token: su });
    expect(p.status).toBe(200); expect(p.body.state).toBe('published');
  });
  it('push request + super approve; support denied approval', async () => {
    const camps = await j('GET', '/v1/admin/push/campaigns', { token: su });
    const requested = camps.body.items.find((c: any) => c.state === 'requested');
    expect((await j('POST', `/v1/admin/push/campaigns/${requested.id}/approval`, { token: sup, body: { decision: 'approved' } })).status).toBe(403);
    expect((await j('POST', `/v1/admin/push/campaigns/${requested.id}/approval`, { token: su, body: { decision: 'approved' } })).status).toBe(200);
  });
  it('books list + create (allowlist enforced) + per-platform links', async () => {
    expect((await j('GET', '/v1/admin/books', { token: su })).body.items.length).toBeGreaterThanOrEqual(1);
    // Off-allowlist domain is rejected.
    expect((await j('POST', '/v1/admin/books', { token: su, body: { title: 'Bad', retailer: 'Shop', url: 'https://x.example.com/b' } })).status).toBe(422);
    // Allowlisted create succeeds.
    const b = await j('POST', '/v1/admin/books', { token: su, body: { title: 'New Book', retailer: 'Amazon', url: 'https://www.amazon.ca/dp/123' } });
    expect(b.status).toBe(200);
    // Add a second per-platform buy link; off-allowlist rejected, allowlisted accepted.
    expect((await j('POST', `/v1/admin/books/${b.body.id}/links`, { token: su, body: { retailer: 'Bad', url: 'https://evil.example.com/x' } })).status).toBe(422);
    const link = await j('POST', `/v1/admin/books/${b.body.id}/links`, { token: su, body: { retailer: 'Kobo', url: 'https://www.kobo.com/ca/en/ebook/new-book' } });
    expect(link.status).toBe(200);
    // Book now has two retailer links.
    const listed = (await j('GET', '/v1/admin/books', { token: su })).body.items.find((x: any) => x.id === b.body.id);
    expect(listed.retailers.length).toBe(2);
    // Toggle a link off, then delete it.
    expect((await j('PATCH', `/v1/admin/books/${b.body.id}/links/${link.body.id}`, { token: su, body: { active: false } })).status).toBe(200);
    expect((await j('DELETE', `/v1/admin/books/${b.body.id}/links/${link.body.id}`, { token: su })).status).toBe(200);
    // Edit the book itself.
    expect((await j('PATCH', `/v1/admin/books/${b.body.id}`, { token: su, body: { author: 'A. New', active: false } })).status).toBe(200);
    // RBAC: content editor lacks book.manage.
    expect((await j('POST', '/v1/admin/books', { token: ce, body: { title: 'Nope', retailer: 'Amazon', url: 'https://amazon.ca/dp/1' } })).status).toBe(403);
  });
});

describe('service health ops (§27) — Super-Admin only (decision 4-c)', () => {
  it('background jobs: lists the real worker definitions (super only)', async () => {
    const r = await j('GET', '/v1/admin/ops/jobs', { token: su });
    expect(r.status).toBe(200);
    const keys = r.body.jobs.map((x: any) => x.key).sort();
    expect(keys).toEqual(['announcement_publisher', 'overdue_finalizer', 'streak_reconcile']);
    for (const job of r.body.jobs) {
      expect(typeof job.name).toBe('string');
      expect(typeof job.runs_total).toBe('number');
      expect(typeof job.pg_cron_in_prod).toBe('boolean');
    }
  });
  it('infrastructure: seam reports not-configured, no fake actions', async () => {
    const r = await j('GET', '/v1/admin/ops/infrastructure', { token: su });
    expect(r.status).toBe(200);
    expect(r.body.backup.configured).toBe(false);
    expect(r.body.disaster_recovery.configured).toBe(false);
    expect(r.body.failover.configured).toBe(false);
    expect(r.body.backup.provider).toBeNull();
  });
  it('RBAC: non-super admins (support + content) are denied', async () => {
    expect((await j('GET', '/v1/admin/ops/jobs', { token: sup })).status).toBe(403);
    expect((await j('GET', '/v1/admin/ops/jobs', { token: ce })).status).toBe(403);
    expect((await j('GET', '/v1/admin/ops/infrastructure', { token: ce })).status).toBe(403);
  });
});

describe('admin accounts (§22, §28.2)', () => {
  it('list (RBAC) + create with temp password + last-super-admin guard', async () => {
    expect((await j('GET', '/v1/admin/accounts', { token: su })).body.items.length).toBeGreaterThanOrEqual(3);
    expect((await j('GET', '/v1/admin/accounts', { token: sup })).status).toBe(403);
    const created = await j('POST', '/v1/admin/accounts', { token: su, body: { email: 'new' + Date.now() + '@cm.ca', display_name: 'New', role: 'admin', permissions: ['student.directory'] } });
    expect(created.status).toBe(200); expect(typeof created.body.temp_password).toBe('string');
    const guard = await j('PATCH', '/v1/admin/accounts/a9000000-0000-0000-0000-000000000001', { token: su, body: { status: 'disabled' } });
    expect(guard.status).toBe(409); expect(guard.body.error.code).toBe('LAST_SUPER_ADMIN');
  });
  it('permission catalog', async () => {
    expect((await j('GET', '/v1/admin/permissions', { token: su })).body.items.length).toBeGreaterThanOrEqual(25);
  });
  it('permission bundles: every bundle key exists in the catalog and is non-SA', async () => {
    const cat = (await j('GET', '/v1/admin/permissions', { token: su })).body.items;
    const nonSa = new Set(cat.filter((p: any) => !p.super_admin_only).map((p: any) => p.key));
    const r = await j('GET', '/v1/admin/permissions/bundles', { token: su });
    expect(r.status).toBe(200);
    expect(r.body.bundles.length).toBeGreaterThanOrEqual(4);
    for (const b of r.body.bundles) {
      expect(b.permissions.length).toBeGreaterThan(0);
      for (const p of b.permissions) expect(nonSa.has(p)).toBe(true); // no fake/SA-only keys
    }
  });
  it('edit existing admin access (role + permissions) then reset password', async () => {
    const created = await j('POST', '/v1/admin/accounts', { token: su, body: { email: 'edit' + Date.now() + '@cm.ca', display_name: 'Edit Me', role: 'admin', permissions: ['student.directory'] } });
    const id = created.body.id;
    const bundles = (await j('GET', '/v1/admin/permissions/bundles', { token: su })).body.bundles;
    const comms = bundles.find((b: any) => b.key === 'comms_manager');
    const patch = await j('PATCH', `/v1/admin/accounts/${id}`, { token: su, body: { permissions: comms.permissions } });
    expect(patch.status).toBe(200);
    const after = (await j('GET', '/v1/admin/accounts', { token: su })).body.items.find((a: any) => a.id === id);
    expect([...after.permissions].sort()).toEqual([...comms.permissions].sort());
    const reset = await j('POST', `/v1/admin/accounts/${id}/reset-password`, { token: su });
    expect(reset.status).toBe(200); expect(typeof reset.body.temp_password).toBe('string');
  });
  it('RBAC: bundles readable by any admin; account writes require admin.manage', async () => {
    expect((await j('GET', '/v1/admin/permissions/bundles', { token: sup })).status).toBe(200);
    expect((await j('POST', '/v1/admin/accounts/a9000000-0000-0000-0000-000000000002/reset-password', { token: sup })).status).toBe(403);
  });
});

describe('gamification management (§19, §20)', () => {
  it('avatar family create makes 7 draft stages; activating all 7 makes it live', async () => {
    const created = await j('POST', '/v1/admin/rewards/avatars/families', { token: su, body: { key: 'tfam_' + Date.now(), name: 'TestFam' } });
    expect(created.status).toBe(200);
    const list = await j('GET', '/v1/admin/rewards/avatars', { token: su });
    const fam = list.body.items.find((f: any) => f.family_id === created.body.id);
    expect(fam.stages.length).toBe(7);
    expect(fam.live).toBe(false);
    for (const s of fam.stages) await j('PATCH', `/v1/admin/rewards/avatars/stages/${s.id}`, { token: su, body: { active: true } });
    const list2 = await j('GET', '/v1/admin/rewards/avatars', { token: su });
    const fam2 = list2.body.items.find((f: any) => f.family_id === created.body.id);
    expect(fam2.active_stages).toBe(7);
    expect(fam2.live).toBe(true);
  });
  it('RBAC: support (no avatar.manage) cannot create a family', async () => {
    const denied = await j('POST', '/v1/admin/rewards/avatars/families', { token: sup, body: { key: 'x' + Date.now(), name: 'X' } });
    expect(denied.status).toBe(403);
  });
  it('theme + achievement activate toggles work (state restored to avoid cross-test pollution)', async () => {
    const themes = await j('GET', '/v1/admin/rewards/themes', { token: su });
    const t = themes.body.items[0];
    expect((await j('PATCH', `/v1/admin/rewards/themes/${t.id}`, { token: su, body: { active: !t.active } })).status).toBe(200);
    await j('PATCH', `/v1/admin/rewards/themes/${t.id}`, { token: su, body: { active: t.active } }); // restore
    const achs = await j('GET', '/v1/admin/rewards/achievements', { token: su });
    const a = achs.body.items[0];
    expect((await j('PATCH', `/v1/admin/rewards/achievements/versions/${a.version_id}`, { token: su, body: { active: !a.active } })).status).toBe(200);
    await j('PATCH', `/v1/admin/rewards/achievements/versions/${a.version_id}`, { token: su, body: { active: a.active } }); // restore
  });
});

describe('economy config + integrity (§19, §30)', () => {
  it('reads config+integrity, publishes a version (RBAC), restores, recomputes', async () => {
    const before = await j('GET', '/v1/admin/rewards/economy', { token: su });
    expect(before.status).toBe(200);
    expect(typeof before.body.config.base_xp.easy).toBe('number');
    expect(typeof before.body.integrity.healthy).toBe('boolean');
    // support cannot publish
    expect((await j('POST', '/v1/admin/rewards/economy/config', { token: sup, body: { base_xp: { easy: 99 } } })).status).toBe(403);
    // super publishes a new version → GET reflects it
    expect((await j('POST', '/v1/admin/rewards/economy/config', { token: su, body: { base_xp: { easy: 13 }, version_label: 't' } })).status).toBe(200);
    expect((await j('GET', '/v1/admin/rewards/economy', { token: su })).body.config.base_xp.easy).toBe(13);
    // restore defaults so scoring tests are unaffected
    await j('POST', '/v1/admin/rewards/economy/config', { token: su, body: { base_xp: { easy: 10, medium: 15, hard: 20 }, streak_milestones: { '3': 10, '7': 25, '14': 60, '30': 150 } } });
    expect((await j('GET', '/v1/admin/rewards/economy', { token: su })).body.config.base_xp.easy).toBe(10);
    // recompute (safe: rebuilds caches from ledger)
    const rc = await j('POST', '/v1/admin/rewards/economy/recompute', { token: su });
    expect(rc.status).toBe(200); expect(typeof rc.body.xp).toBe('number');
    expect((await j('POST', '/v1/admin/rewards/economy/recompute', { token: sup })).status).toBe(403);
  });
});

describe('content set browser (§17,§18)', () => {
  const SETV = 'e1000000-0000-0000-0000-000000000001'; // seeded published set
  it('sets list carries difficulty + subcategory; copy → draft; draft delete + guards', async () => {
    const list = await j('GET', '/v1/admin/content/sets', { token: ce });
    expect(list.status).toBe(200);
    const seed = list.body.items.find((s: any) => s.id === SETV);
    expect(seed).toBeTruthy();
    expect(seed.difficulty_key).toBeTruthy();          // backfilled by 0012
    expect(typeof seed.subcategory).toBe('string');
    // copy → new draft with same difficulty
    const copy = await j('POST', `/v1/admin/content/sets/${SETV}/copy`, { token: ce });
    expect(copy.status).toBe(200);
    const after = await j('GET', '/v1/admin/content/sets', { token: ce });
    const made = after.body.items.find((s: any) => s.id === copy.body.id);
    expect(made.state).toBe('draft'); expect(made.difficulty_key).toBe(seed.difficulty_key);
    // unpublish only applies to published sets: a draft is rejected (does not touch the shared set)
    expect((await j('POST', `/v1/admin/content/sets/${copy.body.id}/unpublish`, { token: ce })).status).toBe(409);
    // delete the draft copy (cleanup — no pollution of the shared published set)
    expect((await j('DELETE', `/v1/admin/content/sets/${copy.body.id}`, { token: ce })).status).toBe(200);
    expect((await j('GET', '/v1/admin/content/sets', { token: ce })).body.items.find((s: any) => s.id === copy.body.id)).toBeUndefined();
    // RBAC: student-support lacks content.create
    expect((await j('POST', `/v1/admin/content/sets/${SETV}/copy`, { token: sup })).status).toBe(403);
  });
});
