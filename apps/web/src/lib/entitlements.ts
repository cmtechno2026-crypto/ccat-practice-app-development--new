import type { EntitlementCapabilities, EntitlementsMe } from '@ccat/api-client';

// Payments Phase 2 (student web). The flag is read ONCE from the build-time env. When it is false the
// app must render EXACTLY as today — no locks, no Upgrade UI, and no /v1/entitlements/me call.
export const PAYMENTS_ENABLED: boolean =
  (import.meta.env.VITE_PAYMENTS_ENABLED as string | undefined) === 'true';

// Where the Upgrade button sends a grown-up. PLACEHOLDER — set the real conceptmastery.com membership
// URL later. The CCAT app NEVER collects card/payment details; it only links OUT to this page.
export const MEMBERSHIP_URL = 'https://www.conceptmastery.com/membership';

// Capabilities used when payments is OFF or entitlements haven't loaded yet: everything unlocked, so the
// experience is identical to today. Mirrors the gateway's CAPABILITIES_UNLOCKED_ALL.
export const CAPS_UNLOCKED_ALL: EntitlementCapabilities = { practice: 'all', combine: true, exam: true, weekly: true };

// Effective capabilities for the UI. Off / not-loaded → unlock all (never lock production by accident).
export function capsOf(ent: EntitlementsMe | null | undefined): EntitlementCapabilities {
  if (!PAYMENTS_ENABLED) return CAPS_UNLOCKED_ALL;
  return ent?.capabilities ?? CAPS_UNLOCKED_ALL;
}

export type UpgradeFeature = 'practice' | 'combine' | 'exam' | 'weekly';

// ---- Payments Phase 1 (My Plan / Stripe Checkout) --------------------------------------------------
// DISPLAY-ONLY tier catalog for the My Plan page. Prices here are for showing the user; the gateway
// owns the real Stripe price and the eligibility decision (this list never gates anything server-side).
import type { EntitlementTier } from '@ccat/api-client';

export interface TierInfo {
  tier: EntitlementTier;
  label: string;        // short ($50)
  name: string;         // full name
  priceLabel: string;   // display price
  features: string[];   // what it unlocks (kid-readable)
}

export const TIER_SEQUENCE: EntitlementTier[] = ['free', 't50', 't250', 't500'];
export const SELLABLE_TIERS: EntitlementTier[] = ['t50', 't250', 't500'];

export const TIER_CATALOG: Record<EntitlementTier, TierInfo> = {
  free: { tier: 'free', label: 'Free', name: 'Free', priceLabel: '$0',
    features: ['One demo practice set per battery'] },
  t50: { tier: 't50', label: '$50', name: 'All Practice', priceLabel: '$50 CAD',
    features: ['All practice sets unlocked'] },
  t250: { tier: 't250', label: '$250', name: 'Practice + Exam + Combine', priceLabel: '$250 CAD',
    features: ['All practice sets', 'Full timed Exam papers', 'Battery Combine'] },
  t500: { tier: 't500', label: '$500', name: 'Everything + Weekly', priceLabel: '$500 CAD',
    features: ['All practice sets', 'Full timed Exam papers', 'Battery Combine', 'Weekly test'] },
};

export function tierIndex(t: EntitlementTier): number {
  const i = TIER_SEQUENCE.indexOf(t);
  return i < 0 ? 0 : i;
}

// Higher, purchasable tiers a student currently at `current` may upgrade to (no downgrade, no same).
// Mirrors the gateway's server-side eligibility; the gateway still enforces it at checkout.
export function eligibleUpgradeTiers(current: EntitlementTier): EntitlementTier[] {
  return SELLABLE_TIERS.filter((t) => tierIndex(t) > tierIndex(current));
}
