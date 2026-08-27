import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { generateOtp, hashSecret, verifySecret } from '../security/crypto.js';

const startSchema = z.object({ username: z.string(), channel: z.enum(['email', 'sms']) });
const completeSchema = z.object({
  challenge_id: z.string().uuid(),
  code: z.string(),
  new_pin: z.string().regex(/^\d{4}$/),
});

// PIN recovery (Blueprint §4.4): guardian OTP → choose new PIN → revoke existing app sessions →
// fresh login required. Does NOT authorize a new device (§4.4).
export function registerRecoveryRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  app.post('/v1/recovery/pin/start', async (req, reply) => {
    const body = startSchema.parse(req.body);
    const st = await db.query(
      // is_preview excluded: preview accounts are synthetic and MUST trigger no outbound OTP/email.
      `select s.id as student_id, sg.guardian_id
         from ccat.students s
         join ccat.student_guardians sg on sg.student_id = s.id and sg.is_primary = true
        where s.username_normalized = $1 and s.is_preview = false`,
      [body.username],
    );
    const code = generateOtp();
    const codeHash = await hashSecret(code, cfg.pinPepper);
    const expires = new Date(Date.now() + cfg.otpTtlSeconds * 1000);
    let challengeId: string | null = null;
    if (st.rows.length > 0) {
      const s = st.rows[0]!;
      const ch = await db.query(
        `insert into ccat.verification_challenges(purpose, student_id, guardian_id, channel, code_hash, expires_at)
         values ('pin_reset',$1,$2,$3,$4,$5) returning id`,
        [s.student_id, s.guardian_id, body.channel, codeHash, expires],
      );
      challengeId = ch.rows[0]!.id;
      if (cfg.env === 'local') req.log.info({ otp: code }, 'dev otp (pin reset)');
    }
    reply.code(202);
    return { challenge_id: challengeId, expires_at: expires.toISOString(), _dev_code: cfg.env === 'local' ? code : undefined };
  });

  app.post('/v1/recovery/pin/complete', async (req) => {
    const body = completeSchema.parse(req.body);
    const ch = await db.query(
      `select id, student_id, code_hash, attempts, max_attempts, expires_at, consumed_at
         from ccat.verification_challenges where id = $1 and purpose = 'pin_reset'`,
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
    const pinHash = await hashSecret(body.new_pin, cfg.pinPepper);
    await db.query('update ccat.verification_challenges set consumed_at = now() where id = $1', [c.id]);
    await db.query(
      'update ccat.student_credentials set pin_hash=$2, failed_attempts=0, locked_until=null where student_id=$1',
      [c.student_id, pinHash],
    );
    // Revoke existing application sessions; fresh login required (§4.4).
    await db.query(
      `update ccat.auth_sessions set revoked_at=now(), revoked_reason='pin_reset' where student_id=$1 and revoked_at is null`,
      [c.student_id],
    );
    return { status: 'pin_reset', message: 'PIN reset. Please log in again.' };
  });
}
