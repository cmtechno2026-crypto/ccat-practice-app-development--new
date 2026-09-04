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
