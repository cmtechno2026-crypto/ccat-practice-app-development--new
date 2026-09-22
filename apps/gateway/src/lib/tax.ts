// HST on every membership charge. Concept Mastery is ON-registered, so a flat 13% HST is added on top of
// the (already promo-discounted) plan price for every buyer, and is charged — not just displayed. Kept as a
// constant so the price the parent SEES (apps/web) and the price PayPal is CHARGED (this gateway) use the
// exact same math; to change the rate, update HST_RATE here AND the mirrored constant in
// apps/web/src/lib/promo.ts together, or display and charge will drift.
export const HST_RATE = 0.13;

// Split a pre-tax amount string ("49.50", "$99", "99.00") into { subtotal, tax, total } as PayPal-valid
// 2-decimal strings. tax = round(subtotal * HST_RATE); total = subtotal + tax — so subtotal + tax always
// equals total exactly (PayPal rejects an amount whose breakdown does not sum). An unparsable/<=0 input
// returns the input as the total with zero tax, so callers can use it unconditionally (fail-open to the
// old, taxless behaviour rather than blocking a sale).
export function withHst(subtotal: string): { subtotal: string; tax: string; total: string } {
  const m = String(subtotal).match(/([\d.]+)/);
  const raw = m?.[1] ? parseFloat(m[1]) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) {
    const t = String(subtotal);
    return { subtotal: t, tax: '0.00', total: t };
  }
  const s = Math.round(raw * 100) / 100;
  const tax = Math.round(s * HST_RATE * 100) / 100;
  const total = Math.round((s + tax) * 100) / 100;
  return { subtotal: s.toFixed(2), tax: tax.toFixed(2), total: total.toFixed(2) };
}
