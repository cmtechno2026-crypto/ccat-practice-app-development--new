import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { verifySecret, hashToken } from '../security/crypto.js';
import { signToken, newRefreshToken } from '../security/token.js';
import { DEVICE_CUTOVER_REASON } from '../config.js';

const loginSchema = z.object({
  username: z.string(),
  pin: z.string().regex(/^\d{4}$/),
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

    // Single-device enforcement (§5.1, §5.4): login only from the enrolled active device.
    const dev = await db.query(
      `select id from ccat.student_devices where student_id = $1 and status = 'active'`,
      [s.id],
    );
    let enrolled = dev.rows[0] ?? null;
    if (!enrolled) {
      // One-time DOMAIN CUTOVER enroll-on-first-login. Strictly bounded — all must hold:
      //   • a cutover window is open (DEVICE_CUTOVER_DEADLINE is a future UTC instant),
      //   • this is a real student (never preview),
      //   • the student was part of the cutover (has a device revoked with DEVICE_CUTOVER_REASON),
      //   • and they have ZERO active devices right now.
      // Then the requesting browser becomes their one active device. This is NOT unrestricted
      // password-only replacement: outside the window, or for a normal device loss (no cutover marker),
      // the usual NO_ENROLLED_DEVICE stands and OTP replacement is required. Fails CLOSED on any error.
      const cutoverOpen = cfg.deviceCutoverDeadline != null && cfg.deviceCutoverDeadline.getTime() > Date.now();
      if (cutoverOpen && !s.is_preview) {
        const marked = await db.query(
          `select 1 from ccat.student_devices where student_id = $1 and revoked_reason = $2 limit 1`,
          [s.id, DEVICE_CUTOVER_REASON],
        );
        if (marked.rows.length > 0) {
          try {
            // The partial unique index student_devices_one_active (re-added at cutover) guarantees at most
            // one active row per student, so a concurrent double-submit can enroll only once — the loser
            // hits a unique violation, which we recover by reusing the row that won.
            const ins = await db.query(
              `insert into ccat.student_devices (student_id, device_hash, status, enrolled_at)
               select $1, $2, 'active', now()
                where not exists (
                  select 1 from ccat.student_devices where student_id = $1 and status = 'active')
               returning id`,
              [s.id, body.device_hash],
            );
            if (ins.rows.length > 0) {
              enrolled = ins.rows[0]!;
              await db.query(
                `insert into ccat.audit_log(actor_kind,event_type,target_kind,target_id,new_value,reason)
                 values ('student','device.enrolled.cutover','device',$1,$2,$3)`,
                [enrolled.id, JSON.stringify({ status: 'active', device_hash_prefix: String(body.device_hash).slice(0, 8) }), DEVICE_CUTOVER_REASON],
              );
            } else {
              // A concurrent enroll won the race — reuse whatever is now the single active device.
              const again = await db.query(
                `select id from ccat.student_devices where student_id = $1 and status = 'active'`,
                [s.id],
              );
              enrolled = again.rows[0] ?? null;
            }
          } catch {
            enrolled = null; // fail closed — never enroll on an unexpected error
          }
        }
      }
    }
    if (!enrolled) throw Errors.forbidden('NO_ENROLLED_DEVICE', 'No enrolled device; complete device replacement');
    // PREVIEW WAIVER (is_preview only): several teammates share one preview id from their own
    // browsers, so the device_hash match is skipped and the session binds to the shared preview
    // device. Real students keep strict single-device enforcement — this branch never runs for them.
    if (!s.is_preview) {
      const match = await db.query(
        `select 1 from ccat.student_devices where id = $1 and device_hash = $2`,
        [enrolled.id, body.device_hash],
      );
      if (match.rows.length === 0) throw Errors.deviceNotEnrolled();
    }

    await db.query('update ccat.student_credentials set failed_attempts = 0, locked_until = null where student_id = $1', [s.id]);

    const refresh = newRefreshToken();
    const authSession = await db.query(
      `insert into ccat.auth_sessions(student_id, device_id, refresh_hash, expires_at)
       values ($1,$2,$3, now() + ($4 || ' seconds')::interval) returning id`,
      [s.id, enrolled.id, hashToken(refresh), String(cfg.refreshTokenTtlSeconds)],
    );
    const sid = authSession.rows[0]!.id;
    const access = signToken(
      { sub: s.id, did: enrolled.id, sid, exp: Math.floor(Date.now() / 1000) + cfg.accessTokenTtlSeconds },
      cfg.hmacSecret,
    );
    await db.query('update ccat.student_devices set last_seen_at = now() where id = $1', [enrolled.id]);
    return { access_token: access, refresh_token: refresh, expires_in: cfg.accessTokenTtlSeconds };
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
