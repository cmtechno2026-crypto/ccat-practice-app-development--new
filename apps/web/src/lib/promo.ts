import { useEffect, useState } from 'react';
import type { PromoPublic } from '@ccat/api-client';
import { client } from './api';

// Site-wide promotional discount. Fetches GET /v1/promo once, then ticks every second so the countdown
// updates and the promo auto-hides the instant it ends (client re-checks endsAt against the clock, so it
// reverts even without a refetch). The gateway independently charges the same discounted amount.
//
// Module-level cache + eager warm: the fetched promo is kept at module scope and the fetch is kicked off as
// soon as this module loads (app boot). Consumers that mount LATER — My Plan, the checkout modal, the PayPal
// step — seed their state from the cache and therefore paint the correct (already-discounted) price on the
// FIRST render, instead of showing the full price for ~1s while a fresh fetch lands and then flipping. Each
// mount still refetches to pick up an admin change mid-session; the cached value is only the instant seed.

export interface PromoView {
  active: boolean;      // live now (server said active AND end is still in the future)
  percent: number;      // % off to display
  headline: string;
  endMs: number | null; // end timestamp (ms) or null for no end
  remaining: number;    // ms remaining, or -1 when there is no end date
}

let promoCache: PromoPublic | null = null;   // last successful fetch (or null); seeds new mounts synchronously
let promoInflight: Promise<PromoPublic | null> | null = null; // dedupes concurrent fetches

function fetchPromo(): Promise<PromoPublic | null> {
  if (!promoInflight) {
    promoInflight = client.promo()
      .then((r) => { promoCache = r; return r; })
      .catch(() => { promoCache = null; return null; })
      .finally(() => { promoInflight = null; }); // allow a later mount to refetch (catch mid-session changes)
  }
  return promoInflight;
}

// Warm the cache at app boot so the price is known before the user ever reaches checkout.
void fetchPromo();

export function usePromo(): PromoView {
  const [p, setP] = useState<PromoPublic | null>(promoCache);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let ok = true;
    fetchPromo().then((r) => { if (ok) setP(r); });
    return () => { ok = false; };
  }, []);

  const serverActive = !!p?.active;
  useEffect(() => {
    if (!serverActive) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [serverActive]);

  const endMs = p?.endsAt ? new Date(p.endsAt).getTime() : null;
  const remaining = endMs != null ? Math.max(0, endMs - now) : -1;
  const active = serverActive && (endMs == null || remaining > 0);
  return { active, percent: p?.percent ?? 0, headline: p?.headline ?? '', endMs, remaining };
}

const pad = (n: number) => String(n).padStart(2, '0');

// Split remaining milliseconds into two-digit Days / Hrs / Min / Sec parts.
export function splitRemaining(ms: number): { days: string; hrs: string; min: string; sec: string } {
  const s = Math.max(0, Math.floor(ms / 1000));
  return {
    days: pad(Math.floor(s / 86400)),
    hrs: pad(Math.floor((s % 86400) / 3600)),
    min: pad(Math.floor((s % 3600) / 60)),
    sec: pad(s % 60),
  };
}

// Discount a "$49"-style price string by `percent`. Returns null for free/unparsable prices so callers
// leave them unchanged. Whole results show as "$24", fractional as "$24.50".
export function discountPrice(priceStr: string, percent: number): { oldStr: string; newStr: string } | null {
  const m = priceStr.match(/([\d.]+)/);
  const raw = m?.[1];
  if (!raw) return null;
  const amt = parseFloat(raw);
  if (!amt || amt <= 0 || percent <= 0) return null;
  const next = amt * (1 - percent / 100);
  const fmt = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
  return { oldStr: fmt(amt), newStr: fmt(next) };
}
