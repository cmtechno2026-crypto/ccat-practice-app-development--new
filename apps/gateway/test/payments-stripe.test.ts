import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { createPool, type DB } from '../src/db.js';
import type { Config } from '../src/config.js';
import { registerStripeWebhookRoutes } from '../src/routes/stripe-webhook.js';
import { checkoutRejectReason, eligibleUpgrades } from '../src/lib/entitlements.js';

// CCAT Payments Phase 1 — Stripe checkout eligibility + webhook (signature, idempotency, confirmed-payment
// grant, redirect-is-not-authority). Uses the real Stripe SDK OFFLINE for signature crypto; listLineItems
// is stubbed so no network is touched. The webhook's DB writes run against the shared test database that
// the global setup created (migrations include 0040 entitlements + 0042 payment_events).

// ---- Pure server-owned eligibility (checkout authorization / invalid+ineligible tiers) -------------
describe('checkout eligibility (server-owned)', () => {
  it('lists only strictly-higher sellable tiers as upgrades (no downgrade, no same)', () => {
    expect(eligibleUpgrades('free')).toEqual(['t50', 't250', 't500']);
    expect(eligibleUpgrades('t50')).toEqual(['t250', 't500']);
    expect(eligibleUpgrades('t250')).toEqual(['t500']);
    expect(eligibleUpgrades('t500')).toEqual([]);
  });

  it('rejects downgrade, same-tier, and non-sellable/free targets', () => {
    expect(checkoutRejectReason('t250', 't50')).toBe('not_an_upgrade'); // downgrade
    expect(checkoutRejectReason('t50', 't50')).toBe('not_an_upgrade');  // same
    expect(checkoutRejectReason('free', 'free' as any)).toBe('not_sellable');
    expect(checkoutRejectReason('free', 't999' as any)).toBe('not_sellable');
  });

  it('accepts a legitimate upgrade', () => {
    expect(checkoutRejectReason('free', 't50')).toBeNull();
    expect(checkoutRejectReason('t50', 't250')).toBeNull();
    expect(checkoutRejectReason('t250', 't500')).toBeNull();
  });
});

// ---- Webhook -------------------------------------------------------------------------------------
const SECRET = 'whsec_test_secret_for_ccat';
const EMAIL = 'wh_test@example.com';

function makeCfg(): Config {
  return {
    paymentsEnabled: true,
    stripeSecretKey: 'sk_test_dummy',
    stripeWebhookSecret: SECRET,
    stripePriceIds: { t50: 'price_t50', t250: 'price_t250', t500: 'price_t500' },
  } as unknown as Config;
}

// A Stripe instance used ONLY for real offline crypto (constructEvent + generateTestHeaderString) with
// listLineItems stubbed to a chosen price so the handler's cross-check runs without network.
function stripeWithPaidPrice(priceId: string): Stripe {
  const s = new Stripe('sk_test_dummy');
  (s.checkout.sessions as any).listLineItems = async () => ({ data: [{ price: { id: priceId } }] });
  return s;
}

function completedEvent(id: string, tier: string, opts: { payment_status?: string } = {}) {
  return {
    id,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${id}`,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: opts.payment_status ?? 'paid',
        metadata: { tier, guardian_email: EMAIL, student_id: 'stu_x' },
        client_reference_id: EMAIL,
        customer_email: EMAIL,
      },
    },
  };
}

async function postEvent(app: FastifyInstance, stripe: Stripe, evt: object, badSig = false) {
  const payload = JSON.stringify(evt);
  const header = badSig ? 't=1,v1=deadbeef' : stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: { 'stripe-signature': header, 'content-type': 'application/json' },
    payload,
  });
}

async function tierFor(db: DB, email: string): Promise<string | null> {
  const r = await db.query('select tier from ccat.entitlements where lower(guardian_email) = $1', [email.toLowerCase()]);
  return r.rows[0]?.tier ?? null;
}

describe('stripe webhook', () => {
  let db: DB;
  const url = process.env.TEST_DATABASE_URL;

  beforeAll(() => { db = createPool(url!); });
  afterAll(async () => { await (db as any).end?.(); });
  beforeEach(async () => {
    await db.query('delete from ccat.payment_events');
    await db.query('delete from ccat.entitlements where lower(guardian_email) = $1', [EMAIL]);
  });

  function buildWebhookApp(stripe: Stripe): FastifyInstance {
    const app = Fastify();
    registerStripeWebhookRoutes(app, db, makeCfg(), { stripe });
    return app;
  }

  it('rejects an invalid signature with 400 and grants nothing', async () => {
    const stripe = stripeWithPaidPrice('price_t250');
    const app = buildWebhookApp(stripe);
    const res = await postEvent(app, stripe, completedEvent('evt_badsig', 't250'), /* badSig */ true);
    expect(res.statusCode).toBe(400);
    expect(await tierFor(db, EMAIL)).toBeNull();
    await app.close();
  });

  it('grants the paid tier on a signed checkout.session.completed', async () => {
    const stripe = stripeWithPaidPrice('price_t250');
    const app = buildWebhookApp(stripe);
    const res = await postEvent(app, stripe, completedEvent('evt_ok', 't250'));
    expect(res.statusCode).toBe(200);
    expect(await tierFor(db, EMAIL)).toBe('t250');
    await app.close();
  });

  it('is idempotent — a redelivered event does not reprocess', async () => {
    const stripe = stripeWithPaidPrice('price_t250');
    const app = buildWebhookApp(stripe);
    const first = await postEvent(app, stripe, completedEvent('evt_dupe', 't250'));
    expect(first.statusCode).toBe(200);
    const second = await postEvent(app, stripe, completedEvent('evt_dupe', 't250'));
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).deduped).toBe(true);
    const events = await db.query('select count(*)::int n from ccat.payment_events where stripe_event_id = $1', ['evt_dupe']);
    expect(events.rows[0].n).toBe(1);
    expect(await tierFor(db, EMAIL)).toBe('t250');
    await app.close();
  });

  it('does NOT grant when payment is not confirmed (redirect/incomplete is not authority)', async () => {
    const stripe = stripeWithPaidPrice('price_t250');
    const app = buildWebhookApp(stripe);
    const res = await postEvent(app, stripe, completedEvent('evt_unpaid', 't250', { payment_status: 'unpaid' }));
    expect(res.statusCode).toBe(200);
    expect(await tierFor(db, EMAIL)).toBeNull();
    await app.close();
  });

  it('refuses to grant when the paid price does not match the metadata tier', async () => {
    // Session says t500 but the line item price is the t50 price → mismatch → 400, no grant.
    const stripe = stripeWithPaidPrice('price_t50');
    const app = buildWebhookApp(stripe);
    const res = await postEvent(app, stripe, completedEvent('evt_mismatch', 't500'));
    expect(res.statusCode).toBe(400);
    expect(await tierFor(db, EMAIL)).toBeNull();
    await app.close();
  });
});
