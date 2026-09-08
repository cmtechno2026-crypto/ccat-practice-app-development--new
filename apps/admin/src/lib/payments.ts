// Payments Phase 2 (admin). Build-time flag. When false the Membership grant control is hidden and the
// admin renders exactly as today. Mirrors the gateway PAYMENTS_ENABLED / web VITE_PAYMENTS_ENABLED.
// Tolerant parse: trims whitespace, strips accidental surrounding quotes, and lowercases, so a value
// entered as `true `, `"true"`, or `TRUE` still enables it. Anything else (incl. unset) = off.
const raw = String((import.meta as any).env?.VITE_PAYMENTS_ENABLED ?? '')
  .trim().replace(/^['"]+|['"]+$/g, '').toLowerCase();
export const PAYMENTS_ENABLED: boolean = raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
