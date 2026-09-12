import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors, AppError } from '../errors.js';
import { resolveEntitlement, checkoutRejectReason, type Tier } from '../lib/entitlements.js';
import { createOrder, captureOrder, amountForTier, paypalConfigured, encodeCustomId, decodeCustomId } from '../lib/paypal.js';
import { grantPaidEntitlementPaypal } from '../lib/paypal-grant.js';
import { verifyEmailToken } from './email-verify.js';

// CCAT Payments — PayPal in-app checkout (Orders v2). Mirrors the Stripe checkout trust model:
//  - student authenticated; guardian resolved from the SESSION, never the client.
//  - tier validated server-side (sellable, strictly higher than current).
//  - amount comes from the server's tier->amount map (CAD). The client sends ONLY a tier string.
//  - a paid entitlement is written ONLY by grantPaidEntitlementPaypal (shared with the webhook), keyed on
//    the PayPal capture id so capture-on-return and the webhook grant exactly once between them.
// Flag contract: cfg.paymentsEnabled false -> 404 (matches the rest of the gateway's flag-off no-op).

const orderSchema = z.object({ tier: z.enum(['t50', 't250', 't500']) });
const captureSchema = z.object({ order_id: z.string().min(1) });
// Public (pre-account) checkout: buy a plan against an OTP-verified email that has NO account yet.
const orderPublicSchema = z.object({
  tier: z.enum(['t50', 't250', 't500']),
  email: z.string().trim().toLowerCase().email(),
  email_verify_token: z.string().min(1),
});
const emailQuerySchema = z.string().trim().toLowerCase().email();

export function registerPaypalCheckoutRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  // Create a PayPal order for a tier UPGRADE. Returns the PayPal approval URL for the web to redirect to.
  app.post('/v1/checkout/paypal/order', { preHandler: [app.authenticateStudent] }, async (req) => {
    if (!cfg.paymentsEnabled) throw Errors.notFound('Payments are not enabled');
    const { tier } = orderSchema.parse(req.body) as { tier: Tier };

    const amount = amountForTier(cfg, tier);
    if (!paypalConfigured(cfg) || !amount) throw new AppError(500, 'PAYMENTS_MISCONFIGURED', `PayPal not fully configured for tier ${tier}`);
    if (!cfg.webAppOrigin) throw new AppError(500, 'PAYMENTS_MISCONFIGURED', 'WEB_APP_ORIGIN is required for checkout redirect URLs');

    const ent = await resolveEntitlement(db, req.student!.studentId);
    const guardianEmail = ent.guardianEmail;
    if (!guardianEmail) throw Errors.conflict('NO_GUARDIAN_EMAIL', 'No guardian email on file for this student');

    const reason = checkoutRejectReason(ent.tier, tier);
    if (reason) throw Errors.forbidden('UPGRADE_NOT_ELIGIBLE', `Cannot upgrade from ${ent.tier} to ${tier} (${reason})`);

    const order = await createOrder(cfg, {
      tier,
      amount,
      customId: encodeCustomId(guardianEmail, tier, req.student!.studentId),
      returnUrl: `${cfg.webAppOrigin}/plan?checkout=success`,
      cancelUrl: `${cfg.webAppOrigin}/plan?checkout=cancel`,
    });
    if (!order.approveUrl) throw new AppError(502, 'PAYPAL_NO_APPROVE_URL', 'PayPal did not return an approval URL');
    return { url: order.approveUrl, id: order.id };
  });

  // Capture an approved order (called by the web on return) and grant on a COMPLETED capture. Idempotent:
  // the shared grant helper dedupes on the capture id, so the webhook re-arriving is a no-op.
  app.post('/v1/checkout/paypal/capture', { preHandler: [app.authenticateStudent] }, async (req) => {
    if (!cfg.paymentsEnabled) throw Errors.notFound('Payments are not enabled');
    const { order_id } = captureSchema.parse(req.body);

    const cap = await captureOrder(cfg, order_id);
    if (cap.status !== 'COMPLETED' || !cap.captureId) {
      return { status: cap.status, granted: false };
    }
    // custom_id is the server-set guardian|tier|student from order creation — trust it over any client input.
    const decoded = decodeCustomId(cap.customId);
    if (!decoded) throw new AppError(422, 'PAYPAL_MISSING_CUSTOM_ID', 'Captured order has no resolvable custom_id');

    const outcome = await grantPaidEntitlementPaypal(db, cfg, {
      captureId: cap.captureId,
      orderId: cap.orderId,
      tier: decoded.tier,
      guardianEmail: decoded.guardianEmail,
      amount: cap.amount,
      eventType: 'capture',
      log: req.log,
    });
    if (outcome === 'amount_mismatch') throw new AppError(400, 'AMOUNT_TIER_MISMATCH', 'Captured amount does not match tier');
    return { status: cap.status, granted: outcome === 'granted' || outcome === 'deduped', tier: decoded.tier };
  });

  // ---- Landing-page checkout (Case 1 / Case 2), no session required ---------------------------------
  // These power the "Get <plan>" buttons on the public landing. Case 1 (email already has an account) is
  // handled entirely client-side: the modal calls account-by-email, the parent logs in, then the AUTHED
  // /order + /capture above run. Case 2 (no account yet) uses the two public endpoints below: pay against
  // an OTP-verified email, the grant is written keyed on that email (entitlements are guardian_email-keyed,
  // guardian_id nullable), and it attaches automatically when the account is later created with that email.

  // Case 1 prefill — reveal the userID(s) for a guardian email so the login form can prefill. OPEN lookup
  // (no auth) by product decision, to keep the buy-flow to the fewest clicks. Mitigations: hard rate-limit,
  // returns ONLY active usernames (no grade/PII), and every lookup is logged. Enumeration risk is accepted:
  // the reveal lowers a stolen-email attacker to still needing the 4-digit PIN, which login already
  // rate-limits + locks. Reconsider if abuse appears (switch Case 1 to OTP-gated like Case 2).
  app.get('/v1/checkout/account-by-email', {
    config: { rateLimit: { max: cfg.env === 'production' ? 15 : 2000, timeWindow: '5 minutes' } },
  }, async (req) => {
    if (!cfg.paymentsEnabled) throw Errors.notFound('Payments are not enabled');
    const parsed = emailQuerySchema.safeParse((req.query as any)?.email);
    if (!parsed.success) return { exists: false, usernames: [] as string[] };
    const email = parsed.data;
    const { rows } = await db.query(
      `select s.username_normalized as username
         from ccat.guardian_contacts gc
         join ccat.student_guardians sg on sg.guardian_id = gc.id
         join ccat.students s on s.id = sg.student_id
        where gc.email = $1 and s.status = 'active'
        order by sg.is_primary desc, s.created_at asc
        limit 10`,
      [email],
    );
    const usernames = rows.map((r) => r.username as string);
    req.log.info({ email, n: usernames.length }, 'checkout.account_lookup');
    return { exists: usernames.length > 0, usernames };
  });

  // Case 2 — create a PayPal order for an OTP-VERIFIED email that has NO live account. The email token
  // (from /v1/registration/email/confirm) is proof the buyer controls the inbox; without it we never sell
  // against an arbitrary email. If the email already has an account, refuse — that buyer must log in (Case 1).
  app.post('/v1/checkout/paypal/order-public', {
    config: { rateLimit: { max: cfg.env === 'production' ? 20 : 2000, timeWindow: '15 minutes' } },
  }, async (req) => {
    if (!cfg.paymentsEnabled) throw Errors.notFound('Payments are not enabled');
    const { tier, email, email_verify_token } = orderPublicSchema.parse(req.body) as { tier: Tier; email: string; email_verify_token: string };

    const amount = amountForTier(cfg, tier);
    if (!paypalConfigured(cfg) || !amount) throw new AppError(500, 'PAYMENTS_MISCONFIGURED', `PayPal not fully configured for tier ${tier}`);
    if (!cfg.webAppOrigin) throw new AppError(500, 'PAYMENTS_MISCONFIGURED', 'WEB_APP_ORIGIN is required for checkout redirect URLs');

    // Proof of email control (server-verified HMAC minted at OTP confirm). Always required here.
    if (!verifyEmailToken(email_verify_token, email, cfg.hmacSecret)) {
      throw Errors.unauthorized('Email is not verified — verify the code first');
    }
    // This path is ONLY for emails without an account. An existing account must go through Case 1 (login).
    const inUse = await db.query(
      `select 1 from ccat.guardian_contacts gc
         join ccat.student_guardians sg on sg.guardian_id = gc.id
         join ccat.students s on s.id = sg.student_id
        where gc.email = $1 and s.status <> 'purged' limit 1`,
      [email],
    );
    if (inUse.rows.length > 0) {
      throw Errors.conflict('EMAIL_IN_USE', 'This email already has an account — please log in to upgrade.', { field: 'email' });
    }

    const order = await createOrder(cfg, {
      tier,
      amount,
      // studentId is empty — the grant keys on the guardian email; the account is created after payment.
      customId: encodeCustomId(email, tier, ''),
      returnUrl: `${cfg.webAppOrigin}/register?checkout=success`,
      cancelUrl: `${cfg.webAppOrigin}/?checkout=cancel`,
    });
    if (!order.approveUrl) throw new AppError(502, 'PAYPAL_NO_APPROVE_URL', 'PayPal did not return an approval URL');
    return { url: order.approveUrl, id: order.id };
  });

  // Case 2 — capture the approved public order on return and grant by email. No auth: the grant is safe
  // because the tier + guardian email come from the server-set custom_id, the amount is cross-checked, and
  // the write is idempotent on the PayPal capture id (the webhook is the same-keyed backstop).
  app.post('/v1/checkout/paypal/capture-public', {
    config: { rateLimit: { max: cfg.env === 'production' ? 30 : 2000, timeWindow: '15 minutes' } },
  }, async (req) => {
    if (!cfg.paymentsEnabled) throw Errors.notFound('Payments are not enabled');
    const { order_id } = captureSchema.parse(req.body);

    const cap = await captureOrder(cfg, order_id);
    if (cap.status !== 'COMPLETED' || !cap.captureId) {
      return { status: cap.status, granted: false };
    }
    const decoded = decodeCustomId(cap.customId);
    if (!decoded) throw new AppError(422, 'PAYPAL_MISSING_CUSTOM_ID', 'Captured order has no resolvable custom_id');

    const outcome = await grantPaidEntitlementPaypal(db, cfg, {
      captureId: cap.captureId,
      orderId: cap.orderId,
      tier: decoded.tier,
      guardianEmail: decoded.guardianEmail,
      amount: cap.amount,
      eventType: 'capture',
      log: req.log,
    });
    if (outcome === 'amount_mismatch') throw new AppError(400, 'AMOUNT_TIER_MISMATCH', 'Captured amount does not match tier');
    return { status: cap.status, granted: outcome === 'granted' || outcome === 'deduped', tier: decoded.tier, email: decoded.guardianEmail };
  });
}
