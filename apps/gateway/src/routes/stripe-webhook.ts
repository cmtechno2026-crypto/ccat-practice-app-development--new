import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { getStripe, priceIdForTier } from '../lib/stripe.js';
import { SELLABLE_TIERS, type Tier } from '../lib/entitlements.js';

// CCAT Payments Phase 1 — Stripe webhook. The ONLY thing that grants a paid entitlement.
//
// Security:
//  - Signature verified with the endpoint secret (raw body). A bad/absent signature -> 400, no work.
//  - Idempotent: every processed event id is recorded in ccat.payment_events; a redelivery is skipped,
//    so a stale event can never re-grant/downgrade.
//  - Entitlement is granted ONLY on checkout.session.completed with payment_status='paid'. The success
//    redirect grants nothing (that route is unauthenticated to Stripe's payment truth).
//  - The granted tier is the tier the server put in metadata at Checkout creation AND is cross-checked
//    against the Price actually paid (line item) -> server-owned mapping, never a client value.
//
// Raw body: Stripe signs the exact bytes, but the app's global JSON parser would replace them with a
// parsed object. So this route runs in an ENCAPSULATED scope with a buffer parser for application/json;
// the override is local and does not affect any other route.

export function registerStripeWebhookRoutes(app: FastifyInstance, db: DB, cfg: Config, deps: { stripe?: Stripe } = {}) {
  app.register(async (scope) => {
    // Local raw-body parser (buffer) for THIS scope only. Remove the inherited JSON parser first so the
    // override is accepted, then capture the raw bytes Stripe signed.
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    scope.post('/v1/webhooks/stripe', async (req, reply) => {
      if (!cfg.paymentsEnabled) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Payments are not enabled' } });
      if (!cfg.stripeWebhookSecret || !cfg.stripeSecretKey) {
        return reply.code(500).send({ error: { code: 'PAYMENTS_MISCONFIGURED', message: 'Stripe webhook not configured' } });
      }

      const sig = req.headers['stripe-signature'];
      const raw = req.body as Buffer; // buffer parser above
      const stripe = deps.stripe ?? getStripe(cfg);

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(raw, sig as string, cfg.stripeWebhookSecret);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'stripe webhook signature verification failed');
        return reply.code(400).send({ error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' } });
      }

      // We only act on a completed, paid one-time Checkout. Everything else is acknowledged and ignored.
      if (event.type !== 'checkout.session.completed') return reply.code(200).send({ received: true, ignored: event.type });

      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== 'payment' || session.payment_status !== 'paid') {
        return reply.code(200).send({ received: true, ignored: `status:${session.payment_status}` });
      }

      const tier = String(session.metadata?.tier ?? '') as Tier;
      const guardianEmail = String(
        session.metadata?.guardian_email ?? session.client_reference_id ?? session.customer_email ?? '',
      ).trim().toLowerCase();
      if (!SELLABLE_TIERS.includes(tier) || !guardianEmail) {
        req.log.warn({ tier, hasEmail: !!guardianEmail }, 'stripe webhook missing/invalid tier or guardian email');
        return reply.code(200).send({ received: true, ignored: 'unresolvable' });
      }

      // Defence in depth: confirm the Price actually paid maps to the tier we're about to grant. Fetch is
      // best-effort (network); a definite mismatch is rejected, a fetch failure falls back to the signed
      // server-set metadata tier.
      const expectedPrice = priceIdForTier(cfg, tier);
      try {
        const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
        const paidPrice = li.data[0]?.price?.id ?? null;
        if (paidPrice && expectedPrice && paidPrice !== expectedPrice) {
          req.log.error({ tier, paidPrice, expectedPrice }, 'stripe webhook price/tier mismatch — refusing grant');
          return reply.code(400).send({ error: { code: 'PRICE_TIER_MISMATCH', message: 'Paid price does not match tier' } });
        }
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'could not list line items — proceeding on signed metadata tier');
      }

      // Idempotency: skip if this event id was already processed (guards against stale redelivery).
      const seen = await db.query('select 1 from ccat.payment_events where stripe_event_id = $1', [event.id]);
      if (seen.rowCount && seen.rowCount > 0) return reply.code(200).send({ received: true, deduped: true });

      // Link to a guardian_contacts row when the email is known (nullable; not required).
      const gc = await db.query('select id from ccat.guardian_contacts where lower(email::text) = $1 limit 1', [guardianEmail]);
      const guardianId = gc.rows[0]?.id ?? null;

      const prev = await db.query(
        'select tier, status, current_period_end from ccat.entitlements where lower(guardian_email) = $1 limit 1',
        [guardianEmail],
      );

      // Grant: one-time purchase -> active, NO expiry (current_period_end null). Idempotent upsert keyed
      // on lower(guardian_email); reprocessing the same event sets the same tier (no-op).
      const up = await db.query(
        `insert into ccat.entitlements (guardian_email, guardian_id, tier, status, current_period_end, source, external_ref)
         values ($1, $2, $3, 'active', null, 'webhook', $4)
         on conflict (lower(guardian_email)) do update
           set tier = excluded.tier,
               status = 'active',
               current_period_end = null,
               guardian_id = coalesce(excluded.guardian_id, ccat.entitlements.guardian_id),
               source = 'webhook',
               external_ref = excluded.external_ref,
               updated_at = now()
         returning id, tier, status`,
        [guardianEmail, guardianId, tier, session.id],
      );

      // Audit (system actor; no admin id). Best-effort — never let an audit failure drop a paid grant.
      try {
        await db.query(
          `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, old_value, new_value, reference)
           values (null, 'system', 'entitlement.changed', 'entitlement', $1, $2, $3, $4)`,
          [
            up.rows[0]!.id,
            JSON.stringify(prev.rows[0] ?? null),
            JSON.stringify({ guardian_email: guardianEmail, tier, source: 'webhook' }),
            session.id,
          ],
        );
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'entitlement audit insert failed (grant still applied)');
      }

      // Record the processed event LAST so a crash before this simply reprocesses the same (idempotent) event.
      await db.query(
        'insert into ccat.payment_events (stripe_event_id, type) values ($1, $2) on conflict (stripe_event_id) do nothing',
        [event.id, event.type],
      );

      return reply.code(200).send({ received: true, tier });
    });
  });
}
