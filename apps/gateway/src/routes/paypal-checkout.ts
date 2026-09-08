import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors, AppError } from '../errors.js';
import { resolveEntitlement, checkoutRejectReason, type Tier } from '../lib/entitlements.js';
import { createOrder, captureOrder, amountForTier, paypalConfigured, encodeCustomId, decodeCustomId } from '../lib/paypal.js';
import { grantPaidEntitlementPaypal } from '../lib/paypal-grant.js';

// CCAT Payments — PayPal in-app checkout (Orders v2). Mirrors the Stripe checkout trust model:
//  - student authenticated; guardian resolved from the SESSION, never the client.
//  - tier validated server-side (sellable, strictly higher than current).
//  - amount comes from the server's tier->amount map (CAD). The client sends ONLY a tier string.
//  - a paid entitlement is written ONLY by grantPaidEntitlementPaypal (shared with the webhook), keyed on
//    the PayPal capture id so capture-on-return and the webhook grant exactly once between them.
// Flag contract: cfg.paymentsEnabled false -> 404 (matches the rest of the gateway's flag-off no-op).

const orderSchema = z.object({ tier: z.enum(['t50', 't250', 't500']) });
const captureSchema = z.object({ order_id: z.string().min(1) });

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
}
