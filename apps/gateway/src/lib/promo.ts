import type { DB } from '../db.js';

// Site-wide promotional discount (display-only). Reads the singleton ccat.promo_campaign row (migration
// 0047) and computes whether the promo is LIVE right now: enabled AND now within [starts_at, ends_at].
//
// Fails safe: if the table does not exist yet (migration 0047 not applied) or the query errors for any
// reason, this returns an inactive promo — so the gateway keeps serving normal prices and the site shows
// no banner. Nothing here changes the PayPal charge amount; the discount is display-only.

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
