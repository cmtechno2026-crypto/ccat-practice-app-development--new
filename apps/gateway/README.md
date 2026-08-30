# CCAT Gateway (Phase 1)

The secured Gateway — the **only** application-data boundary exposed to the student app
(Blueprint §33). Fastify + TypeScript, PostgreSQL. No native crypto deps.

## Implemented in this slice (verified, 8/8 tests green)

**Student vertical, end-to-end:**
- `GET /health/live`, `GET /health/ready` (§27.3)
- `GET /v1/grades` — data-driven grade catalog (§29)
- Registration (§4): `POST /v1/registration/contact/start` → OTP challenge (dev-mode surfaces
  the code); `.../contact/verify` → verified signed grant; `.../consent`; `.../student` — one
  transaction creating guardian contact, student, PIN credential, guardian link, **immutable
  consent**, sole active device, analytics identity. Grade/age validated server-side (§4.3);
  age derived, never stored (§4.2).
- `POST /v1/auth/login` — username + 4-digit PIN, **single-device enforcement** (§5); failed
  attempts throttled/locked; issues HMAC access token + refresh. `POST /v1/auth/logout`.
- `GET /v1/profile` — computed `age_years` (§4.2).
- `POST /v1/sessions/start` — one active session per student (§9.1); validates published set +
  allowed mode/timer. `GET /v1/sessions/active`.
- `POST /v1/sessions/{id}/submit` — **exactly-once** (§13): DB-backed idempotency store +
  `session_submissions` unique constraint; replay returns the original result; no IDOR leak.
- `GET /v1/sessions/{id}/result` — recovery after a lost response (§13.3).

**Cross-cutting:** structured error envelope (§32.1); request IDs; request-time device/session/
status re-validation on every authenticated call (§5.4); rate limiting (fail-closed default,
§36.4); security headers; scrypt PIN/OTP hashing with pepper (§4.4, §36.1); HMAC session tokens
re-validated against the DB (not trusted alone).

## What proves the architecture (test/e2e.test.ts)
- registration → login → profile (computed age)
- duplicate username → 409 `USERNAME_TAKEN`
- login from non-enrolled device → 403 `DEVICE_NOT_ENROLLED`
- wrong PIN → 401
- session start, second start → 409 `ACTIVE_SESSION_EXISTS`, submit, **idempotent replay
  returns identical result**, new session allowed after terminal, result recovery
- unauthenticated session start → 401

## Run
```bash
pnpm install
export ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres   # maintenance db
export TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/ccat_gw_test # recreated each run
pnpm --filter @ccat/gateway test     # 8/8

# or run the server:
export DATABASE_URL=postgresql://postgres@127.0.0.1:5432/ccat
export GATEWAY_HMAC_SECRET=change-me
pnpm --filter @ccat/gateway migrate
pnpm --filter @ccat/gateway dev
```

## Learning core (added; 14/14 tests green)
- `GET /v1/sessions/{id}` — session + questions (exam-safe: correct refs never serialized).
- `PATCH /v1/sessions/{id}/answers` — versioned autosave (§12): monotonic `answer_version`,
  **stale writes rejected** (`STALE_ANSWER`), locked after submit, deadline-aware guard.
- `POST /v1/sessions/{id}/abandon` — ABANDONED (Exam requires `confirm=true`, §10.2).
- **Real scoring** in submit: server-authoritative correctness vs `correct_option_ids`,
  difficulty-based XP (easy 10 / medium 15 / hard 20, §19.1) written to the append-only ledger
  and reflected in the cached balance; coverage credit to `set_completions` (§15); a Readiness
  snapshot recomputed each finalization (§16, insufficient-data below threshold, never 0%).
- **Timed auto-finalization** (§14): deadline-aware request guard finalizes an overdue session
  on the next touch, AND a durable `finalizeOverdueSessions` worker (15s interval in the server)
  auto-submits overdue sessions independently — both idempotent via the exactly-once constraint.
- `POST /v1/devices/replacement/start` + `/verify` (§5.2): guardian OTP → revoke old device +
  token family + app sessions → enrol new sole device → audit event → fresh tokens.
- `POST /v1/recovery/pin/start` + `/complete` (§4.4): guardian OTP → new PIN → revoke existing
  app sessions (fresh login required). Does not authorize a new device.
- `GET /v1/rewards/summary`, `GET /v1/readiness`, `GET /v1/progress`.
- `GET /v1/catalog` — published sets for the student's grade.
- **Bookmarks** (§32.4): `GET/PUT/DELETE /v1/bookmarks` — add/list (with prompt preview)/remove.
- **Achievements** (§19.4, §32.5): `GET /v1/achievements` (earned vs locked + rewards); evaluated
  and granted **inside the submit transaction** with atomic reward ledger writes — idempotent
  (no double-grant on resubmit). Launch criteria: first-completion, perfect-set, XP-total.
- **Avatars & themes** (§20, §32.5): `GET /v1/avatars` + `POST /v1/avatars/equip`,
  `GET /v1/themes` + `POST /v1/themes/equip`. Ownership server-authoritative (explicit grant OR
  required-XP for avatars; versioned unlock rules for themes); equip auto-grants on XP unlock
  and sets the active avatar/theme.
- **Server-side shuffle** (§9.2): `GET /v1/sessions/:id` now returns questions and options in a
  deterministic per-seed order (stable across fetches; option ids stay stable so correctness is
  unaffected).
- **Announcements & Book Store** (§21, §26): `GET /v1/announcements`; `GET /v1/books`,
  `POST /v1/books/:id/adult-challenge` (arithmetic adult gate, no OTP), `POST /v1/books/:id/retailer-handoff`
  (validates the gate, returns an allowlisted HTTPS destination).
- **Admin** (§22–§25): `POST /v1/admin/auth/login` (local/dev credentials; staging/production use
  Supabase Auth password + mandatory TOTP/AAL2), `GET /v1/admin/me`, `GET /v1/admin/students` (computed Age + guardian
  PII), `POST /v1/admin/students/:id/status` (suspend/ban with permission checks, reason, audit,
  session revocation, `If-Match`/ETag optimistic concurrency), `GET /v1/admin/audit` (self /
  global scope). RBAC loads DB-backed permissions per request; `super_admin` implicit-all.
- Migrations 0007 (idempotency store) and 0008 (admin dev credentials + `students.version`).
- CORS enabled for the Admin Web (permissive in dev; `ADMIN_WEB_ORIGIN`-pinned in production).

Tests added (`test/learning-core.test.ts`): autosave + stale rejection + correct scoring/XP,
incorrect → 0 XP, timed auto-submit via deadline guard and via the worker, device replacement
old/new token + login behavior, PIN recovery revokes sessions + old/new PIN.

## Notes on prod
- In production the pool authenticates as the least-privilege `ccat_gateway` role, and Admin
  identity uses Supabase Auth + MFA (§22). Local/dev connects as a superuser for convenience,
  so RLS (which is defense-in-depth here) is bypassed locally — the RLS/negative-access
  behavior is covered by `packages/contracts/tests/negative-access-tests.sql` (18/18).
- OTP codes are surfaced in dev logs only; never in staging/production (§36.3).
