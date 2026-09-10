import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { generateOtp, hashSecret, verifySecret } from '../security/crypto.js';
import { sendEmail, emailConfigured } from '../lib/email.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const startSchema = z.object({ email: z.string().email() });
const completeSchema = z.object({
  email: z.string().email(),
  code: z.string(),
  new_pin: z.string().regex(/^\d{4}$/),
});

// PIN recovery (Blueprint §4.4): a parent enters their REGISTERED email; we email the child username(s)
// + a one-time reset code to that address; the parent then enters the code + a new PIN (no username to
// type — step 2 reuses the email from step 1, so the code check is SCOPED to that account). The start
// response is UNIFORM and never reveals whether the email is registered. Does NOT authorize a new device.
export function registerRecoveryRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const startMax = cfg.env === 'production' ? 5 : 2000;
  const completeMax = cfg.env === 'production' ? 10 : 2000;

  app.post('/v1/recovery/pin/start', { config: { rateLimit: { max: startMax, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = startSchema.parse(req.body);
    const email = body.email.trim();
    // Fail CLOSED + uniformly when email cannot be delivered (never claim a code was sent when it was not).
    if (cfg.env !== 'local' && !emailConfigured(cfg)) throw Errors.emailUnavailable();

    // Every non-preview student whose PRIMARY guardian is this email (one parent may have several kids).
    const st = await db.query(
      `select s.id as student_id, s.username_normalized as username, s.display_name,
              sg.guardian_id, gc.email as guardian_email, gc.name as guardian_name
         from ccat.guardian_contacts gc
         join ccat.student_guardians sg on sg.guardian_id = gc.id and sg.is_primary = true
         join ccat.students s on s.id = sg.student_id and s.is_preview = false
        where gc.email = $1
        limit 10`,
      [email],
    );

    const expires = new Date(Date.now() + cfg.otpTtlSeconds * 1000);
    const mins = Math.round(cfg.otpTtlSeconds / 60);
    const devCodes: { username: string; code: string }[] = [];
    const rows: string[] = [];
    let guardianName = '';
    let guardianEmail = '';

    for (const s of st.rows) {
      guardianName = s.guardian_name || guardianName;
      guardianEmail = s.guardian_email || guardianEmail;
      const recent = await db.query(
        `select count(*)::int as n from ccat.verification_challenges
          where student_id=$1 and purpose='pin_reset' and consumed_at is null
            and created_at > now() - interval '15 minutes'`,
        [s.student_id],
      );
      if ((recent.rows[0]?.n ?? 0) >= 3) continue;
      const code = generateOtp();
      const codeHash = await hashSecret(code, cfg.pinPepper);
      await db.query(
        `update ccat.verification_challenges set consumed_at = now()
          where student_id=$1 and purpose='pin_reset' and consumed_at is null`,
        [s.student_id],
      );
      await db.query(
        `insert into ccat.verification_challenges(purpose, student_id, guardian_id, channel, code_hash, expires_at)
         values ('pin_reset',$1,$2,'email',$3,$4)`,
        [s.student_id, s.guardian_id, codeHash, expires],
      );
      devCodes.push({ username: s.username, code });
      rows.push(
        `<tr><td style="padding:6px 12px;border:1px solid #e7eaf3">${escapeHtml(s.display_name || 'Your child')}</td>` +
        `<td style="padding:6px 12px;border:1px solid #e7eaf3"><strong>${escapeHtml(s.username)}</strong></td>` +
        `<td style="padding:6px 12px;border:1px solid #e7eaf3;font-size:20px;font-weight:800;letter-spacing:3px;color:#1A5EAB">${code}</td></tr>`,
      );
    }

    if (rows.length > 0 && guardianEmail && cfg.env !== 'local') {
      const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:15px;color:#1f2340">
        <h2 style="color:#1A5EAB;margin:0 0 8px">CCAT PIN reset</h2>
        <p>Hi ${escapeHtml(guardianName || 'there')},</p>
        <p>A PIN reset was requested for your CCAT Practice account. Use the reset code below to set a new PIN (your username is shown for reference):</p>
        <table style="border-collapse:collapse;margin:12px 0">
          <thead><tr>
            <th style="padding:6px 12px;border:1px solid #e7eaf3;text-align:left">Child</th>
            <th style="padding:6px 12px;border:1px solid #e7eaf3;text-align:left">Username</th>
            <th style="padding:6px 12px;border:1px solid #e7eaf3;text-align:left">Reset code</th>
          </tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
        <p>This code expires in ${mins} minutes. If you didn't request this, you can ignore this email — nothing changes until a code is used.</p>
        <p style="color:#8a90a6;font-size:13px">— Concept Mastery · CCAT Practice</p>
      </div>`;
      const sent = await sendEmail(cfg, { to: guardianEmail, subject: 'Your CCAT PIN reset code', html }, req.log);
      if (!sent) throw Errors.emailUnavailable();
    }

    reply.code(202);
    return { ok: true, _dev_codes: cfg.env === 'local' ? devCodes : undefined };
  });

  app.post('/v1/recovery/pin/complete', { config: { rateLimit: { max: completeMax, timeWindow: '15 minutes' } } }, async (req) => {
    const body = completeSchema.parse(req.body);
    const email = body.email.trim();
    const invalid = () => Errors.unauthorized('Invalid or expired code');

    // Active reset challenges for the children under this guardian email. Scoping the code check to the
    // email the requester named (kept from step 1) means: no global code guessing, no username needed.
    const chs = await db.query(
      `select vc.id, vc.code_hash, vc.attempts, vc.max_attempts, vc.expires_at, vc.student_id
         from ccat.guardian_contacts gc
         join ccat.student_guardians sg on sg.guardian_id = gc.id and sg.is_primary = true
         join ccat.students s on s.id = sg.student_id and s.is_preview = false
         join ccat.verification_challenges vc on vc.student_id = s.id and vc.purpose='pin_reset' and vc.consumed_at is null
        where gc.email = $1
        order by vc.created_at desc`,
      [email],
    );
    if (chs.rows.length === 0) throw invalid();

    let match: { id: string; student_id: string } | null = null;
    for (const c of chs.rows) {
      if (new Date(c.expires_at) < new Date()) continue;
      if (c.attempts >= c.max_attempts) continue;
      if (await verifySecret(body.code, cfg.pinPepper, c.code_hash)) { match = { id: c.id, student_id: c.student_id }; break; }
    }
    if (!match) {
      // Count the miss against every active challenge for this email so guessing is bounded per account.
      await db.query(
        `update ccat.verification_challenges set attempts = attempts + 1
          where purpose='pin_reset' and consumed_at is null and student_id in (
            select s.id from ccat.guardian_contacts gc
            join ccat.student_guardians sg on sg.guardian_id = gc.id and sg.is_primary = true
            join ccat.students s on s.id = sg.student_id
            where gc.email = $1)`,
        [email],
      );
      throw invalid();
    }

    const pinHash = await hashSecret(body.new_pin, cfg.pinPepper);
    await db.query('update ccat.verification_challenges set consumed_at = now() where id = $1', [match.id]);
    await db.query(
      'update ccat.student_credentials set pin_hash=$2, failed_attempts=0, locked_until=null where student_id=$1',
      [match.student_id, pinHash],
    );
    // Revoke existing application sessions; fresh login required (§4.4).
    await db.query(
      `update ccat.auth_sessions set revoked_at=now(), revoked_reason='pin_reset' where student_id=$1 and revoked_at is null`,
      [match.student_id],
    );
    return { status: 'pin_reset', message: 'PIN reset. Please log in again.' };
  });
}
