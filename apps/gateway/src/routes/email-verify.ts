import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { generateOtp, hashSecret, verifySecret } from '../security/crypto.js';
import { sendEmail, emailConfigured } from '../lib/email.js';

// Pre-registration email verification (flag-gated). A guardian requests a 6-digit code to their email,
// enters it, and gets a short-lived HMAC token proving the email is verified. contact/start checks that
// token when EMAIL_VERIFY_REQUIRED is on. OTPs are hashed (scrypt+pepper), single-use, expiring, and
// rate-limited on both request and confirm. Requires migration 0045 (ccat.email_verifications).

const TOKEN_TTL_SEC = 30 * 60;

export function signEmailToken(email: string, secret: string): string {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const mac = createHmac('sha256', secret).update(`${email.toLowerCase()}:${exp}`).digest('hex');
  return `${exp}.${mac}`;
}
export function verifyEmailToken(token: string | undefined, email: string, secret: string): boolean {
  if (!token) return false;
  const [expStr, mac] = token.split('.');
  const exp = Number(expStr);
  if (!exp || !mac || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac('sha256', secret).update(`${email.toLowerCase()}:${exp}`).digest('hex');
  try { return timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; }
}

const requestSchema = z.object({ email: z.string().trim().toLowerCase().email() });
const confirmSchema = z.object({ email: z.string().trim().toLowerCase().email(), code: z.string() });

export function registerEmailVerifyRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const reqMax = cfg.env === 'production' ? 5 : 2000;
  const confMax = cfg.env === 'production' ? 10 : 2000;

  app.post('/v1/registration/email/request', { config: { rateLimit: { max: reqMax, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { email } = requestSchema.parse(req.body);
    // Do not send a code for an email already tied to a LIVE account — the parent must use a different
    // email (mirrors contact/start's one-account-per-email rule). Verification never proceeds for it.
    const inUse = await db.query(
      `select 1 from ccat.guardian_contacts gc
         join ccat.student_guardians sg on sg.guardian_id = gc.id
         join ccat.students s on s.id = sg.student_id
        where gc.email = $1 and s.status <> 'purged' limit 1`,
      [email],
    );
    if (inUse.rows.length > 0) {
      throw Errors.conflict('EMAIL_IN_USE', 'This email is already registered to an account. Please enter a different email to continue.', { field: 'email' });
    }
    if (cfg.env !== 'local' && !emailConfigured(cfg)) throw Errors.emailUnavailable();
    const recent = await db.query(
      `select count(*)::int as n from ccat.email_verifications
        where email=$1 and consumed_at is null and created_at > now() - interval '15 minutes'`,
      [email],
    );
    const code = generateOtp();
    if ((recent.rows[0]?.n ?? 0) < 3) {
      const codeHash = await hashSecret(code, cfg.pinPepper);
      const expires = new Date(Date.now() + cfg.otpTtlSeconds * 1000);
      await db.query(`update ccat.email_verifications set consumed_at=now() where email=$1 and consumed_at is null`, [email]);
      await db.query(`insert into ccat.email_verifications(email, code_hash, expires_at) values ($1,$2,$3)`, [email, codeHash, expires]);
      const mins = Math.round(cfg.otpTtlSeconds / 60);
      const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:15px;color:#1f2340">
        <h2 style="color:#1A5EAB;margin:0 0 8px">Verify your email address</h2>
        <p>Enter the following code to verify your email address for CCAT Practice:</p>
        <p style="font-size:30px;font-weight:800;letter-spacing:4px;color:#1A5EAB;margin:12px 0">${code}</p>
        <p>This code expires in ${mins} minutes.</p>
        <p>If you did not request this code, you can safely ignore this email.</p>
        <p style="color:#8a90a6;font-size:13px">— Concept Mastery · CCAT Practice</p></div>`;
      const sent = await sendEmail(cfg, { to: email, subject: 'Verify your email address', html }, req.log);
      if (!sent && cfg.env !== 'local') throw Errors.emailUnavailable();
    }
    reply.code(202);
    return { ok: true, _dev_code: cfg.env === 'local' ? code : undefined };
  });

  app.post('/v1/registration/email/confirm', { config: { rateLimit: { max: confMax, timeWindow: '15 minutes' } } }, async (req) => {
    const { email, code } = confirmSchema.parse(req.body);
    const invalid = () => Errors.unauthorized('Invalid or expired code');
    const ch = await db.query(
      `select id, code_hash, attempts, max_attempts, expires_at from ccat.email_verifications
        where email=$1 and consumed_at is null order by created_at desc limit 1`,
      [email],
    );
    if (ch.rows.length === 0) throw invalid();
    const c = ch.rows[0]!;
    if (new Date(c.expires_at) < new Date()) throw invalid();
    if (c.attempts >= c.max_attempts) throw invalid();
    const ok = await verifySecret(code, cfg.pinPepper, c.code_hash);
    if (!ok) { await db.query(`update ccat.email_verifications set attempts=attempts+1 where id=$1`, [c.id]); throw invalid(); }
    await db.query(`update ccat.email_verifications set consumed_at=now() where id=$1`, [c.id]);
    return { email, token: signEmailToken(email, cfg.hmacSecret) };
  });

  // Lightweight availability check for the register form (debounced). Reveals only whether an email is
  // already tied to a live account (same info the funnel shows) — no code sent, no side effects.
  app.get('/v1/registration/email/available', async (req) => {
    const parsed = z.string().trim().toLowerCase().email().safeParse((req.query as any)?.email);
    if (!parsed.success) return { available: false };
    const inUse = await db.query(
      `select 1 from ccat.guardian_contacts gc
         join ccat.student_guardians sg on sg.guardian_id = gc.id
         join ccat.students s on s.id = sg.student_id
        where gc.email = $1 and s.status <> 'purged' limit 1`,
      [parsed.data],
    );
    return { available: inUse.rows.length === 0 };
  });
}
