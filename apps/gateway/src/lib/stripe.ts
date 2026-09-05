import Stripe from 'stripe';
import type { Config } from '../config.js';
import type { Tier } from './entitlements.js';

// CCAT Payments Phase 1 — Stripe client factory. The secret key is SERVER-ONLY (never in a browser
// bundle). Cached per secret so one process reuses one client; a different secret (tests) gets its own.
// Nothing here runs unless cfg.paymentsEnabled is true AND the caller has a configured secret — the
// routes check the flag and surface a clear config error when the key is missing.
const cache = new Map<string, Stripe>();

export function getStripe(cfg: Config): Stripe {
  if (!cfg.stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is not configured');
  let s = cache.get(cfg.stripeSecretKey);
  if (!s) {
    s = new Stripe(cfg.stripeSecretKey);
    cache.set(cfg.stripeSecretKey, s);
  }
  return s;
}

// Server-owned tier -> Stripe Price ID. The ONLY source of a price for Checkout; a client-supplied
// price/amount/currency is never accepted. Returns '' when unconfigured (caller fails closed).
export function priceIdForTier(cfg: Config, tier: Tier): string {
  if (tier === 't50') return cfg.stripePriceIds.t50;
  if (tier === 't250') return cfg.stripePriceIds.t250;
  if (tier === 't500') return cfg.stripePriceIds.t500;
  return '';
}
