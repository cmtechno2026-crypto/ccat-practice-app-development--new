import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import type { Config } from '../src/config.js';
import { grantPaidEntitlementPaypal } from '../src/lib/paypal-grant.js';

// Focused tests for the PayPal money->entitlement grant (the shared path used by both the return-time
// capture and the webhook). Pure DB logic; no network. Also proves migration 0044 (paypal_payment_events)
// applied in the test DB.
let db: pg.Client;
let cfg: Config;

beforeAll(async () => {
  cfg = { ...loadConfig(), paymentsEnabled: true,
    paypal: { env: 'sandbox', clientId: 'x', secret: 'y', webhookId: 'w', prices: { t50: '50.00', t250: '250.00', t500: '500.00' } } };
  db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect(); await db.query('set search_path = ccat, public');
});
afterAll(async () => { await db.end(); });

async function tierOf(email: string) {
  const r = await db.query('select tier, status, grant_reason, source from ccat.entitlements where lower(guardian_email)=$1', [email.toLowerCase()]);
  return r.rows[0] ?? null;
}

describe('PayPal grant', () => {
  it('grants a paid entitlement on a valid capture (active, grant_reason=paid)', async () => {
    const email = 'pp_grant@ex.com';
    // Charge is base + 13% HST: 250.00 -> 282.50.
    const out = await grantPaidEntitlementPaypal(db, cfg, { captureId: 'cap_1', orderId: 'ord_1', tier: 't250', guardianEmail: email, amount: '282.50', eventType: 'capture' });
    expect(out).toBe('granted');
    const e = await tierOf(email);
    expect(e).toMatchObject({ tier: 't250', status: 'active', grant_reason: 'paid', source: 'webhook' });
  });

  it('is idempotent on the capture id (second call dedupes, no change)', async () => {
    const email = 'pp_idem@ex.com';
    expect(await grantPaidEntitlementPaypal(db, cfg, { captureId: 'cap_2', orderId: 'o', tier: 't50', guardianEmail: email, amount: '56.50', eventType: 'capture' })).toBe('granted');
    expect(await grantPaidEntitlementPaypal(db, cfg, { captureId: 'cap_2', orderId: 'o', tier: 't500', guardianEmail: email, amount: '565.00', eventType: 'PAYMENT.CAPTURE.COMPLETED' })).toBe('deduped');
    const e = await tierOf(email);
    expect(e.tier).toBe('t50'); // unchanged by the deduped second call
  });

  it('refuses when the captured amount does not match the tier price', async () => {
    const email = 'pp_mismatch@ex.com';
    const out = await grantPaidEntitlementPaypal(db, cfg, { captureId: 'cap_3', orderId: 'o', tier: 't50', guardianEmail: email, amount: '5.00', eventType: 'capture' });
    expect(out).toBe('amount_mismatch');
    expect(await tierOf(email)).toBeNull();
  });

  it('refuses a base-price capture that is missing HST, and grants the stamped tax-inclusive total', async () => {
    // Pre-tax base for t50 is 50.00; a capture of exactly the base (no HST) must now be refused.
    const noTax = 'pp_notax@ex.com';
    expect(await grantPaidEntitlementPaypal(db, cfg, { captureId: 'cap_hst_1', orderId: 'o', tier: 't50', guardianEmail: noTax, amount: '50.00', eventType: 'capture' })).toBe('amount_mismatch');
    expect(await tierOf(noTax)).toBeNull();

    // A promo-discounted subtotal (50% off 50.00 = 25.00) + HST = 28.25, stamped into custom_id, is honoured.
    const promo = 'pp_promo_hst@ex.com';
    const out = await grantPaidEntitlementPaypal(db, cfg, { captureId: 'cap_hst_2', orderId: 'o', tier: 't50', guardianEmail: promo, amount: '28.25', expectedAmount: '28.25', eventType: 'capture' });
    expect(out).toBe('granted');
    expect((await tierOf(promo)).tier).toBe('t50');
  });

  it('ignores a non-sellable tier or missing email', async () => {
    expect(await grantPaidEntitlementPaypal(db, cfg, { captureId: 'cap_4', orderId: 'o', tier: 'free', guardianEmail: 'x@x.com', amount: '0.00', eventType: 'capture' })).toBe('ignored');
    expect(await grantPaidEntitlementPaypal(db, cfg, { captureId: 'cap_5', orderId: 'o', tier: 't50', guardianEmail: '', amount: '50.00', eventType: 'capture' })).toBe('ignored');
  });

  it('a real upgrade overrides a prior comp grant to paid', async () => {
    const email = 'pp_comp@ex.com';
    await db.query(`insert into ccat.entitlements (guardian_email, tier, status, source, grant_reason) values ($1,'t50','active','manual','comp')`, [email]);
    const out = await grantPaidEntitlementPaypal(db, cfg, { captureId: 'cap_6', orderId: 'o', tier: 't250', guardianEmail: email, amount: '282.50', eventType: 'capture' });
    expect(out).toBe('granted');
    const e = await tierOf(email);
    expect(e).toMatchObject({ tier: 't250', grant_reason: 'paid' });
  });
});
