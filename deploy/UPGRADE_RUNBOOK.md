# CCAT — Zero-downtime deploy & upgrade runbook

Two deployables from one repo: the **Gateway** (Node/Fastify server, holds all secrets, the ONLY
path to student data) and the **Admin** (static SPA, no secrets). Postgres is Supabase (RLS on;
the gateway connects as a least-privilege role; service_role/DB creds live ONLY in the gateway env).

## Secrets (Gateway env only — never in the admin bundle)
- `DATABASE_URL` — Supabase Postgres (pooled), the gateway's DB role. Keep `?sslmode=require`.
- `MIGRATION_DATABASE_URL` — migration-owner connection used only by the Render pre-deploy command;
  do not reuse it as the runtime Gateway connection.
- `GATEWAY_HMAC_SECRET` — signs admin/student tokens + registration grants. Rotate → all sessions invalidate.
  **Production requires >=32 chars and rejects placeholders — the gateway fails to start otherwise.**
- `PIN_PEPPER` — must match the pepper the admin password/PIN verifiers were created with.
  **Mandatory in production** (no silent `dev-pepper` fallback); the gateway fails to start if unset/weak.
- `NODE_ENV=production`.
- `GATEWAY_PUBLIC_URL=https://<api-domain>` — canonical Gateway origin used for expiring asset URLs.
- `STORAGE_DRIVER=supabase` — production assets use the private Supabase Storage bucket.
- `SUPABASE_URL=https://<project-ref>.supabase.co` — Gateway only.
- `SUPABASE_PUBLISHABLE_KEY` — used by the Gateway for ordinary password/TOTP Auth requests. It is
  not placed in either SPA even though Supabase classifies it as publishable.
- `SUPABASE_SECRET_KEY` — Supabase secret/service key, Gateway only; used for private Storage and
  Admin Auth identity lifecycle. Never expose it to either browser bundle.
- `SUPABASE_STORAGE_BUCKET=ccat-content` — private bucket, 5 MB limit, PNG/JPEG/WebP/GIF allowlist (SVG is rejected).
- **CORS — set BOTH if both browser clients call the gateway from their own origins:**
  - `ADMIN_WEB_ORIGIN=https://<admin-domain>` — Admin Console origin(s).
  - `WEB_APP_ORIGIN=https://<web-app-domain>` — student Web app origin(s).
  Each accepts a comma-separated list; unlisted origins are refused. Do NOT omit `WEB_APP_ORIGIN` —
  without it the student web app is CORS-blocked in production (the older runbook mentioned only
  `ADMIN_WEB_ORIGIN`; the gateway now allowlists both).
Admin on Vercel: `VITE_GATEWAY_URL=https://<api-domain>` is required at build time. The Docker image
instead uses `CCAT_GATEWAY_URL=https://<api-domain>`, injected into the same-origin `/config.js` at
container start. Query-string Gateway overrides are deliberately not supported.

Production Admin login is password + mandatory TOTP. `admin_profiles.id` must equal the corresponding
Supabase Auth user ID. Creating/resetting/disabling/deleting admins through Admin Web keeps both stores
in sync; `admin_local_credentials` is local/development-only. Existing database-only seed admins must
be provisioned one at a time before the first production login:
`pnpm --filter @ccat/gateway provision:admin-auth -- --email=<admin-email>`.
The command generates a one-time password, preserves the profile UUID, and forces both TOTP enrollment
and password replacement. Run it only in an approved operator terminal and transmit the output through
an approved secure channel.

## Migrations are applied OUT-OF-BAND, not on boot
All migrations are additive (`add column/table if not exists`, idempotent), so old and new gateway
code both run against the new schema — that's what makes the rolling deploy safe.
1. Apply pending migrations FIRST, while the current version is still serving:
   `MIGRATION_DATABASE_URL=<owner-connection> pnpm --filter @ccat/gateway migrate`
   (On a brand-new Supabase project this applies 0000→NNNN from scratch. On an already-migrated
   project the runner backfills its ledger and applies only what's genuinely new.)
2. Then roll the gateway to the new image (health-gated on `/health/ready`).
3. Then publish the new admin build/CDN invalidation.

## Hosting layout

- `apps/admin`: Vercel Vite project, Root Directory `apps/admin`, production/preview
  `VITE_GATEWAY_URL` set to the corresponding HTTPS Gateway. No Supabase or database credentials.
- `apps/web`: separate Vercel Vite project, Root Directory `apps/web`; enable “Include source files
  outside the Root Directory” because it consumes workspace packages. Set only `VITE_GATEWAY_URL`.
- `apps/gateway`: Render Docker web service from `render.yaml`, Singapore region, one always-on
  instance initially. The in-process deadline and announcement workers require a persistent process,
  so this service is intentionally not deployed as Vercel Functions.
- Supabase PostgreSQL and private Storage remain the persistent source of truth.

## Rollback
- Admin: repoint the CDN/host to the previous build (state lives in Postgres, so this is safe/instant).
- Gateway: redeploy the previous image. Additive migrations are forward-compatible — leave them in place.
- Never hard-delete audit/ledger rows; erasure is anonymize+tombstone (already implemented).

## Verify after deploy (both roles)
- `GET /health/ready` → 200.
- Super-Admin login → dashboard; author+publish a set; suspend a student; toggle a flag.
- Content-editor: can author, cannot toggle flags (403). Support: directory yes, health/flags-set no.
- `GET /v1/channel-status` reflects the flags → the website Practice honours it.
