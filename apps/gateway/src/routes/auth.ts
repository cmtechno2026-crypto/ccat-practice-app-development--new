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
    if (s.status !== 'active') throw Errors.forbidden('ACCOUNT_NOT_ACTIVE', `Account is ${s.status}`);

    await db.query('update ccat.student_credentials set failed_attempts = 0, locked_until = null where student_id = $1', [s.id]);

    // MULTI-DEVICE: a student may log in from ANY device, with no device-count limit and NO rejection on
    // device mismatch (the former single-device enforcement is removed). We still RECORD/associate the
    // device for audit + to bind the auth session to a device row. Find this (student_id, device_hash);
    // if it's new, enrol it; otherwise mark it active and touch last_seen. PIN verify + lockout above are
    // unchanged, so credential/child-safety checks are unaffected — only the device restriction is dropped.
    let deviceId: string;
    const existing = await db.query(
      `select id from ccat.student_devices where student_id = $1 and device_hash = $2
        order by (status = 'active') desc, created_at desc limit 1`,
      [s.id, body.device_hash],
    );
    if (existing.rows.length > 0) {
      deviceId = existing.rows[0]!.id;
      await db.query(
        `update ccat.student_devices set status='active', last_seen_at=now(),
                enrolled_at=coalesce(enrolled_at, now()), updated_at=now() where id=$1`,
        [deviceId],
      );
    } else {
      const ins = await db.query(
        `insert into ccat.student_devices(student_id, device_hash, status, enrolled_at, last_seen_at)
         values ($1,$2,'active',now(),now()) returning id`,
        [s.id, body.device_hash],
      );
      deviceId = ins.rows[0]!.id;
    }

    const refresh = newRefreshToken();
    const authSession = await db.query(
      `insert into ccat.auth_sessions(student_id, device_id, refresh_hash, expires_at)
       values ($1,$2,$3, now() + ($4 || ' seconds')::interval) returning id`,
      [s.id, deviceId, hashToken(refresh), String(cfg.refreshTokenTtlSeconds)],
    );
    const sid = authSession.rows[0]!.id;
    const access = signToken(
      { sub: s.id, did: deviceId, sid, exp: Math.floor(Date.now() / 1000) + cfg.accessTokenTtlSeconds },
      cfg.hmacSecret,
    );
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
