# CCAT — Zero-downtime deploy & upgrade runbook

Two deployables from one repo: the **Gateway** (Node/Fastify server, holds all secrets, the ONLY
path to student data) and the **Admin** (static SPA, no secrets). Postgres is Supabase (RLS on;
the gateway connects as a least-privilege role; service_role/DB creds live ONLY in the gateway env).

## Secrets (Gateway env only — never in the admin bundle)
- `DATABASE_URL` — Supabase Postgres (pooled), the gateway's DB role. Keep `?sslmode=require`.
- `GATEWAY_HMAC_SECRET` — signs admin/student tokens + registration grants. Rotate → all sessions invalidate.
  **Production requires >=32 chars and rejects placeholders — the gateway fails to start otherwise.**
- `PIN_PEPPER` — must match the pepper the admin password/PIN verifiers were created with.
  **Mandatory in production** (no silent `dev-pepper` fallback); the gateway fails to start if unset/weak.
- `NODE_ENV=production`.
- `GATEWAY_PUBLIC_URL=https://<api-domain>` — canonical Gateway origin used for expiring asset URLs.
- `STORAGE_DRIVER=supabase` — production assets use the private Supabase Storage bucket.
- `SUPABASE_URL=https://<project-ref>.supabase.co` — Gateway only.
- `SUPABASE_SECRET_KEY` — Supabase secret/service key, Gateway only; never use a publishable key here.
- `SUPABASE_STORAGE_BUCKET=ccat-content` — private bucket, 5 MB limit, PNG/JPEG/WebP/GIF allowlist (SVG is rejected).
- **CORS — set BOTH if both browser clients call the gateway from their own origins:**
  - `ADMIN_WEB_ORIGIN=https://<admin-domain>` — Admin Console origin(s).
  - `WEB_APP_ORIGIN=https://<web-app-domain>` — student Web app origin(s).
  Each accepts a comma-separated list; unlisted origins are refused. Do NOT omit `WEB_APP_ORIGIN` —
  without it the student web app is CORS-blocked in production (the older runbook mentioned only
  `ADMIN_WEB_ORIGIN`; the gateway now allowlists both).
Admin build/runtime: `CCAT_GATEWAY_URL=https://<api-domain>` (injected into `/config.js` at container start).
  → add `<script src="/config.js"></script>` to `apps/admin/index.html` <head> before the app bundle.

## Migrations are applied OUT-OF-BAND, not on boot
All migrations are additive (`add column/table if not exists`, idempotent), so old and new gateway
code both run against the new schema — that's what makes the rolling deploy safe.
1. Apply pending migrations FIRST, while the current version is still serving:
   `DATABASE_URL=<prod> pnpm --filter @ccat/gateway migrate`
   (On a brand-new Supabase project this applies 0000→NNNN from scratch. On an already-migrated
   project the runner backfills its ledger and applies only what's genuinely new.)
2. Then roll the gateway to the new image (health-gated on `/health/ready`).
3. Then publish the new admin build/CDN invalidation.

## Rollback
- Admin: repoint the CDN/host to the previous build (state lives in Postgres, so this is safe/instant).
- Gateway: redeploy the previous image. Additive migrations are forward-compatible — leave them in place.
- Never hard-delete audit/ledger rows; erasure is anonymize+tombstone (already implemented).

## Verify after deploy (both roles)
- `GET /health/ready` → 200.
- Super-Admin login → dashboard; author+publish a set; suspend a student; toggle a flag.
- Content-editor: can author, cannot toggle flags (403). Support: directory yes, health/flags-set no.
- `GET /v1/channel-status` reflects the flags → the website Practice honours it.
