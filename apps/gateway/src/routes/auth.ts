import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { verifySecret, hashToken } from '../security/crypto.js';
import { signToken, newRefreshToken } from '../security/token.js';
import { sendEmail, emailConfigured, renderEmail, emailUI } from '../lib/email.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Fire-and-forget guardian alert when a login lock TRIPS for the first time in a failed-attempt streak.
// Called with `void` from the login handler — it never awaits and swallows every error, so a slow or
// failed email can never affect (or fail) the login request. Silent no-op when email isn't configured or
// the account has no guardian on file. Preview accounts are filtered out by the caller.
async function notifyGuardianOfLockout(db: DB, cfg: Config, studentId: string, log?: { info?: (...a: any[]) => void; warn?: (...a: any[]) => void }): Promise<void> {
  try {
    if (!emailConfigured(cfg)) return;
    const r = await db.query(
      `select s.display_name, gc.email as guardian_email, gc.name as guardian_name
         from ccat.students s
         join ccat.student_guardians sg on sg.student_id = s.id and sg.is_primary = true
         join ccat.guardian_contacts gc on gc.id = sg.guardian_id
        where s.id = $1
        limit 1`,
      [studentId],
    );
    const row = r.rows[0];
    if (!row?.guardian_email) return;
    const child = escapeHtml(row.display_name || 'your child');
    const name = escapeHtml(row.guardian_name || 'there');
    const html = renderEmail(cfg,
      emailUI.h1('Sign-in temporarily locked') +
      emailUI.sub(`Hello ${name},`) +
      emailUI.p(`Sign-in to ${child}'s CCAT Practice account is temporarily locked after several unsuccessful attempts. Please try again after the lock expires — it clears automatically.`) +
      emailUI.p('<span style="color:#e5443f;font-weight:700">If your child has forgotten their PIN, you can reset it using the "Forgot PIN?" link on the sign-in page.</span>') +
      emailUI.p('If you do not recognize these attempts, reset the PIN and contact our support team.'),
    );
    await sendEmail(cfg, { to: row.guardian_email, subject: 'Security notice: sign-in temporarily locked — CCAT Practice', html }, log);
  } catch (e) {
    log?.warn?.({ err: (e as Error).message }, 'lockout guardian alert failed');
  }
}

const loginSchema = z.object({
  username: z.string(),
  // Password login. New accounts use a 6–8 char password; existing families kept a 4-digit code. Login
  // therefore accepts 4–8 characters (any content) so grandfathered PINs keep working. The wire field is
  // still named `pin` for client/mobile compatibility — it now carries a password.
  pin: z.string().min(4).max(8),
  device_hash: z.string(),
  // When true and the account is pending_deletion, cancel the deletion and sign in (self-restore).
  restore: z.boolean().optional(),
});

export function registerAuthRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  // Rate-limit login (all logins, preview included) so the public/guessable preview credentials
  // can't be used to hammer the backend. Tight in production; relaxed in local/dev/test so smoke
  // scripts and the vitest suite (many logins from one IP) aren't throttled. Reuses @fastify/rate-limit.
  const loginMax = cfg.env === 'production' ? 20 : 2000;
  app.post('/v1/auth/login', { config: { rateLimit: { max: loginMax, timeWindow: '1 minute' } } }, async (req) => {
    const body = loginSchema.parse(req.body);
    const { rows } = await db.query(
      `select s.id, s.status, s.is_preview, c.pin_hash, c.failed_attempts, c.locked_until
         from ccat.students s
         join ccat.student_credentials c on c.student_id = s.id
        where s.username_normalized = $1`,
      [body.username],
    );
    // Uniform failure to avoid user enumeration.
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
      // Guardian alert on the FIRST trip of the lock (pre-increment failed_attempts was exactly 4, so this
      // 5th miss is what crosses the threshold). failed_attempts resets to 0 only on a successful login, so
      // re-locks after the 5-minute window expires (pre-increment value already >= 5) do NOT re-alert: at
      // most one email per attack burst, achieved with no throttle column or in-memory state. Skips preview
      // (shared teammate) accounts. Fire-and-forget — never awaited, never fails the login.
      // TODO(security): consider a CAPTCHA / proof-of-work challenge after N lockouts as a future step.
      if (!s.is_preview && Number(s.failed_attempts) === 4) {
        void notifyGuardianOfLockout(db, cfg, s.id, req.log);
      }
      throw Errors.unauthorized('Invalid credentials');
    }
    if (s.status !== 'active') {
      // Self-restore: a learner whose account is pending_deletion can CANCEL the deletion (within the
      // 30-day window) by re-submitting login with restore:true. The PIN is already verified above, so
      // this is authenticated. Any other non-active status (suspended/banned/purged) is never self-restorable.
      if (body.restore === true && s.status === 'pending_deletion') {
        await db.query('update ccat.students set status=$2, version=version+1, updated_at=now() where id=$1', [s.id, 'active']);
        await db.query(`update ccat.deletion_requests set state='restored', restored_at=now() where student_id=$1 and state='pending_deletion'`, [s.id]);
        await db.query(
          `insert into ccat.audit_log(actor_kind,event_type,target_kind,target_id,old_value,new_value) values ('student','student.self.deletion_cancelled','student',$1,$2,$3)`,
          [s.id, JSON.stringify({ status: 'pending_deletion' }), JSON.stringify({ status: 'active' })],
        );
        s.status = 'active';
      } else {
        throw Errors.forbidden('ACCOUNT_NOT_ACTIVE', `Account is ${s.status}`);
      }
    }

    // Device model: FREE SWITCHING, one active device at a time. A valid credential login always binds to
    // the presenting device — no OTP, no admin. Real students: if a DIFFERENT device is active, sign it out
    // (revoke that device + this student's live sessions) and enroll this browser, so exactly one device is
    // active at a time. The per-request middleware then rejects the old device (device_status != active),
    // which is how "logged in elsewhere" signs the previous browser out. Preview ids are shared by teammates
    // from many browsers, so they REUSE the one active preview device and never revoke each other. The
    // partial unique index student_devices_one_active keeps "one active row" race-safe.
    const enrollActive = async (): Promise<{ id: string } | null> => {
      const ins = await db.query(
        `insert into ccat.student_devices (student_id, device_hash, status, enrolled_at)
         select $1, $2, 'active', now()
          where not exists (select 1 from ccat.student_devices where student_id = $1 and status = 'active')
         returning id`,
        [s.id, body.device_hash],
      );
      if (ins.rows.length > 0) {
        await db.query(
          `insert into ccat.audit_log(actor_kind,event_type,target_kind,target_id,new_value)
           values ('student','device.enrolled','device',$1,$2)`,
          [ins.rows[0]!.id, JSON.stringify({ status: 'active', device_hash_prefix: String(body.device_hash).slice(0, 8) })],
        );
        return ins.rows[0]!;
      }
      // A concurrent login won the race — reuse whatever is now the single active device.
      const again = await db.query(
        `select id from ccat.student_devices where student_id = $1 and status = 'active'`,
        [s.id],
      );
      return again.rows[0] ?? null;
    };

    const active = await db.query(
      `select id, device_hash from ccat.student_devices where student_id = $1 and status = 'active'`,
      [s.id],
    );
    let enrolled: { id: string } | null = active.rows[0] ? { id: active.rows[0].id } : null;

    if (!s.is_preview && active.rows[0] && active.rows[0].device_hash !== body.device_hash) {
      // Switch to a new device: sign out the previously active device and all of this student's live
      // sessions, then enroll the presenting browser below as the new single active device.
      await db.query(
        `update ccat.student_devices set status='revoked', revoked_at=now(), revoked_reason=$2 where id=$1`,
        [active.rows[0].id, 'device_switch'],
      );
      await db.query(
        `update ccat.auth_sessions set revoked_at=now(), revoked_reason=$2 where student_id=$1 and revoked_at is null`,
        [s.id, 'device_switch'],
      );
      enrolled = null;
    }
    if (!enrolled) enrolled = await enrollActive();
    if (!enrolled) throw Errors.forbidden('DEVICE_ENROLL_FAILED', 'Could not register this device; please try again');

    await db.query('update ccat.student_credentials set failed_attempts = 0, locked_until = null where student_id = $1', [s.id]);

    const refresh = newRefreshToken();
    const authSession = await db.query(
      `insert into ccat.auth_sessions(student_id, device_id, refresh_hash, expires_at)
       values ($1,$2,$3, now() + ($4 || ' seconds')::interval) returning id`,
      [s.id, enrolled.id, hashToken(refresh, cfg.pinPepper), String(cfg.refreshTokenTtlSeconds)],
    );
    const sid = authSession.rows[0]!.id;
    const access = signToken(
      { sub: s.id, did: enrolled.id, sid, exp: Math.floor(Date.now() / 1000) + cfg.accessTokenTtlSeconds },
      cfg.hmacSecret,
    );
    await db.query('update ccat.student_devices set last_seen_at = now() where id = $1', [enrolled.id]);
    return { access_token: access, refresh_token: refresh, expires_in: cfg.accessTokenTtlSeconds };
  });

  // Exchange a valid refresh token for a fresh access token (and a rotated refresh token). This is what
  // keeps a signed-in student signed in past the short access-token TTL: the web/mobile client calls this
  // automatically when an authed request returns 401. The session id (sid) is preserved so the new access
  // token points at the same auth_sessions row — device binding, revocation and status checks all still
  // apply on every subsequent request. Rotation (new refresh_hash each call) means a leaked/older refresh
  // token stops working once a newer one is minted.
  const refreshSchema = z.object({ refresh_token: z.string().min(1), device_hash: z.string().optional() });
  app.post('/v1/auth/refresh', { config: { rateLimit: { max: cfg.env === 'production' ? 60 : 2000, timeWindow: '1 minute' } } }, async (req) => {
    const body = refreshSchema.parse(req.body);
    const presented = hashToken(body.refresh_token, cfg.pinPepper);
    const { rows } = await db.query(
      `select a.id as sid, a.student_id, a.device_id,
              s.status as student_status, d.status as device_status, d.device_hash
         from ccat.auth_sessions a
         join ccat.students s on s.id = a.student_id
         join ccat.student_devices d on d.id = a.device_id
        where a.refresh_hash = $1 and a.revoked_at is null and a.expires_at > now()`,
      [presented],
    );
    if (rows.length === 0) throw Errors.unauthorized('Invalid or expired refresh token');
    const row = rows[0]!;
    if (row.student_status !== 'active') throw Errors.forbidden('ACCOUNT_NOT_ACTIVE', `Account is ${row.student_status}`);
    if (row.device_status !== 'active') throw Errors.deviceNotEnrolled();
    // If the client sends its device hash, it must match the enrolled device (defence in depth; the
    // session's device binding + revocation already enforce single-device switching).
    if (body.device_hash && body.device_hash !== row.device_hash) throw Errors.unauthorized('Device mismatch');

    const nextRefresh = newRefreshToken();
    await db.query(
      `update ccat.auth_sessions
          set refresh_hash = $2, expires_at = now() + ($3 || ' seconds')::interval, last_used_at = now()
        where id = $1`,
      [row.sid, hashToken(nextRefresh, cfg.pinPepper), String(cfg.refreshTokenTtlSeconds)],
    );
    await db.query('update ccat.student_devices set last_seen_at = now() where id = $1', [row.device_id]);
    const access = signToken(
      { sub: row.student_id, did: row.device_id, sid: row.sid, exp: Math.floor(Date.now() / 1000) + cfg.accessTokenTtlSeconds },
      cfg.hmacSecret,
    );
    return { access_token: access, refresh_token: nextRefresh, expires_in: cfg.accessTokenTtlSeconds };
  });

  app.post('/v1/auth/logout', { preHandler: [app.authenticateStudent] }, async (req, reply) => {
    await db.query('update ccat.auth_sessions set revoked_at = now(), revoked_reason = $2 where id = $1', [
      req.student!.authSessionId,
      'logout',
    ]);
    reply.code(204);
    return null;
  });
}
