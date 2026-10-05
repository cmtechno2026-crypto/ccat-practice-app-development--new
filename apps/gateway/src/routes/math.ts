import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { hashSecret, verifySecret, hashToken } from '../security/crypto.js';
import {
  signGrant, verifyGrant, grantValidated, type RegistrationGrant,
  signToken, newRefreshToken,
} from '../security/token.js';
import { isWeakPin } from '../lib/pin.js';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

// ============================================================================
// Math Olympiad — site-scoped STUDENT API (site = 'math').
//
// Self-contained: CCAT's own routes (registration.ts, auth.ts, …) are NOT
// touched. Every account/email check and the login lookup are scoped to
// site='math', so Math accounts are fully separate from CCAT even though both
// live in the shared `ccat` schema (D2). Registration is OTP-free. Reads that
// depend on Math CONTENT (catalog, quiz, leaderboard, billing) return empty
// for now — Math content is authored later — so the client works end-to-end
// against a real, separate account without 404s.
// ============================================================================

const SITE = 'math';

export function registerMathRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  // ---- shared: is this guardian email already tied to a live MATH account? ----
  async function emailInUse(email: string, exceptGuardianId?: string): Promise<boolean> {
    const r = await db.query(
      `select 1 from ccat.guardian_contacts gc
         join ccat.student_guardians sg on sg.guardian_id = gc.id
         join ccat.students s on s.id = sg.student_id
        where gc.email = $1 and s.status <> 'purged' and s.site_id = $2
          and ($3::uuid is null or gc.id <> $3)
        limit 1`,
      [email, SITE, exceptGuardianId ?? null],
    );
    return r.rows.length > 0;
  }

  // ---- grades (shared table; client filters to its range) ----
  app.get('/v1/math/grades', async () => {
    const { rows } = await db.query(
      `select id, grade_number, name from ccat.grades where active = true and registration_enabled = true order by grade_number`,
    );
    return rows;
  });

  // ---- registration: email availability (site-scoped) ----
  app.get('/v1/math/registration/email-available', async (req) => {
    const email = String((req.query as { email?: string } | undefined)?.email ?? '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return { available: false };
    return { available: !(await emailInUse(email)) };
  });

  // ---- registration: contact (validate + persist guardian; NO OTP) ----
  const contactSchema = z.object({
    guardian_name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email('A valid email is required'),
    phone: z.string().trim().min(4),
    registration_grant: z.string().optional(),
  });
  app.post('/v1/math/registration/contact', async (req, reply) => {
    const body = contactSchema.parse(req.body);
    const email = body.email;
    const parsed = parsePhoneNumberFromString(body.phone);
    if (!parsed || !parsed.isValid()) {
      throw Errors.validation('Enter a valid phone number including its country code (e.g. +14165551234).', { field: 'phone' });
    }
    const phoneE164 = parsed.number;
    const takenError = () => Errors.conflict('EMAIL_IN_USE', 'This email is already registered to a Math Olympiad account. Please use a different email.', { field: 'email' });

    let guardianId: string;
    if (body.registration_grant) {
      const prev = verifyGrant(body.registration_grant, cfg.hmacSecret);
      if (!prev) throw Errors.unauthorized('Invalid or expired registration grant');
      guardianId = prev.guardianId;
      if (await emailInUse(email, guardianId)) throw takenError();
      await db.query(
        `update ccat.guardian_contacts set name=$2, email=$3, phone=$4, updated_at=now() where id=$1`,
        [guardianId, body.guardian_name, email, phoneE164],
      );
    } else {
      if (await emailInUse(email)) throw takenError();
      const gc = await db.query(
        `insert into ccat.guardian_contacts(name, email, phone) values ($1,$2,$3) returning id`,
        [body.guardian_name, email, phoneE164],
      );
      guardianId = gc.rows[0]!.id;
    }

    const grant: RegistrationGrant = {
      guardianId, guardianName: body.guardian_name,
      guardianEmail: email, guardianPhone: phoneE164,
      validated: true,
      exp: Math.floor(Date.now() / 1000) + 1800,
    };
    reply.code(200);
    return { registration_grant: signGrant(grant, cfg.hmacSecret), guardian_email: email, guardian_phone: phoneE164 };
  });

  // ---- registration: consent ----
  const consentSchema = z.object({
    registration_grant: z.string(),
    policy_version: z.string(),
    consent_hash: z.string(),
  });
  app.post('/v1/math/registration/consent', async (req, reply) => {
    const body = consentSchema.parse(req.body);
    const grant = verifyGrant(body.registration_grant, cfg.hmacSecret);
    if (!grant) throw Errors.unauthorized('Invalid or expired registration grant');
    if (!grantValidated(grant)) throw Errors.validation('Guardian contact must be validated first');
    const next: RegistrationGrant = { ...grant, policyVersion: body.policy_version, consentHash: body.consent_hash };
    reply.code(200);
    return { registration_grant: signGrant(next, cfg.hmacSecret) };
  });

  // ---- registration: create the student (site='math') ----
  const studentSchema = z.object({
    registration_grant: z.string(),
    display_name: z.string().min(1),
    username: z.string().min(3).max(40),
    grade_id: z.string().uuid(),
    birth_month: z.number().int().min(1).max(12),
    birth_year: z.number().int().min(1990).max(2100),
    pin: z.string().min(6).max(8),
    device_hash: z.string().min(3),
    referral_code: z.string().trim().min(4).max(16).optional(),
  });
  app.post('/v1/math/registration/student', async (req) => {
    const body = studentSchema.parse(req.body);
    const grant = verifyGrant(body.registration_grant, cfg.hmacSecret);
    if (!grant) throw Errors.unauthorized('Invalid registration grant');
    if (!grantValidated(grant)) throw Errors.validation('Guardian contact must be validated first');
    if (!grant.policyVersion || !grant.consentHash) throw Errors.validation('Consent not recorded');

    const g = await db.query(`select id, active, registration_enabled from ccat.grades where id=$1`, [body.grade_id]);
    if (g.rows.length === 0) throw Errors.validation('Unknown grade');
    const grade = g.rows[0]!;
    if (!grade.active || !grade.registration_enabled) throw Errors.forbidden('REGISTRATION_DISABLED', 'Registration is not enabled for this grade');
    if (isWeakPin(body.pin, { year: body.birth_year, month: body.birth_month })) throw Errors.weakPin();

    const pinHash = await hashSecret(body.pin, cfg.pinPepper);
    try {
      const studentId = await withTransaction(db, async (client) => {
        const gcheck = await client.query(
          `select id from ccat.guardian_contacts where id=$1 and email is not null and phone is not null`,
          [grant.guardianId],
        );
        if (gcheck.rows.length === 0) throw Errors.validation('Guardian contact not found — re-enter the guardian details');
        const student = await client.query(
          `insert into ccat.students(username_normalized, display_name, grade_id, birth_month, birth_year, site_id)
           values ($1,$2,$3,$4,$5,$6) returning id`,
          [body.username, body.display_name, body.grade_id, body.birth_month, body.birth_year, SITE],
        );
        const sid = student.rows[0]!.id as string;
        await client.query(`insert into ccat.student_credentials(student_id, pin_hash) values ($1,$2)`, [sid, pinHash]);
        await client.query(
          `insert into ccat.student_guardians(student_id, guardian_id, relationship, is_primary) values ($1,$2,'guardian',true)`,
          [sid, grant.guardianId],
        );
        await client.query(
          `insert into ccat.consents(student_id, guardian_id, policy_version, consent_hash) values ($1,$2,$3,$4)`,
          [sid, grant.guardianId, grant.policyVersion, grant.consentHash],
        );
        await client.query(
          `insert into ccat.student_devices(student_id, device_hash, status, enrolled_at) values ($1,$2,'active',now())`,
          [sid, body.device_hash],
        );
        return sid;
      });
      return { id: studentId };
    } catch (e) {
      // Global username uniqueness (students_username_unique).
      if ((e as { code?: string }).code === '23505') throw Errors.usernameTaken();
      throw e;
    }
  });

  // ---- auth: account-by-email (multi-child picker; site-scoped) ----
  app.get('/v1/math/auth/account-by-email', async (req) => {
    const email = String((req.query as { email?: string } | undefined)?.email ?? '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return { exists: false, usernames: [] as string[] };
    const { rows } = await db.query(
      `select s.username_normalized as username
         from ccat.guardian_contacts gc
         join ccat.student_guardians sg on sg.guardian_id = gc.id
         join ccat.students s on s.id = sg.student_id
        where gc.email = $1 and s.status <> 'purged' and s.site_id = $2
        order by s.created_at asc`,
      [email, SITE],
    );
    const usernames = rows.map((r: { username: string }) => String(r.username));
    return { exists: usernames.length > 0, usernames };
  });

  // ---- auth: login (site-scoped to 'math') ----
  const loginSchema = z.object({ username: z.string(), pin: z.string().min(4).max(8), device_hash: z.string() });
  const loginMax = cfg.env === 'production' ? 20 : 2000;
  app.post('/v1/math/auth/login', { config: { rateLimit: { max: loginMax, timeWindow: '1 minute' } } }, async (req) => {
    const body = loginSchema.parse(req.body);
    const { rows } = await db.query(
      `select s.id, s.status, s.is_preview, c.pin_hash, c.failed_attempts, c.locked_until
         from ccat.students s
         join ccat.student_credentials c on c.student_id = s.id
        where s.username_normalized = $1 and s.site_id = $2`,
      [body.username, SITE],
    );
    if (rows.length === 0) throw Errors.unauthorized('Invalid credentials');
    const s = rows[0]!;
    if (s.locked_until && new Date(s.locked_until) > new Date()) throw Errors.rateLimited('Temporarily locked');
    const ok = await verifySecret(body.pin, cfg.pinPepper, s.pin_hash);
    if (!ok) {
      await db.query(
        `update ccat.student_credentials
            set failed_attempts = failed_attempts + 1,
                locked_until = case when failed_attempts + 1 >= 5 then now() + interval '5 minutes' else locked_until end
          where student_id = $1`,
        [s.id],
      );
      throw Errors.unauthorized('Invalid credentials');
    }
    if (s.status !== 'active') throw Errors.forbidden('ACCOUNT_NOT_ACTIVE', `Account is ${s.status}`);

    // One active device at a time (free switching), mirroring CCAT auth.
    const active = await db.query(
      `select id, device_hash from ccat.student_devices where student_id=$1 and status='active'`,
      [s.id],
    );
    let enrolled: { id: string } | null = active.rows[0] ? { id: active.rows[0].id } : null;
    if (!s.is_preview && active.rows[0] && active.rows[0].device_hash !== body.device_hash) {
      await db.query(`update ccat.student_devices set status='revoked', revoked_at=now(), revoked_reason=$2 where id=$1`, [active.rows[0].id, 'device_switch']);
      await db.query(`update ccat.auth_sessions set revoked_at=now(), revoked_reason=$2 where student_id=$1 and revoked_at is null`, [s.id, 'device_switch']);
      enrolled = null;
    }
    if (!enrolled) {
      const ins = await db.query(
        `insert into ccat.student_devices (student_id, device_hash, status, enrolled_at)
         select $1,$2,'active',now()
          where not exists (select 1 from ccat.student_devices where student_id=$1 and status='active')
         returning id`,
        [s.id, body.device_hash],
      );
      if (ins.rows.length > 0) enrolled = { id: ins.rows[0]!.id };
      else {
        const again = await db.query(`select id from ccat.student_devices where student_id=$1 and status='active'`, [s.id]);
        enrolled = again.rows[0] ? { id: again.rows[0].id } : null;
      }
    }
    if (!enrolled) throw Errors.forbidden('DEVICE_ENROLL_FAILED', 'Could not register this device; please try again');

    await db.query('update ccat.student_credentials set failed_attempts=0, locked_until=null where student_id=$1', [s.id]);
    const refresh = newRefreshToken();
    const authSession = await db.query(
      `insert into ccat.auth_sessions(student_id, device_id, refresh_hash, expires_at)
       values ($1,$2,$3, now() + ($4 || ' seconds')::interval) returning id`,
      [s.id, enrolled.id, hashToken(refresh, cfg.pinPepper), String(cfg.refreshTokenTtlSeconds)],
    );
    const sid = authSession.rows[0]!.id;
    const access = signToken({ sub: s.id, did: enrolled.id, sid, exp: Math.floor(Date.now() / 1000) + cfg.accessTokenTtlSeconds }, cfg.hmacSecret);
    await db.query('update ccat.student_devices set last_seen_at=now() where id=$1', [enrolled.id]);
    return { access_token: access, refresh_token: refresh, expires_in: cfg.accessTokenTtlSeconds };
  });

  // ======================= authenticated reads =======================
  const authed = { preHandler: [app.authenticateStudent] };

  async function levelFor(xp: number): Promise<{ level: number; tier: string; nextXp: number }> {
    const cur = await db.query(`select level, tier_name from ccat.math_levels where min_xp <= $1 order by min_xp desc limit 1`, [xp]);
    const nxt = await db.query(`select min_xp from ccat.math_levels where min_xp > $1 order by min_xp asc limit 1`, [xp]);
    const level = cur.rows[0]?.level ?? 1;
    const tier = cur.rows[0]?.tier_name ?? 'Bronze';
    const nextXp = nxt.rows[0]?.min_xp != null ? Number(nxt.rows[0].min_xp) - xp : 0;
    return { level, tier, nextXp };
  }

  app.get('/v1/math/profile', authed, async (req) => {
    const sid = req.student!.studentId;
    const { rows } = await db.query(
      `select s.id, s.display_name, s.username_normalized as username, s.grade_id, s.cached_xp_total,
              g.grade_number, g.name as grade_name,
              gc.email as guardian_email, gc.name as guardian_name, gc.phone as guardian_phone
         from ccat.students s
         left join ccat.grades g on g.id = s.grade_id
         left join ccat.student_guardians sg on sg.student_id = s.id and sg.is_primary = true
         left join ccat.guardian_contacts gc on gc.id = sg.guardian_id
        where s.id = $1`,
      [sid],
    );
    if (rows.length === 0) throw Errors.notFound('Student not found');
    const r = rows[0]!;
    const xp = Number(r.cached_xp_total ?? 0);
    const { level, tier } = await levelFor(xp);
    return {
      id: r.id, display_name: r.display_name, username: r.username,
      email: r.guardian_email ?? '', mobile: r.guardian_phone ?? '',
      grade: r.grade_name ?? (r.grade_number != null ? `Grade ${r.grade_number}` : ''),
      country: 'Canada', timezone: null, level, tier,
      parent_name: r.guardian_name ?? '', parent_email: r.guardian_email ?? '', parent_mobile: r.guardian_phone ?? '',
    };
  });

  app.get('/v1/math/rewards/summary', authed, async (req) => {
    const sid = req.student!.studentId;
    const { rows } = await db.query(`select cached_xp_total, cached_coin_balance from ccat.students where id=$1`, [sid]);
    const xp = Number(rows[0]?.cached_xp_total ?? 0);
    const coins = Number(rows[0]?.cached_coin_balance ?? 0);
    const { level, tier, nextXp } = await levelFor(xp);
    const prev = await db.query(`select min_xp from ccat.math_levels where level=$1`, [level]);
    const span = Math.max(1, nextXp + (xp - Number(prev.rows[0]?.min_xp ?? 0)));
    const pct = nextXp > 0 ? Math.round(((xp - Number(prev.rows[0]?.min_xp ?? 0)) / span) * 100) : 100;
    return { xp_total: xp, coin_balance: coins, level, tier, xp_to_next: nextXp, level_pct: pct, streak: { current: 0, longest: 0 } };
  });

  app.get('/v1/math/progress', authed, async () => ({ accuracy_pct: 0, weak_area: null }));
  app.get('/v1/math/contest/next', authed, async () => {
    const { rows } = await db.query(`select name, starts_at from ccat.math_contests where site_id=$1 and starts_at > now() order by starts_at asc limit 1`, [SITE]);
    if (rows.length === 0) return null;
    const d = new Date(rows[0]!.starts_at); const now = Date.now();
    const ms = Math.max(0, d.getTime() - now);
    return { name: rows[0]!.name, date: d.toUTCString(), days: Math.floor(ms / 86400000), hours: Math.floor(ms / 3600000) % 24, minutes: Math.floor(ms / 60000) % 60 };
  });

  // Content-dependent reads — empty until Math content is authored.
  app.get('/v1/math/assignments', authed, async () => [] as unknown[]);
  app.get('/v1/math/catalog', authed, async () => [] as unknown[]);
  app.get('/v1/math/leaderboard', authed, async () => [] as unknown[]);
  app.get('/v1/math/activity', authed, async () => [] as unknown[]);
  app.get('/v1/math/activity/heatmap', authed, async () => [] as number[]);
  app.get('/v1/math/entitlements', authed, async () => ({ active: [] as unknown[], expired: [] as unknown[] }));
  app.get('/v1/math/billing/transactions', authed, async () => [] as unknown[]);
  app.post('/v1/math/sessions/start', authed, async () => ({ sessionId: '', questions: [] as unknown[] }));
  app.get('/v1/math/sessions/:id/result', authed, async () => { throw Errors.notFound('No result'); });

  // Bookmarks — kept empty/no-op for v1 (no content to bookmark yet).
  app.get('/v1/math/bookmarks', authed, async () => [] as unknown[]);
  app.delete('/v1/math/bookmarks', authed, async (_req, reply) => { reply.code(204); return null; });

  // ---- Notes (real, backed by ccat.student_notes) ----
  app.get('/v1/math/notes', authed, async (req) => {
    const sid = req.student!.studentId;
    const { rows } = await db.query(
      `select id, notebook, title, body, accent, to_char(updated_at,'YYYY-MM-DD') as updated_at
         from ccat.student_notes where student_id=$1 and site_id=$2 order by updated_at desc`,
      [sid, SITE],
    );
    return rows;
  });
  const noteSchema = z.object({ title: z.string().min(1).max(200), body: z.string().max(10000).optional() });
  app.post('/v1/math/notes', authed, async (req) => {
    const sid = req.student!.studentId;
    const b = noteSchema.parse(req.body);
    const { rows } = await db.query(
      `insert into ccat.student_notes(student_id, site_id, title, body) values ($1,$2,$3,$4)
       returning id, notebook, title, body, accent, to_char(updated_at,'YYYY-MM-DD') as updated_at`,
      [sid, SITE, b.title, b.body ?? ''],
    );
    return rows[0];
  });
  app.patch('/v1/math/notes/:id', authed, async (req) => {
    const sid = req.student!.studentId;
    const id = (req.params as { id: string }).id;
    const b = noteSchema.parse(req.body);
    const { rows } = await db.query(
      `update ccat.student_notes set title=$3, body=$4, updated_at=now()
         where id=$1 and student_id=$2
       returning id, notebook, title, body, accent, to_char(updated_at,'YYYY-MM-DD') as updated_at`,
      [id, sid, b.title, b.body ?? ''],
    );
    if (!rows[0]) throw Errors.notFound('Note not found');
    return rows[0];
  });
  app.delete('/v1/math/notes/:id', authed, async (req, reply) => {
    const sid = req.student!.studentId;
    const id = (req.params as { id: string }).id;
    await db.query(`delete from ccat.student_notes where id=$1 and student_id=$2`, [id, sid]);
    reply.code(204); return null;
  });

  // ---- Assigned teachers ----
  // Returns the teachers assigned to THIS student from the admin's assignment
  // table (ccat.teacher_students -> ccat.admin_profiles where is_teacher=true).
  // Assignments are made on the Teachers page in Web Admin. Shape matches the
  // client Teacher type { id, name }.
  app.get('/v1/math/teachers', authed, async (req) => {
    const sid = req.student!.studentId;
    const { rows } = await db.query(
      `select p.id, p.display_name as name
         from ccat.teacher_students ts
         join ccat.admin_profiles p on p.id = ts.teacher_admin_id
        where ts.student_id = $1 and p.is_teacher = true
        order by p.display_name`,
      [sid],
    );
    return rows;
  });

  // ---- Support chat — SHARED model with the admin Support console. ----
  // Both the student app and the admin console read/write the SAME ccat.support_cases row
  // (one Math case per student, site='math') + ccat.support_messages. Previously the student
  // side keyed messages on the raw student_id while the admin keyed on support_cases.id, so the
  // two threads never met. Now the case is get-or-created from either side and both use case_id.
  async function mathSupportRef(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const { rows } = await db.query(`select 'SUP-' || upper(substr(md5(gen_random_uuid()::text), 1, 6)) as ref`);
      const ref = rows[0]!.ref as string;
      const clash = await db.query('select 1 from ccat.support_cases where reference=$1', [ref]);
      if (clash.rows.length === 0) return ref;
    }
    throw new Error('Could not allocate a unique support reference');
  }
  async function mathCaseId(studentId: string, create: boolean): Promise<string | null> {
    const ex = await db.query(
      `select id from ccat.support_cases where student_id=$1 and site_id=$2 order by created_at desc limit 1`,
      [studentId, SITE],
    );
    if (ex.rows.length > 0) return ex.rows[0]!.id as string;
    if (!create) return null;
    const ref = await mathSupportRef();
    const cr = await db.query(
      `insert into ccat.support_cases (student_id, opened_by, reference, summary, state, site_id)
       values ($1, null, $2, 'Student-initiated conversation', 'open', $3) returning id`,
      [studentId, ref, SITE],
    );
    return cr.rows[0]!.id as string;
  }

  app.get('/v1/math/support/threads', authed, async (req) => {
    const sid = req.student!.studentId;
    return [{ id: sid, name: 'Relationship Manager', preview: 'Ask a question any time.', time: '' }];
  });
  app.get('/v1/math/support/threads/:id/messages', authed, async (req) => {
    const sid = req.student!.studentId;
    const caseId = await mathCaseId(sid, false);
    if (!caseId) return [] as unknown[];
    const { rows } = await db.query(
      `select id, (sender='student') as me, body as text, to_char(created_at,'HH24:MI') as at
         from ccat.support_messages where case_id=$1 order by created_at asc`,
      [caseId],
    );
    return rows;
  });
  const msgSchema = z.object({ text: z.string().min(1).max(4000) });
  app.post('/v1/math/support/threads/:id/messages', authed, async (req) => {
    const sid = req.student!.studentId;
    const b = msgSchema.parse(req.body);
    const caseId = (await mathCaseId(sid, true))!;
    await db.query(`update ccat.support_cases set updated_at = now() where id = $1`, [caseId]);
    const { rows } = await db.query(
      `insert into ccat.support_messages(case_id, sender, body) values ($1,'student',$2)
       returning id, (sender='student') as me, body as text, to_char(created_at,'HH24:MI') as at`,
      [caseId, b.text],
    );
    return rows[0];
  });
}
