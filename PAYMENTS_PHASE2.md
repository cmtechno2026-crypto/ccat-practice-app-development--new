# CCAT Payments — Phase 2 (entitlements + $50 gating)

Behind a single feature flag, default **OFF**. `main`/`master` behavior is unchanged until the flag is
flipped on the payments preview. No Stripe/checkout/webhook code in this phase.

## Feature flag
- Gateway: `PAYMENTS_ENABLED` env (`"true"` enables; anything else = off). `apps/gateway/src/config.ts` →
  `cfg.paymentsEnabled`.
- Web: `VITE_PAYMENTS_ENABLED` (`apps/web/src/lib/entitlements.ts` → `PAYMENTS_ENABLED`).
- Admin: `VITE_PAYMENTS_ENABLED` (`apps/admin/src/lib/payments.ts` → `PAYMENTS_ENABLED`).
- Added to `.env.example`, `apps/gateway/.env.example`, `apps/web/.env.example`, `apps/admin/.env.example`
  (all `false`, with a one-line comment). Never committed as `true`.

## Tier → capability map (server = source of truth)
| tier | practice | combine | exam | weekly | reachable this phase |
|------|----------|---------|------|--------|----------------------|
| free (demo) | demo sets only | ✕ | ✕ | ✕ | ✅ |
| t50 ($50) | all (not combine) | ✕ | ✕ | ✕ | ✅ |
| t250 ($250) | all + combine | ✓ | ✓ | ✕ | ✗ (no grant path) |
| t500 ($500) | all + combine | ✓ | ✓ | ✓ | ✗ (no grant path) |

`ALLOWED_TIERS = ['free','t50']` clamps any resolved tier, so a stray t250/t500 row cannot unlock
Exam/Combine before those phases. Enabling $250/$500 later is a one-line change to `ALLOWED_TIERS`.

Demo set = the first set of the first subcategory of each battery, derived from the DB (never hard-coded).
Combine = the "Battery Combine" subcategory (`*_battery_combine` key / 45-question cap).
**Weekly** has no endpoint or UI in `apps/web` today — capability is encoded (`weekly:false`) but there is
nothing to lock; it is flagged, not built.

## Files

### Migration (NOT applied — run by the operator)
- `packages/contracts/migrations/0040_entitlements.sql` — `ccat.entitlements` + unique index on
  `lower(guardian_email)`.

### Gateway
- NEW `src/lib/entitlements.ts` — ALLOWED_TIERS clamp, capability map, guardian-email resolver
  (session student → primary `guardian_contacts.email`), effective-tier resolver, demo-set derivation,
  combine detection, practice lock helper.
- NEW `src/routes/entitlements.ts` — `GET /v1/entitlements/me`.
- NEW `src/routes/admin-entitlements.ts` — `GET/POST /v1/admin/entitlements` (upsert, source='manual';
  Super-Admin via `requirePermission('config.global')`; audited).
- EDIT `src/config.ts` — `paymentsEnabled`.
- EDIT `src/app.ts` — register the two new route groups; pass `cfg` to catalog routes.
- EDIT `src/routes/catalog.ts` — `/v1/catalog` marks each practice set `locked`/`is_combine` (flag on only).
- EDIT `src/routes/sessions.ts` — `/v1/sessions/start` AND `/v1/sessions/:id` hard-gate: 403
  `upgrade_required` `{requiredTier, feature}` for a locked practice set, any exam, any combine (flag on only).

### api-client (`packages/api-client`)
- EDIT `src/types.ts` — `CatalogItem.locked?`, `CatalogItem.is_combine?`, `EntitlementTier`,
  `EntitlementCapabilities`, `EntitlementsMe` (append-only).
- EDIT `src/index.ts` — `entitlementsMe()`.

### Web (`apps/web`)
- NEW `src/lib/entitlements.ts` — flag, `MEMBERSHIP_URL` placeholder, `capsOf()`.
- NEW `src/components/UpgradePanel.tsx` — child-safe Upgrade panel (links OUT; no payment form) + LockBadge.
- EDIT `src/lib/store.tsx` — fetch `/v1/entitlements/me` once (flag on); expose `entitlements`.
- EDIT `src/screens/PracticeScreen.tsx` — practice locks, start-screen lock, exam-list lock, combine
  category hint, 403 `upgrade_required` → Upgrade panel.
- EDIT `src/screens/HomeScreen.tsx` — exam entry tile shows a lock when `!caps.exam`.
- EDIT `src/vite-env.d.ts` — flag type.

### Admin (`apps/admin`)
- NEW `src/lib/payments.ts` — flag.
- NEW `src/pages/Membership.tsx` — single manual-grant control (email → tier free/t50 → status → expiry).
- EDIT `src/lib/api.ts` — `getEntitlement()`, `setEntitlement()`.
- EDIT `src/App.tsx` — `/config/membership` route (flag-gated).
- EDIT `src/components/Layout.tsx` — Membership rail item (flag-gated + Super-Admin perm).

## FLAG-OFF PROOF (how off = identical to today)
By construction, every new code path is guarded:
- Gateway: `catalog.ts` and `sessions.ts` run the entitlement logic only inside `if (cfg.paymentsEnabled)`.
  Off → `/v1/catalog` returns rows with **no** `locked`/`is_combine` field (byte-identical shape), and
  `/v1/sessions/start` + `/v1/sessions/:id` never call the gate. `GET /v1/entitlements/me` returns
  `paymentsEnabled:false` with all-unlocked capabilities.
- Web: `capsOf()` returns everything-unlocked when the flag is off, `store.tsx` never calls
  `/v1/entitlements/me`, `isLocked()` is always false, no set renders a lock, no Upgrade panel opens.
- Admin: no Membership route, no rail item.

Verification steps to run with flags unset (default):
1. `GET /v1/catalog` → confirm no `locked` key on any row (e.g. `curl … | jq '.[0]|has("locked")'` → false).
2. Start any practice set and any exam set → 201 (no 403).
3. `GET /v1/entitlements/me` → `{ paymentsEnabled:false, capabilities:{practice:'all',combine:true,exam:true,weekly:true}, … }`.
4. Web: practice/exam/home render with no locks; admin has no "Membership" nav item.
5. `git diff master --stat` shows only additions + guarded edits; no existing test file changed.

## PHASE 3 TEST PLAN (write, do not run against prod)
Run on a preview DB with `0040_entitlements.sql` applied and all three flags set to `true`.

**A. Flag OFF baseline (regression):** with flags unset, run steps 1–4 above → everything unlocked,
app identical to today.

**B. free (demo) tier:** admin Membership → set guardian to `free` (or leave no row).
- `/v1/catalog`: exactly one set per battery has `locked:false`; every other practice set `locked:true`;
  every combine set `locked:true`.
- Web practice: only the demo set per battery is playable; others show 🔒 and open the Upgrade panel.
- Start a locked set directly (bypass UI): `POST /v1/sessions/start` → **403 upgrade_required**,
  `feature:'practice'`, `requiredTier:'t50'`; no session row created; questions never returned.
- Start the demo set → 201, plays normally.
- Exam + combine → 403 (`feature:'exam'` / `'combine'`).

**C. t50 ($50) tier:** admin Membership → set guardian to `t50`.
- `/v1/catalog`: all non-combine practice sets `locked:false`; combine sets `locked:true`.
- Web: all practice playable; combine shows 🔒 → Upgrade; exam entry locked.
- `POST /v1/sessions/start` for a normal practice set → 201; for a combine set → 403
  (`feature:'combine'`, `requiredTier:'t250'`); for exam → 403 (`feature:'exam'`).
- Toggle guardian free ↔ t50 and re-fetch `/v1/entitlements/me` → capabilities flip; **Exam & Combine
  stay locked in BOTH** states.

**D. Server gate cannot be bypassed:** with a locked set, call `POST /v1/sessions/start` and
`GET /v1/sessions/:id` directly with a valid token (no UI) → 403 both; a locked set never returns
questions. Confirm the guardian is resolved from the session (a client-sent tier/email is ignored).

**E. Null-safety:** guardian with no entitlement row / `status!='active'` / `current_period_end` in the
past → treated as `free` (demo-only). An entitlement row manually set to `t250` → clamped to `t50`
(Exam/Combine still 403).

**F. Expiry:** set t50 with `current_period_end` in the past → effective free; in the future → effective t50.

## Build check (run after checkout; do NOT commit/push)
```
npx --yes pnpm@10 install --frozen-lockfile
npx --yes pnpm@10 --filter @ccat/gateway build   # or typecheck
npx --yes pnpm@10 --filter @ccat/web build
npx --yes pnpm@10 --filter @ccat/admin build
```
All pass → stop for review. No commit, no push, no merge to master.
