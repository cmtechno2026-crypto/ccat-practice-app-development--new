import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors, AppError } from '../errors.js';
import { resolveEntitlement, checkoutRejectReason, type Tier } from '../lib/entitlements.js';
import { getStripe, priceIdForTier } from '../lib/stripe.js';

// CCAT Payments Phase 1 — create a Stripe Checkout Session for a tier UPGRADE.
//
// Trust model (server-owned everything):
//  - The student is authenticated; the guardian is resolved from the SESSION, never the client.
//  - The requested tier is validated server-side (sellable, reachable, strictly higher than current).
//  - The Price comes from the server's tier->Price map. A client-supplied price/amount/currency/feature
//    is never read. The client sends ONLY a tier string.
//  - mode=payment (one-time). Entitlement is granted by the WEBHOOK after confirmed payment, never by
//    the success redirect. This route just starts Checkout.
//
// Flag contract: when cfg.paymentsEnabled is false the route 404s (payments inactive), matching the
// rest of the gateway's flag-off no-op behaviour.

const bodySchema = z.object({ tier: z.enum(['t50', 't250', 't500']) });

export function registerCheckoutRoutes(app: FastifyInstance, db: DB, cfg: Config, deps: { stripe?: Stripe } = {}) {
  app.post('/v1/checkout/session', { preHandler: [app.authenticateStudent] }, async (req) => {
    if (!cfg.paymentsEnabled) throw Errors.notFound('Payments are not enabled');

    const { tier } = bodySchema.parse(req.body) as { tier: Tier };

    // Config must be complete or we fail closed with a clear operator error (never a half-built session).
    const priceId = priceIdForTier(cfg, tier);
    if (!cfg.stripeSecretKey || !priceId) {
      throw new AppError(500, 'PAYMENTS_MISCONFIGURED', `Stripe not fully configured for tier ${tier}`);
    }
    if (!cfg.webAppOrigin) {
      throw new AppError(500, 'PAYMENTS_MISCONFIGURED', 'WEB_APP_ORIGIN is required for checkout redirect URLs');
    }

    // Resolve the student's CURRENT effective entitlement (server truth) and its guardian email.
    const ent = await resolveEntitlement(db, req.student!.studentId);
    const guardianEmail = ent.guardianEmail;
    if (!guardianEmail) {
      // Entitlement is keyed by guardian email; without one the webhook could not grant anything.
      throw Errors.conflict('NO_GUARDIAN_EMAIL', 'No guardian email on file for this student');
    }

    // Server-side eligibility. No downgrade, no same-tier, no non-sellable/unavailable tier.
    const reason = checkoutRejectReason(ent.tier, tier);
    if (reason) {
      throw Errors.forbidden('UPGRADE_NOT_ELIGIBLE', `Cannot upgrade from ${ent.tier} to ${tier} (${reason})`);
    }

    const stripe = deps.stripe ?? getStripe(cfg);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      // Both fields carry the guardian key + tier so the webhook can grant to the right guardian.
      client_reference_id: guardianEmail,
      customer_email: guardianEmail,
      metadata: { guardian_email: guardianEmail, tier, student_id: req.student!.studentId },
      payment_intent_data: { metadata: { guardian_email: guardianEmail, tier, student_id: req.student!.studentId } },
      success_url: `${cfg.webAppOrigin}/plan?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${cfg.webAppOrigin}/plan?checkout=cancel`,
    });

    return { url: session.url, id: session.id };
  });
}
