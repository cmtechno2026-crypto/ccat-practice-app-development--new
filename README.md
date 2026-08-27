# CCAT Platform — Monorepo (Phase 1)

Authority: CCAT Final Definitive Architecture Blueprint v10.0. Contracts: `../Production/contracts`.

## Layout
```
apps/gateway        Fastify + TypeScript secured Gateway (sole student-data boundary, §33)
apps/mobile         Expo / React Native child-facing app (typechecks; run on device/simulator)
packages/api-client Framework-agnostic typed Gateway client (used by app + future admin web)
packages/contracts  DB migrations (0000–0007), OpenAPI, DB negative-access tests
packages/shared     Shared types/constants
```

## Verification status
- Gateway: 16/16 integration tests green on local Postgres 17 (identity, learning core,
  api-client-over-HTTP).
- api-client + mobile: TypeScript strict typecheck passes. Native UI render requires a
  device/simulator (not available in cloud CI); the data layer is proven via the HTTP
  integration test.

## Stack
- Node 22 + TypeScript, Fastify. PostgreSQL (Supabase in prod; local for dev/test).
- No native crypto deps: PIN/OTP hashing via Node `crypto.scrypt`; session tokens via HMAC.

## Run (local Postgres)
```bash
pnpm install
# point at your Postgres:
export DATABASE_URL=postgres://postgres@localhost:5432/ccat
export GATEWAY_HMAC_SECRET=dev-secret-change-me
pnpm migrate          # applies 0000–0007
pnpm gateway:dev      # starts the Gateway on :8080
pnpm gateway:test     # integration tests against a throwaway DB
```

## Phase 1 scope implemented
Student vertical proving the core invariants end-to-end: registration (guardian OTP → consent →
account, single transaction), login with single-device enforcement, computed age, one active
session, exactly-once submission with idempotency. See `apps/gateway/README.md`.

Not yet: Admin auth/RBAC endpoints, content authoring, rewards read APIs, push, admin web,
Expo app. Those are the remainder of Phase 1–4.
