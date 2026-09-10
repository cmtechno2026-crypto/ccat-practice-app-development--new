import type { EntitlementCapabilities, EntitlementsMe } from '@ccat/api-client';

// Payments Phase 2 (student web). The flag is read ONCE from the build-time env. When it is false the
// app must render EXACTLY as today — no locks, no Upgrade UI, and no /v1/entitlements/me call.
// Tolerant parse: trims whitespace, strips accidental surrounding quotes, lowercases — so a value saved
// as `true `, `"true"`, or `TRUE` still enables it. Anything else (including unset) = off.
const rawPaymentsFlag = String((import.meta.env.VITE_PAYMENTS_ENABLED as string | undefined) ?? '')
  .trim().replace(/^['"]+|['"]+$/g, '').toLowerCase();
export const PAYMENTS_ENABLED: boolean =
  rawPaymentsFlag === 'true' || rawPaymentsFlag === '1' || rawPaymentsFlag === 'yes' || rawPaymentsFlag === 'on';

// Where the Upgrade button sends a grown-up. The CCAT app NEVER collects card/payment details; it only
// links OUT to a Concept Mastery page. MEMBERSHIP_URL is the generic fallback; per-tier product pages
// override it where set (see MEMBERSHIP_URL_BY_TIER / membershipUrlFor).
export const MEMBERSHIP_URL = 'https://conceptmastery.com/ccat/';

// Per-tier product/checkout pages on the Concept Mastery site. A tier not listed falls back to
// MEMBERSHIP_URL. Set t250/t500 to their real product pages when available.
export const MEMBERSHIP_URL_BY_TIER: Partial<Record<EntitlementTier, string>> = {
  t50: 'https://conceptmastery.com/store/ccat-practice-library-access/',
};

// The URL the Upgrade button for `tier` should open.
export function membershipUrlFor(tier: EntitlementTier): string {
  return MEMBERSHIP_URL_BY_TIER[tier] ?? MEMBERSHIP_URL;
}

// Whether a tier's Upgrade button should be active. Only tiers with an explicit product page in
// MEMBERSHIP_URL_BY_TIER are clickable; others render disabled (no action) until a URL is set.
export function isUpgradeLinkable(tier: EntitlementTier): boolean {
  return MEMBERSHIP_URL_BY_TIER[tier] != null;
}

// Capabilities used when payments is OFF: everything unlocked, so the experience is identical to today.
// Mirrors the gateway's CAPABILITIES_UNLOCKED_ALL.
export const CAPS_UNLOCKED_ALL: EntitlementCapabilities = { practice: 'all', combine: true, exam: true, weekly: true };
// Most-restrictive caps, used WHILE the entitlement is still loading so premium never flashes unlocked
// before snapping to locked. Same as the free tier.
export const CAPS_LOCKED: EntitlementCapabilities = { practice: 'demo', combine: false, exam: false, weekly: false };

// Effective capabilities for the UI:
//  - payments OFF → unlock all (identical to today).
//  - payments ON, entitlement NOT yet loaded → LOCKED (no flash-of-unlocked-content).
//  - payments ON, loaded → the real capabilities; if the fetch settled with no data (error), fail OPEN
//    (unlock) so a transient /me failure can't lock a paying user out — the server still enforces.
export function capsOf(ent: EntitlementsMe | null | undefined, loaded: boolean = true): EntitlementCapabilities {
  if (!PAYMENTS_ENABLED) return CAPS_UNLOCKED_ALL;
  if (!loaded) return CAPS_LOCKED;
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
  name: string;         // full name (Standard / Plus / Premium)
  price: string;        // big price, e.g. '$100'
  priceLabel: string;   // price with currency, e.g. '$100 CAD' (used on buttons)
  accessTerm?: string;  // e.g. '1-year access'
  desc?: string;        // one-line plan description
  badge?: string;       // e.g. 'BEST VALUE'
  features: string[];   // what it unlocks
}

export const TIER_SEQUENCE: EntitlementTier[] = ['free', 't50', 't250', 't500'];
export const SELLABLE_TIERS: EntitlementTier[] = ['t50', 't250', 't500'];

export const TIER_CATALOG: Record<EntitlementTier, TierInfo> = {
  free: { tier: 'free', label: 'Free', name: 'Free', price: '$0', priceLabel: '$0 CAD',
    desc: 'Explore the platform before choosing a paid plan.',
    features: ['1 demo practice set for each battery'] },
  t50: { tier: 't50', label: '$50', name: 'Standard', price: '$50', priceLabel: '$50 CAD', accessTerm: '1-year access',
    desc: 'Ideal for students who want full access to practice material.',
    features: ['Unlimited access to all individual practice sets'] },
  t250: { tier: 't250', label: '$100', name: 'Plus', price: '$100', priceLabel: '$100 CAD', accessTerm: '1-year access',
    desc: 'Expanded practice access, including full battery tests and timed exams.',
    features: ['Unlimited access to all individual practice sets', 'Unlimited access to full battery tests', 'Full-length timed exam papers'] },
  t500: { tier: 't500', label: '$200', name: 'Premium', price: '$200', priceLabel: '$200 CAD', accessTerm: '1-year access', badge: 'BEST VALUE',
    desc: 'Complete preparation with practice, exams, and personal mentoring.',
    features: ['Unlimited access to all individual practice sets', 'Full-length timed exam papers', 'Unlimited access to full battery tests', 'Weekly test', '5 live 1-on-1 mentoring sessions'] },
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
