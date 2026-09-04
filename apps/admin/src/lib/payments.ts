// Payments Phase 2 (admin). Build-time flag. When false the Membership grant control is hidden and the
// admin renders exactly as today. Mirrors the gateway PAYMENTS_ENABLED / web VITE_PAYMENTS_ENABLED.
export const PAYMENTS_ENABLED: boolean = ((import.meta as any).env?.VITE_PAYMENTS_ENABLED) === 'true';
