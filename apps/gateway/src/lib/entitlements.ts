import type { DB } from '../db.js';

// CCAT Payments — Phase 2 entitlements. Server-side source of truth for the $50 gate.
//
// The gateway is the ONLY DB client; the guardian is resolved from the authenticated SESSION
// (student -> primary guardian contact email), never from a client-supplied id or tier. Enforcement
// built on this cannot be bypassed by the client; the web app's locks are cosmetic only.
//
// Feature-flag contract: NOTHING here runs unless the caller checks cfg.paymentsEnabled first. When the
// flag is OFF the gateway serves content exactly as today (a true no-op) and this module is never invoked
// on the content paths.

export type Tier = 'free' | 't50' | 't250' | 't500';

// Full tier order (low -> high). Encodes the whole map so enabling $250/$500 later is a one-line change
// to ALLOWED_TIERS below.
const TIER_ORDER: Tier[] = ['free', 't50', 't250', 't500'];

// PHASE CLAMP: tiers reachable this phase. Phase 1 (Stripe checkout) OPENS all four — a paid t250/t500
// now grants its real capabilities. clampTier still guards against a tier outside this array (defence in
// depth). To re-close a tier, remove it here and any t250/t500 row is clamped down to the highest listed.
export const ALLOWED_TIERS: Tier[] = ['free', 't50', 't250', 't500'];

// Tiers that can be PURCHASED via Stripe (free is the default, never sold). Order low -> high.
export const SELLABLE_TIERS: Tier[] = ['t50', 't250', 't500'];

// Numeric rank of a tier in TIER_ORDER (free=0). Unknown -> 0 (treated as free).
export function tierRank(t: Tier): number {
  const i = TIER_ORDER.indexOf(t);
  return i < 0 ? 0 : i;
}

// The tiers a guardian currently at `current` may upgrade TO: strictly higher, sellable, and reachable
// this phase (ALLOWED_TIERS). Server-owned eligibility — the client never decides this. No downgrades,
// no same-tier "upgrade".
export function eligibleUpgrades(current: Tier): Tier[] {
  return SELLABLE_TIERS.filter((t) => ALLOWED_TIERS.includes(t) && tierRank(t) > tierRank(current));
}

// Guard for the checkout route: is `requested` a legal upgrade from `current`? Returns null when OK,
// otherwise a short machine reason ('not_sellable' | 'not_an_upgrade' | 'not_available').
export function checkoutRejectReason(current: Tier, requested: Tier): null | 'not_sellable' | 'not_an_upgrade' | 'not_available' {
  if (!SELLABLE_TIERS.includes(requested)) return 'not_sellable';
  if (!ALLOWED_TIERS.includes(requested)) return 'not_available';
  if (tierRank(requested) <= tierRank(current)) return 'not_an_upgrade';
  return null;
}

export interface Capabilities {
  practice: 'demo' | 'all';
  combine: boolean;
  exam: boolean;
  weekly: boolean;
}

// Capability map keyed by EFFECTIVE (clamped) tier. t250/t500 are encoded but unreachable this phase.
export const CAPABILITY_MAP: Record<Tier, Capabilities> = {
  free: { practice: 'demo', combine: false, exam: false, weekly: false },
  t50: { practice: 'all', combine: false, exam: false, weekly: false },
  t250: { practice: 'all', combine: true, exam: true, weekly: false }, // not reachable this phase
  t500: { practice: 'all', combine: true, exam: true, weekly: true }, // not reachable this phase
};

// When the flag is OFF, /v1/entitlements/me returns capabilities that unlock EVERYTHING, so accidental
// client use of the endpoint can never lock the (free-for-all) production experience.
export const CAPABILITIES_UNLOCKED_ALL: Capabilities = { practice: 'all', combine: true, exam: true, weekly: true };

// Clamp a resolved tier to the highest tier reachable this phase (see ALLOWED_TIERS).
export function clampTier(t: Tier): Tier {
  const maxAllowed = ALLOWED_TIERS[ALLOWED_TIERS.length - 1] ?? 'free';
  const i = TIER_ORDER.indexOf(t);
  const maxI = TIER_ORDER.indexOf(maxAllowed);
  if (i < 0) return 'free';
  return i > maxI ? maxAllowed : t;
}

export interface EffectiveEntitlement {
  tier: Tier;                 // effective, CLAMPED tier used for capabilities
  rawTier: Tier;              // tier stored in the DB before clamp (audit/debug only)
  status: string;             // db status ('active'|'canceled'|'expired'|'pending') or 'active' when no row
  currentPeriodEnd: string | null;
  guardianEmail: string | null;
  capabilities: Capabilities;
}

// Resolve the authenticated student's primary guardian email (lower-cased match key), or null when the
// student has no guardian contact with an email. guardian_contacts.email is citext; cast + lower to match
// the entitlements unique index on lower(guardian_email).
export async function resolveGuardianEmail(db: DB, studentId: string): Promise<string | null> {
  const { rows } = await db.query(
    `select gc.email::text as email
       from ccat.student_guardians sg
       join ccat.guardian_contacts gc on gc.id = sg.guardian_id
      where sg.student_id = $1 and gc.email is not null
      order by sg.is_primary desc, sg.created_at asc
      limit 1`,
    [studentId],
  );
  const email = rows[0]?.email;
  return email ? String(email).trim().toLowerCase() : null;
}

// Resolve the effective entitlement for a student. Null-safe: no guardian, no row, expired, or canceled
// all collapse to 'free'. An over-allowed tier is clamped to ALLOWED_TIERS.
export async function resolveEntitlement(db: DB, studentId: string): Promise<EffectiveEntitlement> {
  const guardianEmail = await resolveGuardianEmail(db, studentId);
  let rawTier: Tier = 'free';
  let status = 'active';
  let currentPeriodEnd: string | null = null;

  if (guardianEmail) {
    const { rows } = await db.query(
      `select tier, status, current_period_end
         from ccat.entitlements
        where lower(guardian_email) = $1
        limit 1`,
      [guardianEmail],
    );
    if (rows.length) {
      const r = rows[0]!;
      status = r.status;
      currentPeriodEnd = r.current_period_end ? new Date(r.current_period_end).toISOString() : null;
      const notExpired = r.current_period_end == null || new Date(r.current_period_end) > new Date();
      const active = r.status === 'active' && notExpired;
      rawTier = active ? (TIER_ORDER.includes(r.tier) ? (r.tier as Tier) : 'free') : 'free';
    }
  }

  const tier = clampTier(rawTier);
  return { tier, rawTier, status, currentPeriodEnd, guardianEmail, capabilities: CAPABILITY_MAP[tier] };
}

// A subcategory is a "Battery Combine" subcategory (key convention '<battery>_battery_combine', cap 45)
// rather than a normal 15-question subcategory. Detect by key first, fall back to the size cap so a
// mis-keyed combine subcategory is still treated as combine.
export function isCombineSubcategory(subcategoryKey: string | null | undefined, maxQuestionsPerSet: number | null | undefined): boolean {
  const key = (subcategoryKey ?? '').toLowerCase();
  if (key.includes('battery_combine') || key.endsWith('_combine') || key === 'combine') return true;
  return (maxQuestionsPerSet ?? 15) >= 45;
}

// Compute the ONE demo set per battery for a grade: the first set of the first subcategory of each
// battery, derived deterministically from the DB (never hard-coded ids). Ordering mirrors the prompt:
// subcategories by (display_order, created_at, id); sets by (created_at, id) among PUBLISHED sets with
// active questions (published excludes retired, so this is the first non-retired set). DISTINCT ON the
// category id with a matching leading ORDER BY picks the first per battery. Grade-scoped, so free users
// get the first set they actually see in their own catalog.
export async function computeDemoSetIds(db: DB, gradeId: string): Promise<Set<string>> {
  const { rows } = await db.query(
    `select distinct on (cat.id) sv.id as set_version_id
       from ccat.question_sets qs
       join ccat.categories cat on cat.id = qs.category_id
       join ccat.subcategories sub on sub.id = qs.subcategory_id
       join ccat.question_set_versions sv on sv.question_set_id = qs.id
      where qs.grade_id = $1
        and sv.state = 'published'
        and exists (select 1 from ccat.set_version_questions svq
                     where svq.set_version_id = sv.id and svq.active = true)
      order by cat.id, sub.display_order asc, sub.created_at asc, sub.id asc, sv.created_at asc, sv.id asc`,
    [gradeId],
  );
  return new Set(rows.map((r) => String(r.set_version_id)));
}

// Practice-context lock for a catalog row, given the effective capabilities + the grade's demo set ids.
//  - combine set        -> locked unless capabilities.combine
//  - practice 'all'      -> all non-combine practice sets unlocked
//  - practice 'demo'     -> only the per-battery demo set is unlocked; every other set is locked
// Exam entries are locked wholesale by the client from capabilities.exam (2C) and hard-gated at
// /v1/sessions/start; this boolean governs the practice listing (1E).
export function isSetLockedForPractice(
  args: { setVersionId: string; isCombine: boolean },
  caps: Capabilities,
  demoSetIds: Set<string>,
): boolean {
  if (args.isCombine) return !caps.combine;
  if (caps.practice === 'all') return false;
  return !demoSetIds.has(args.setVersionId);
}
