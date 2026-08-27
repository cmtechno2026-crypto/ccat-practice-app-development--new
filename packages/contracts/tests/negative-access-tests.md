# CCAT Negative-Access & Invariant Test Suite

**Authority:** Blueprint v10.0 — §38.2 (CI gates #5 permission/direct-access negative tests,
#6 session-state/idempotency), §39.3 (security). **Status:** Phase 0 normative artifact.

Two layers. The **database layer** is runnable now (`negative-access-tests.sql`); the
**application layer** is specified here and implemented in the service test suite in Phase 1.

## 1. Database-layer suite (runnable) — `negative-access-tests.sql`

Each test attempts a forbidden operation and asserts the DB rejects it (a success is a test
failure). Verified passing (18/18) on PostgreSQL 17 with migrations 0000–0006:

| Test | Asserts |
|------|---------|
| one-active-device | second active device rejected (§5.1) |
| one-in-progress-session | second IN_PROGRESS session rejected (§9.1) |
| exactly-once-submission | second submission per session rejected (§13.1) |
| idempotent-xp-source | duplicate reward source rejected (§13.3) |
| xp-ledger-no-update / no-delete | ledger append-only (§19, §36.3) |
| audit-no-update | audit append-only (§25) |
| submission-no-delete | submission ledger append-only |
| session-events-no-update | events append-only |
| published-set-immutable-count / no-mode-flip | published content immutable (§8.1, §18.2) |
| session-core-immutable-seed | session seeds/mode/timer frozen after start (§9.2) |
| terminal-no-return-to-in-progress | terminal session cannot revert (§9.3) |
| set-size-hard-bounds | 5–20 question hard bound (§8.2) |
| birth-month-domain | birth_month 1–12 (§4.1) |
| book-link-https-only | retailer links HTTPS-only (§21) |
| anon-cannot-select-students | PostgREST `anon` denied (§41) |
| authenticated-cannot-select-sessions | PostgREST `authenticated` denied (§41) |

Run: `psql -d ccat -v ON_ERROR_STOP=1 -f negative-access-tests.sql` →
`ALL NEGATIVE-ACCESS TESTS PASSED`.

## 2. Application-layer negative tests (Phase 1 service suite — specified)

These require the Gateway and cannot be expressed in SQL. Each MUST return the stated status
without performing the action.

### RBAC / authorization (§22, §23)
- Admin without `student.suspend` → `POST /admin/students/{id}/status` ⇒ 403.
- Admin without `content.publish` → `POST /admin/content/publish` ⇒ 403.
- Normal admin → `POST /admin/push/campaigns/{id}/approval` (SA-only) ⇒ 403.
- Normal admin → `GET /admin/audit?scope=global` ⇒ 403 (own-scope only, §25).
- Normal admin → grade/global-config/flags/DR endpoints ⇒ 403.
- Disabled admin (any prior valid token) → any admin endpoint ⇒ 401/403 on next request (§28.1).
- Attempt to disable the last active super_admin ⇒ 409/422 (§28.2).
- Stale `If-Match` on a mutable admin resource ⇒ 409 with conflict comparison (§22.4).

### Student identity / device (§5)
- Request from a non-enrolled device ⇒ 403 `DEVICE_NOT_ENROLLED` (§5.4).
- Old device token after replacement ⇒ 401 (token family revoked, §5.2).
- Student-id supplied in body ≠ session identity ⇒ ignored/rejected (§33).
- IDOR: student A requests student B's session/result ⇒ 404/403.

### Session / idempotency / timing (§12–§14)
- Autosave with stale `answer_version` ⇒ 409 `STALE_ANSWER`.
- Submit with stale `expected_session_version` ⇒ 409 `SESSION_VERSION_CONFLICT`.
- Duplicate `submission_id` ⇒ original result, no reward reprocess.
- Manual submit after deadline ⇒ returns the auto-submitted result (§14.3).
- Second `/sessions/start` while active ⇒ 409 `ACTIVE_SESSION_EXISTS`.

### Content / AI (§18)
- AI-queue direct "Approve & Publish" ⇒ not available / rejected.
- Bulk "publish all approved AI items" ⇒ not available / rejected.
- Set expert approver == AI question reviewer ⇒ rejected (§18.1).
- Publish content failing accessibility gate ⇒ rejected (§17.4).

### Rate limiting / abuse (§36.4) — fail closed
- PIN brute force, OTP send/verify abuse, device-replacement spam, username-check flood ⇒ 429
  with `Retry-After`; limiter error ⇒ deny.

### Privacy (§24, §35)
- Push payload / analytics event containing guardian PII ⇒ rejected in construction/validation.
- Third-party analytics receiving non-minimized fields ⇒ blocked.

## 3. CI wiring (§38.2)
The database suite runs in CI against an ephemeral PG with migrations applied (gate #5/#6).
The application suite runs against a test Gateway. Both are required-green before deploy.
