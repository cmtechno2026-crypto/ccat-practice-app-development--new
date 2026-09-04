/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_GATEWAY_URL?: string;
  // Payments Phase 2 — 'true' turns on membership gating in the web app; anything else = off (default).
  readonly VITE_PAYMENTS_ENABLED?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
