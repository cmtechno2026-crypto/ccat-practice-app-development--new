# @ccat/web — CCAT Practice student website

A **new client** of the existing `apps/gateway` — a co-equal peer of `apps/mobile`. Vite + React + TypeScript SPA. It reuses `@ccat/api-client` and `@ccat/client-core`, talks **only** to the gateway, and holds **no** database access, business logic, or secrets.

## Run locally (one stack)

Prereqs: Node 20+, pnpm 10, a Postgres for the gateway (Docker `docker compose up -d db`, or any Postgres).

```bash
# from the repo root
pnpm install
pnpm migrate && pnpm seed && pnpm seed:content   # schema + demo data
pnpm gateway                                      # gateway on :8080  (leave running)

# in another terminal
cp apps/web/.env.example apps/web/.env.local       # sets VITE_GATEWAY_URL=http://localhost:8080
pnpm web                                            # website on :5173
```

Open http://localhost:5173. In `NODE_ENV=local` the gateway returns the OTP as `_dev_code`, so you can complete guardian verification without a real email/SMS.

## Build (static, CDN-friendly)

```bash
pnpm web:build        # -> apps/web/dist  (static assets)
pnpm web:preview      # serve the build on :4173
```

`dist/` is a static bundle — deploy it to any static host/CDN (S3+CloudFront, Netlify, Vercel static, nginx). Set `VITE_GATEWAY_URL` at build time to the deployed gateway URL. The client is stateless; scale it horizontally behind a CDN. **SPA routing:** configure the host to fall back to `index.html` for unknown paths (client-side routes like `/session/:id`).

## Configuration

| Var | Purpose |
|-----|---------|
| `VITE_GATEWAY_URL` | Base URL of the gateway. The **only** required config. |

No Supabase key, no `service_role`, no secrets ship in the client — by design (Supabase sits behind the gateway).

## Architecture (non-negotiables honored)

- **One backend, many clients.** This is a client of `apps/gateway`; no new server, DB, or auth.
- **All logic server-side.** Scoring, server-seeded shuffle, XP/coins/streak, consent, readiness, exactly-once submit — all in the gateway. The client renders results.
- **Shared code, not duplicated.** Non-UI logic (session/answer glue, formatting, app-config reader) lives in `@ccat/client-core`, importable by `apps/mobile` too. Only the presentation layer differs per client.
- **Identity model = mobile's.** Gateway-issued token (child username + 4-digit PIN + single enrolled device + guardian OTP/consent). `@ccat/api-client`'s `TokenStore` is memory+localStorage here, SecureStore on mobile.
- **Child-safety preserved.** Guardian OTP + PIPEDA consent + computed age on registration; adult arithmetic gate before any book retailer handoff (allowlisted HTTPS only).
