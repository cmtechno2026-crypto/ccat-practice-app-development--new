import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { verifySecret, hashToken } from '../security/crypto.js';
import { signToken, newRefreshToken } from '../security/token.js';

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
