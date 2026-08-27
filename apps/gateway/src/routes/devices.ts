import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { generateOtp, hashSecret, verifySecret, hashToken } from '../security/crypto.js';
import { signToken, newRefreshToken } from '../security/token.js';

const startSchema = z.object({
  username: z.string(),
  new_device_hash: z.string().min(3),
  channel: z.enum(['email', 'sms']),
});
const verifySchema = z.object({ challenge_id: z.string().uuid(), code: z.string() });

// Single-device replacement (Blueprint §5.2). Guardian-OTP verified. Revokes the old device +
// token family + app sessions and enrolls the new device as the sole active device.
export function registerDeviceRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  app.post('/v1/devices/replacement/start', async (req, reply) => {
    const body = startSchema.parse(req.body);
    const st = await db.query(
      // is_preview excluded: preview accounts are synthetic and MUST trigger no outbound OTP/email.
      `select s.id as student_id, sg.guardian_id, gc.email, gc.phone
         from ccat.students s
         join ccat.student_guardians sg on sg.student_id = s.id and sg.is_primary = true
         join ccat.guardian_contacts gc on gc.id = sg.guardian_id
        where s.username_normalized = $1 and s.is_preview = false`,
      [body.username],
    );
    // Uniform response to avoid enumeration; only proceed if found.
    const code = generateOtp();
    const codeHash = await hashSecret(code, cfg.pinPepper);
    const expires = new Date(Date.now() + cfg.otpTtlSeconds * 1000);
    let challengeId: string | null = null;
    if (st.rows.length > 0) {
      const s = st.rows[0]!;
      const ch = await db.query(
        `insert into ccat.verification_challenges(purpose, student_id, guardian_id, channel, code_hash, expires_at)
         values ('device_replacement',$1,$2,$3,$4,$5) returning id`,
        [s.student_id, s.guardian_id, body.channel, codeHash, expires],
      );
      challengeId = ch.rows[0]!.id;
      // Stash the requested new device on a pending device row so verify can promote it.
      await db.query(
        `insert into ccat.student_devices(student_id, device_hash, status) values ($1,$2,'pending')`,
        [s.student_id, body.new_device_hash],
      );
      if (cfg.env === 'local') req.log.info({ otp: code }, 'dev otp (device replacement)');
    }
    reply.code(202);
    return { challenge_id: challengeId, expires_at: expires.toISOString(), _dev_code: cfg.env === 'local' ? code : undefined };
  });

  app.post('/v1/devices/replacement/verify', async (req) => {
    const body = verifySchema.parse(req.body);
    const ch = await db.query(
      `select id, student_id, code_hash, attempts, max_attempts, expires_at, consumed_at
         from ccat.verification_challenges
        where id = $1 and purpose = 'device_replacement'`,
      [body.challenge_id],
    );
    if (ch.rows.length === 0) throw Errors.notFound('Challenge not found');
    const c = ch.rows[0]!;
    if (c.consumed_at) throw Errors.unauthorized('Challenge already used');
    if (new Date(c.expires_at) < new Date()) throw Errors.unauthorized('Challenge expired');
    if (c.attempts >= c.max_attempts) throw Errors.unauthorized('Too many attempts');
    const ok = await verifySecret(body.code, cfg.pinPepper, c.code_hash);
    if (!ok) {
      await db.query('update ccat.verification_challenges set attempts = attempts + 1 where id = $1', [c.id]);
      throw Errors.unauthorized('Invalid code');
    }

    const result = await withTransaction(db, async (client) => {
      await client.query('update ccat.verification_challenges set consumed_at = now() where id = $1', [c.id]);
      // Revoke the old active device + its app sessions (token family) (§5.2 steps 4-5).
      await client.query(
        `update ccat.student_devices set status='revoked', revoked_at=now(), revoked_reason='replacement'
          where student_id=$1 and status='active'`,
        [c.student_id],
      );
      await client.query(
        `update ccat.auth_sessions set revoked_at=now(), revoked_reason='device_replacement'
          where student_id=$1 and revoked_at is null`,
        [c.student_id],
      );
      // Promote the newest pending device to sole active device (§5.1 partial-unique enforced).
      const promoted = await client.query(
        `update ccat.student_devices set status='active', enrolled_at=now()
          where id = (select id from ccat.student_devices
                       where student_id=$1 and status='pending' order by created_at desc limit 1)
          returning id`,
        [c.student_id],
      );
      if (promoted.rows.length === 0) throw Errors.validation('No pending device to enroll');
      const deviceId = promoted.rows[0]!.id;
      // Immutable audit event (§5.2 step 7).
      await client.query(
        `insert into ccat.audit_log(actor_kind, event_type, target_kind, target_id, reason)
         values ('system','device.replaced','device',$1,'guardian-verified replacement')`,
        [deviceId],
      );
      // Issue a fresh session on the new device.
      const refresh = newRefreshToken();
      const authSession = await client.query(
        `insert into ccat.auth_sessions(student_id, device_id, refresh_hash, expires_at)
         values ($1,$2,$3, now() + ($4 || ' seconds')::interval) returning id`,
        [c.student_id, deviceId, hashToken(refresh), String(cfg.refreshTokenTtlSeconds)],
      );
      const sid = authSession.rows[0]!.id;
      const access = signToken(
        { sub: c.student_id, did: deviceId, sid, exp: Math.floor(Date.now() / 1000) + cfg.accessTokenTtlSeconds },
        cfg.hmacSecret,
      );
      return { access_token: access, refresh_token: refresh, expires_in: cfg.accessTokenTtlSeconds };
    });
    return result;
  });
}
