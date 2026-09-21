import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { amountForTier } from './paypal.js';
import type { Tier } from './entitlements.js';

// Site-wide promotional discount. Reads the singleton ccat.promo_campaign row (migration 0047) and
// computes whether the promo is LIVE right now: enabled AND now within [starts_at, ends_at].
//
// Fails safe: if the table does not exist yet (migration 0047 not applied) or the query errors for any
// reason, this returns an inactive promo — so the gateway keeps serving normal prices and the site shows
// no banner.
//
// When a promo is live, effectiveAmountForTier() below applies it to the server-owned PayPal charge so the
// buyer is actually billed the discounted price (not just shown it). The discount is driven entirely by
// the admin panel via this table — no env/Render change — and reverts automatically the moment the timer
// ends, because loadPromo recomputes liveNow against the clock on every order.

export interface PromoState {
  enabled: boolean;         // the admin toggle (regardless of the time window)
  percent: number;          // 0–90
  startsAt: string | null;  // ISO (UTC) or null
  endsAt: string | null;    // ISO (UTC) or null
  headline: string;
  liveNow: boolean;         // enabled AND within the time window right now
}

const INACTIVE: PromoState = { enabled: false, percent: 0, startsAt: null, endsAt: null, headline: '', liveNow: false };

export async function loadPromo(db: DB): Promise<PromoState> {
  try {
    const { rows } = await db.query(
      `select active, percent, starts_at, ends_at, headline from ccat.promo_campaign where id = 1`,
    );
    const r = rows[0];
    if (!r) return INACTIVE;
    const now = Date.now();
    const startsAt = r.starts_at ? new Date(r.starts_at).toISOString() : null;
    const endsAt = r.ends_at ? new Date(r.ends_at).toISOString() : null;
    const started = startsAt == null || new Date(startsAt).getTime() <= now;
    const notEnded = endsAt == null || new Date(endsAt).getTime() > now;
    const enabled = r.active === true;
    const percent = Math.max(0, Math.min(90, Number(r.percent) || 0));
    return { enabled, percent, startsAt, endsAt, headline: r.headline || '', liveNow: enabled && started && notEnded };
  } catch {
    return INACTIVE;
  }
}

// Apply `percent` off a "$49"/"49"/"49.00"-style price string and return a PayPal-valid 2-decimal amount
// ("24.50", "24.00"). Deliberately mirrors the web client's discountPrice() math (apps/web/src/lib/promo.ts)
// so the price the parent SEES equals the price PayPal CHARGES: next = base * (1 - percent/100). Returns
// the base (normalised to 2 decimals) when percent<=0 or the base is unparsable, so callers can use it
// unconditionally. Currency-agnostic string in, string out.
export function discountedAmount(base: string, percent: number): string {
  const m = base.match(/([\d.]+)/);
  const amt = m?.[1] ? parseFloat(m[1]) : NaN;
  if (!Number.isFinite(amt) || amt <= 0) return base;
  const pct = Math.max(0, Math.min(90, Number(percent) || 0));
  const next = pct > 0 ? amt * (1 - pct / 100) : amt;
  return next.toFixed(2);
}

// The single source of the PayPal charge amount for a tier, promo included. Returns the server base price
// (amountForTier) discounted by the live promo, or '' when the tier is unconfigured (caller fails closed,
// exactly as it did with the bare amountForTier). `percent` is the promo % that was applied (0 when none),
// and `amount` is the charge string to both bill and stamp into custom_id.
export async function effectiveAmountForTier(
  db: DB, cfg: Config, tier: Tier,
): Promise<{ amount: string; percent: number }> {
  const base = amountForTier(cfg, tier);
  if (!base) return { amount: '', percent: 0 };
  const promo = await loadPromo(db);
  const pct = promo.liveNow ? promo.percent : 0;
  return { amount: discountedAmount(base, pct), percent: pct };
}
