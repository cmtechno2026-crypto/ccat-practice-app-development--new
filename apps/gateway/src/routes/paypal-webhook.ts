import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { verifyWebhook, decodeCustomId, paypalConfigured } from '../lib/paypal.js';
import { grantPaidEntitlementPaypal } from '../lib/paypal-grant.js';

// CCAT Payments — PayPal webhook. Authoritative/back-up grant path (the return-time capture also grants;
// both are idempotent on the capture id, so they never double-apply).
//
// Security:
//  - Verified via PayPal's verify-webhook-signature API (needs the RAW body + the transmission headers +
//    PAYPAL_WEBHOOK_ID). Verification failure -> 400, no work.
//  - Grants ONLY on PAYMENT.CAPTURE.COMPLETED. Every other event is acknowledged (200) and ignored.
//  - The granted tier + guardian come from the capture's custom_id (server-set at order creation), and the
//    amount is cross-checked against the server price. A client value is never trusted.
//
// Raw body: the signature is over the exact bytes, so this route runs in an ENCAPSULATED scope with a
// buffer parser for application/json (local override; does not affect any other route).

export function registerPaypalWebhookRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    scope.post('/v1/webhooks/paypal', async (req, reply) => {
      if (!cfg.paymentsEnabled) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Payments are not enabled' } });
      if (!paypalConfigured(cfg) || !cfg.paypal.webhookId) {
        return reply.code(500).send({ error: { code: 'PAYMENTS_MISCONFIGURED', message: 'PayPal webhook not configured' } });
      }

      const raw = (req.body as Buffer).toString('utf8');
      const ok = await verifyWebhook(cfg, req.headers as Record<string, any>, raw);
      if (!ok) {
        req.log.warn('paypal webhook signature verification failed');
        return reply.code(400).send({ error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' } });
      }

      let event: any;
      try { event = JSON.parse(raw); } catch { return reply.code(400).send({ error: { code: 'BAD_JSON', message: 'Invalid JSON' } }); }

      if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
        return reply.code(200).send({ received: true, ignored: event.event_type });
      }

      const cap = event.resource ?? {};
      const captureId: string = cap.id;
      const decoded = decodeCustomId(cap.custom_id);
      if (!captureId || !decoded) {
        req.log.warn({ captureId, hasCustom: !!cap.custom_id }, 'paypal webhook: unresolvable capture');
        return reply.code(200).send({ received: true, ignored: 'unresolvable' });
      }

      const outcome = await grantPaidEntitlementPaypal(db, cfg, {
        captureId,
        orderId: cap.supplementary_data?.related_ids?.order_id ?? '',
        tier: decoded.tier,
        guardianEmail: decoded.guardianEmail,
        amount: cap.amount?.value ?? null,
        eventType: event.event_type,
        log: req.log,
      });
      if (outcome === 'amount_mismatch') {
        return reply.code(400).send({ error: { code: 'AMOUNT_TIER_MISMATCH', message: 'Captured amount does not match tier' } });
      }
      return reply.code(200).send({ received: true, outcome });
    });
  });
}
