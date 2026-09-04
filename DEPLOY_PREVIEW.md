# CCAT Payments — feature/payments preview deploy (Render gateway + Vercel web/admin)

Goal: run the `feature/payments` branch as an isolated preview with `PAYMENTS_ENABLED` / `VITE_PAYMENTS_ENABLED = true`,
so you can exercise the $50 gating without touching prod. Prod stays free because the prod gateway/web/admin keep the
flags off. Matches deploy/UPGRADE_RUNBOOK.md (Gateway = Docker, secrets gateway-only, migrations out-of-band).

## Prerequisites / decisions
1. Branch is pushed to GitHub: `feature/payments`. (Render/Vercel deploy from the remote.)
2. DB the PREVIEW gateway points at — pick one:
   - **A. Shared prod Supabase (simplest).** Apply 0040+0041 there (both additive / no-op on prod). The preview
     gateway MUST use the SAME `GATEWAY_HMAC_SECRET` and `PIN_PEPPER` as prod, or existing logins fail. Manual grants
     you make write real rows to `ccat.entitlements` — harmless while the prod flag is off (prod never resolves them).
   - **B. Separate Supabase (fully isolated).** New project or branch DB; apply all migrations; seed content + a student
     + a guardian (or run `pnpm seed`). No secret-matching constraint. More setup.
   Recommendation: A for a quick preview; B if you want zero prod footprint.

## Step 1 — push the branch
```
git push -u origin feature/payments
```

## Step 2 — apply migrations to the chosen DB (out-of-band, BEFORE the gateway boots)
```
DATABASE_URL="<preview-or-prod Supabase pooled URL, ?sslmode=require>" pnpm --filter @ccat/gateway migrate
```
This applies only what's new (0040 entitlements, 0041 max_questions) on an already-migrated prod, or 0000→0041 on a fresh DB.

## Step 3 — Render: new Web Service for the preview gateway
Create a NEW service (do not touch the prod service). Render dashboard → New → Web Service → your repo:
- Branch: `feature/payments`
- Runtime: Docker · Dockerfile path: `apps/gateway/Dockerfile` · Docker context: `.` (repo root)
- Health check path: `/health/ready`
- Env vars:
  - `NODE_ENV=production`
  - `PAYMENTS_ENABLED=true`   ← the whole point of the preview
  - `PORT=8080`
  - `DATABASE_URL=<same DB as Step 2>`
  - `GATEWAY_HMAC_SECRET=<= prod value if sharing prod DB; else any >=32-char string>`
  - `PIN_PEPPER=<= prod value if sharing prod DB; else your seed pepper>`
  - `ADMIN_WEB_ORIGIN=<admin preview URL from Step 4>`
  - `WEB_APP_ORIGIN=<web preview URL from Step 4>`   ← required or the web app is CORS-blocked

Reference render.yaml (manual creation is safer than a root Blueprint, which could affect prod):
```yaml
services:
  - type: web
    name: ccat-gateway-payments-preview
    runtime: docker
    dockerfilePath: apps/gateway/Dockerfile
    dockerContext: .
    branch: feature/payments
    healthCheckPath: /health/ready
    envVars:
      - { key: NODE_ENV, value: production }
      - { key: PAYMENTS_ENABLED, value: "true" }
      - { key: PORT, value: "8080" }
      - { key: DATABASE_URL, sync: false }
      - { key: GATEWAY_HMAC_SECRET, sync: false }
      - { key: PIN_PEPPER, sync: false }
      - { key: ADMIN_WEB_ORIGIN, sync: false }
      - { key: WEB_APP_ORIGIN, sync: false }
```

## Step 4 — Vercel: preview deploys for web + admin
A branch push auto-creates Vercel Preview deployments for each project. Set env for the **Preview** scope (or the
`feature/payments` branch specifically), then redeploy so the build picks them up (VITE_ vars are build-time):
- apps/web:  `VITE_PAYMENTS_ENABLED=true`, `VITE_GATEWAY_URL=<preview gateway URL from Step 3>`
- apps/admin: `VITE_PAYMENTS_ENABLED=true`, `VITE_GATEWAY_URL=<preview gateway URL>`
  (admin also honors runtime `?gateway=` and, in the container build, `CCAT_GATEWAY_URL` via /config.js.)

Ordering note (chicken-and-egg): the gateway's CORS needs the Vercel URLs, and Vercel needs the gateway URL. Easiest:
deploy Vercel first to get the stable preview URLs → put them in the gateway's ADMIN_WEB_ORIGIN/WEB_APP_ORIGIN →
then set VITE_GATEWAY_URL on Vercel and redeploy. Use the branch's stable preview alias, not a per-commit URL.

## Step 5 — verify the preview
1. `GET https://<preview-gateway>/health/ready` → 200.
2. `GET https://<preview-gateway>/v1/entitlements/me` (with a student token) → `paymentsEnabled:true`, tier `free`, demo caps.
3. Admin preview → Membership → set a guardian to `t50` → that guardian's child sees all practice unlock; Exam/Combine still locked.
4. Web preview as a free student → only the per-battery demo set is playable; others show the lock + Upgrade panel.
5. Direct-call check: `POST /v1/sessions/start` on a locked set → 403 `upgrade_required`.

## Teardown
Delete the Render preview service and the Vercel preview when done. If you shared the prod DB, the only residue is the
`ccat.entitlements` rows you created (inert while prod's flag is off) — delete them or leave them.
