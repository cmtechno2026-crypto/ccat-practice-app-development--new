import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { verifySecret, hashToken } from '../security/crypto.js';
import { signToken, newRefreshToken } from '../security/token.js';
import { withTransaction } from '../db.js';

const loginSchema = z.object({
  username: z.string().trim().toLowerCase(),
  pin: z.string().regex(/^\d{4}$/),
  device_hash: z.string(),
});
const refreshSchema = z.object({ refresh_token: z.string().min(32) });

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
    if (s.status !== 'active') throw Errors.forbidden('ACCOUNT_NOT_ACTIVE', `Account is ${s.status}`);

    // Single-device enforcement (§5.1, §5.4): login only from the enrolled active device.
    const dev = await db.query(
      `select id from ccat.student_devices where student_id = $1 and status = 'active'`,
      [s.id],
    );
    if (dev.rows.length === 0) throw Errors.forbidden('NO_ENROLLED_DEVICE', 'No enrolled device; complete device replacement');
    const enrolled = dev.rows[0]!;
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

  // Rotate the opaque refresh token and issue a new short-lived access token. The refresh token is
  // never stored in plaintext; the session/device/student are revalidated on every rotation.
  app.post('/v1/auth/refresh', { config: { rateLimit: { max: loginMax, timeWindow: '1 minute' } } }, async (req) => {
    const body = refreshSchema.parse(req.body);
    const presentedHash = hashToken(body.refresh_token);
    const tokens = await withTransaction(db, async (c) => {
      const r = await c.query(
        `select a.id, a.student_id, a.device_id, a.expires_at, a.revoked_at,
                s.status student_status, d.status device_status
           from ccat.auth_sessions a
           join ccat.students s on s.id=a.student_id
           join ccat.student_devices d on d.id=a.device_id
          where a.refresh_hash=$1 for update of a`, [presentedHash]);
      if (r.rows.length === 0) throw Errors.unauthorized('Invalid refresh token');
      const a = r.rows[0]!;
      if (a.revoked_at || new Date(a.expires_at).getTime() <= Date.now()) throw Errors.unauthorized('Refresh session expired');
      if (a.student_status !== 'active') throw Errors.forbidden('ACCOUNT_NOT_ACTIVE', `Account is ${a.student_status}`);
      if (a.device_status !== 'active') throw Errors.deviceNotEnrolled();
      const nextRefresh = newRefreshToken();
      await c.query('update ccat.auth_sessions set refresh_hash=$2,last_used_at=now() where id=$1', [a.id, hashToken(nextRefresh)]);
      const access = signToken(
        { sub: a.student_id, did: a.device_id, sid: a.id, exp: Math.floor(Date.now() / 1000) + cfg.accessTokenTtlSeconds },
        cfg.hmacSecret,
      );
      return { access_token: access, refresh_token: nextRefresh, expires_in: cfg.accessTokenTtlSeconds };
    });
    return tokens;
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
