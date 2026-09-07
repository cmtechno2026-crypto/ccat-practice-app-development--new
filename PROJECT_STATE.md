# CCAT Project State

_Last updated: 2026-09-07 — Admin membership control AUTHORED + verified in cloud checkout; RESOLVER CORRECTED so active comp grants stay usable (only canceled/expired fall back to Free; default plan is a floor, not a revoker). prod parentd@gmail.com set to status=canceled (kept for audit). NOT committed/pushed/deployed; migration 0043 NOT applied. See "Admin membership control" below. (Prior: Payments Phase 1 Stripe — committed 53c28de, deployed to preview on sandbox Stripe.)_

## Admin membership control (default plan + paid/comp flag + per-student) — AUTHORED, not committed/deployed
DATA (migration NOT applied — path: packages/contracts/migrations/0043_app_settings_grant_reason.sql):
  - ccat.app_settings — single row (id=1 check): default_tier (free/t50/t250/t500, default 'free'), default_until timestamptz null, updated_at + trigger. Seeded {free, null}.
  - ccat.entitlements.grant_reason text NOT NULL DEFAULT 'comp' CHECK (paid/sale/discount/comp/trial/other). Existing rows backfilled to 'comp'. 'paid' is WEBHOOK-ONLY (Stripe-confirmed); admins can only set non-paid reasons.
RESOLVER (apps/gateway/src/lib/entitlements.ts, resolveEntitlement → pure computeEffective()):
  - An ACTIVE grant (status='active' AND not past current_period_end) is honored ON ITS OWN, regardless of
    grant_reason. 'paid' and 'comp'/'sale'/… are equal for resolution — grant_reason is provenance/audit,
    NOT a gate. A comp grant is real complimentary access; the promo lever never revokes it.
  - The site default plan is a separate FLOOR, active while promo is on (default_tier != 'free' AND
    (default_until IS NULL OR default_until > now())). It lifts users who have no active grant.
  - effective = HIGHER of { active-grant tier | none, promo floor tier | none, free } (ties → the grant).
  - Only a canceled/expired grant (or no grant) falls back — to the promo floor if active, else free.
  Consequence: default_tier back to 'free' returns only DEFAULT RIDERS (no explicit grant) to demo; it does
  NOT downgrade active comp/paid grants. To revoke a specific guardian, cancel/expire THEIR entitlement.
  Returns source (paid/comp/sale/…/default/free) + promoActive + defaultTier. loadDefaultPlan is defensive
  (missing app_settings → no promo). computeEffective is unit-tested (see below).
  [Corrected 2026-09-07 from an earlier draft where the lever also revoked comp grants — that was wrong.]
ENDPOINTS (apps/gateway/src/routes/admin-entitlements.ts; admin auth + config.global; the new 4 are flag-gated → 404 when PAYMENTS_ENABLED off):
  - GET/PUT /v1/admin/settings/default-plan
  - POST /v1/admin/entitlements — extended with grant_reason (non-paid enum, default comp)
  - GET/POST /v1/admin/students/:id/membership (guardian resolved from student id server-side; no email in body)
  - apps/gateway/src/routes/stripe-webhook.ts — paid grant now writes grant_reason='paid' (overrides prior comp).
UI (apps/admin, behind VITE_PAYMENTS_ENABLED):
  - pages/Membership.tsx — "Default plan" panel (tier + until → PUT, warning that Free restricts non-paying users) + Reason dropdown on the email grant form.
  - pages/StudentDetail.tsx — Membership section: effective tier + source + expiry (GET students/:id/membership) + edit with tier/reason/until (POST), no email field; warns when overriding a paid row.
  - lib/api.ts — getDefaultPlan/setDefaultPlan/getStudentMembership/setStudentMembership; setEntitlement gains grant_reason.
UI refinements (2026-09-07):
  - Students directory: new optional "Tier" column (plan) — GET /v1/admin/students now returns membership_tier
    per row (effective tier via primary-guardian email + default plan). DEFENSIVE + flag-gated: computed only
    when PAYMENTS_ENABLED, wrapped in try/catch so a missing app_settings/grant_reason (0043 not yet applied)
    leaves tier null and never breaks the directory. Column + CSV shown only when VITE_PAYMENTS_ENABLED.
  - StudentDetail: Membership section moved ABOVE Guardians/Devices.
  - Membership page: Default-plan panel moved BELOW "Set a guardian's tier".
FLAG OFF = unchanged: new endpoints 404; resolver not on content paths (me returns unlock-all); admin panels/section render only when VITE_PAYMENTS_ENABLED.
BUILD/TEST: gateway typecheck clean; admin build clean (only pre-existing bulkFile.ts tsc error); gateway suite
  passes with zero regressions; payments-stripe now 15/15 (8 checkout/webhook + 7 computeEffective cases:
  comp stays usable at default=free; canceled/expired incl. paid → free; promo floor = max; expiry respected).
TEST GRANT (owner decision 2026-09-07): keep the row for audit, do NOT delete.
  - DONE on prod: parentd@gmail.com set status='canceled' (tier t50 retained for audit, source=webhook).
    Verified against the real row that BOTH resolvers return effective='free' for the canceled row (no promo).
  - AFTER 0043 is applied: the migration backfills grant_reason='comp' for all existing rows (incl. this one);
    no separate action needed. (It stays canceled ⇒ Free regardless of reason.)
  - Only canceled/expired grants fall back to Free; active comp/paid grants remain usable (see RESOLVER).
DEPLOY ORDER when ready: apply 0043 → deploy gateway (reads app_settings/grant_reason) → deploy admin. Migration 0043 must precede the gateway deploy or resolveEntitlement's grant_reason select errors.



## Update 2026-09-07 (later)
- Migration 0043 is now APPLIED to PROD (wazutprwrhnabjfggghp) + ledger row inserted. (It was applied to fix a
  /v1/catalog 500 caused by deploying the grant_reason resolver before the migration — deploy order lesson.)
- Student web My Plan: Stripe checkout REMOVED. Upgrade buttons ($50/$250/$500) now redirect OUT to
  https://conceptmastery.com/ccat/ (MEMBERSHIP_URL). The web app takes no payment. Entitlements are granted
  server-side (manual admin grant now; webhook later). Gateway /v1/checkout/session + api-client.checkoutSession
  remain in the codebase but are UNUSED by the web (dead, flag-gated) — safe to remove later.

## Architecture
Admin Web (apps/admin, Vite/React) -> Gateway -> Supabase
Student Web (apps/web, Vite/React) -> Gateway -> Supabase
Mobile (apps/mobile, Expo) -> Gateway -> Supabase
Gateway (apps/gateway, Fastify + pg) is the ONLY component with DB credentials / service_role key.
Monorepo: pnpm workspace. Packages: @ccat/gateway, @ccat/web, @ccat/admin, @ccat/api-client, @ccat/client-core, @ccat/contracts (migrations/seed), shared.

## Current deployment
Render: <gateway URL — not confirmed in repo; fill in>
Supabase: production project `ccat-practice-app-development`
  ref: wazutprwrhnabjfggghp · region: ap-northeast-1 (Tokyo)
  Gateway connects via SESSION pooler (port 5432), search_path pinned to ccat.
Web/Admin deploy: Vercel (vercel.json present in apps/web, apps/admin).

## Current branch
feature/payments. Phase 2 committed + pushed (HEAD 9e83497). Phase 1 (Stripe) authored on top, NOT yet
committed (handed over as a patch for the operator to apply + commit + push). master untouched.

## Payments Phase 1 (Stripe Checkout) — state separation
AUTHORED (code written, in the handover patch, all behind PAYMENTS_ENABLED / VITE_PAYMENTS_ENABLED, default OFF):
  - Stripe: 3 products + one-time CAD prices in the MAIN account acct_1UBsKMC2blhVy9Jd (TEST mode):
      t50=price_1UCFcCC2blhVy9JdhhjZgFKd ($50) · t250=price_1UCFcEC2blhVy9JdtihSHdlS ($250) · t500=price_1UCFcGC2blhVy9JdtyfpqUOL ($500)
  - Gateway: POST /v1/checkout/session (student auth, server-owned tier->price map, eligibility: no downgrade/
    same/non-sellable, mode=payment); POST /v1/webhooks/stripe (raw-body signature verify, idempotent via
    ccat.payment_events, grants ONLY on checkout.session.completed+payment_status=paid, price<->tier cross-check);
    lib/stripe.ts; config env vars; ALLOWED_TIERS opened to free/t50/t250/t500; migration 0042_payment_events.sql.
  - Web: My Plan screen + /plan route + sidebar "My Plan" (flag-gated) + Stripe redirect + success poll of
    /v1/entitlements/me; lock-modal CTA repointed off conceptmastery.com to in-app /plan.
  - Admin: manual grant opened to all four tiers.
  - Billing model = ONE-TIME purchase, currency CAD (owner decisions 2026-09-05). Grant sets status=active, no expiry.
RUNTIME-VERIFIED (in a throwaway cloud checkout + local Postgres 16, migrations 0000-0042 applied):
  - typecheck: gateway/web/api-client clean; admin only the pre-existing bulkFile.ts error (unrelated).
  - build: @ccat/web + @ccat/admin succeed.
  - tests: new test/payments-stripe.test.ts 8/8 pass (eligibility no-downgrade/same/invalid; webhook bad-sig 400;
    paid grant; idempotent redelivery; unpaid = no grant; price/tier mismatch 400). Full suite 175/184 pass;
    baseline (my changes stashed) 167/176 — i.e. +8 new passing, the same 9 pre-existing failures, ZERO regressions.
  - Stripe prices confirmed one_time + cad via API read.
COMMITTED: NO.   PUSHED: NO.   DEPLOYED (Render/Vercel): NO.   0042 APPLIED to any DB: NO.   Stripe webhook endpoint registered: NO.

## Completed
- Gateway deployed; Supabase session-pooler wiring; login; grade isolation; block-format import; exam scaffolding.
- Student web: S2 sidebar, Home, Progress, figures (FIXED_ISSUES.md: theme.css / api-client types.ts must not roll back).
- Migrations through 0039 committed. Practice per-question feedback; multi in-progress sessions (0037); multi active devices (0038).
- Payments Phase 2 AUTHORED on feature/payments (behind PAYMENTS_ENABLED / VITE_PAYMENTS_ENABLED, default OFF):
  0040 entitlements migration; gateway resolver + capability map + demo-set derivation + catalog locked flags
  + /v1/sessions/start & /:id 403 upgrade_required + /v1/entitlements/me + admin upsert; web lock UI + Upgrade panel;
  admin manual grant. See PAYMENTS_PHASE2.md. Combine detected via subcategory KEY (no dependency on out-of-band column).
- Admin Membership page: entering a guardian email now auto-looks-up and lists the linked student(s) — real name,
  @username, grade, relationship/primary, status pill — so the operator grants the right family. Gateway GET
  /v1/admin/entitlements returns { item, students, allowed_tiers }; admin api.ts + Membership.tsx render it.
- 0040 entitlements migration APPLIED TO PROD (Supabase MCP, user-approved); ledger rows 0040+0041 inserted.
- Preview deployed: Render gateway (NODE_ENV=staging so prod dev-pepper check is bypassed) + Vercel web/admin
  with VITE_PAYMENTS_ENABLED=true. Membership icon/route confirmed showing; t50 grant saved for a test guardian.
- 0041 migration: backfills the prod-only ccat.subcategories.max_questions_per_set column (add-if-not-exists;
  no-op on prod) so local/CI matches prod. This was a pre-existing gap unrelated to payments.
- VERIFIED: @ccat/gateway typecheck clean; @ccat/web build clean; @ccat/admin build clean.
- VERIFIED: gateway vitest suite — feature/payments = 167/176 pass (9 fail); master baseline = 140/176 (36 fail).
  Phase 2 fixed 27 pre-existing failures and introduced ZERO regressions.
- VERIFIED on a preview DB (throwaway Postgres 16, migrations 0000-0041 applied clean): 36/36 payment-logic
  checks pass — guardian resolution, demo-set derivation (first set of first subcat per battery), free=demo-only,
  t50=all-practice (exam/combine still locked), t250/t500 phase-clamped to t50, expired/canceled -> free, and the
  admin upsert's case-insensitive lower(guardian_email) keying. HTTP-layer 403 wire test not yet run (optional).

## Current blockers / known pre-existing test failures (9 on branch, all also on master)
- 0037/0038 test drift (tests assert removed behavior): e2e "blocks a second session" (expects 409), e2e/phase-c/
  learning-core non-enrolled-device login (expect 403). Code intentionally allows multi-session / multi-device now.
- bulk-import split test expects [20,1]; correct per-subcategory cap is now 15 (0039 convention) -> [15,6]. Stale expectation.
- Untouched subsystems (pre-existing, not payments): admin reset-password (temp_password), gam-avatar-art RBAC,
  phase-d unpublish-immutable (expects 409), phase-b exam-battery GET. Need investigation as separate maintenance.
- device_bash unavailable this session — builds/tests were run by the user on their machine.

## Next tasks
1. User: `git commit` + push feature/payments (Claude does not commit/push/merge). The Membership linked-students
   change touches BOTH gateway (new students query) and admin UI — after push, REDEPLOY the preview gateway
   (Render) AND the admin (Vercel). A plain browser refresh is not enough; both need a rebuild.
2. Verify on preview after redeploy: enter a guardian email on /config/membership → linked student(s) appear.
3. Finish Phase 3 preview verification (web): free→t50 unlock, Exam/Combine stay locked, 403 hard-gate on /sessions.
4. Optional (user's call): update the ~5 stale drift tests to current 0037/0038 behavior; investigate the 4 untouched-subsystem failures.
5. FLAGGED SECURITY GAP: prod gateway runs dev-pepper (NODE_ENV not 'production'). Remediation write-up offered, not done.
6. Later: Phase 1 (Stripe), Phase 4 (webhook), Phase 5 (flag ON in prod).

## Important constraints
- Do not modify mobile production (apps/mobile).
- Do not change DB schema unless requested (0040 new; 0041 backfills a prod-only column — both delivered as .sql, NOT applied here).
- Do not refactor unrelated code. Shared files touched minimally; theme.css and api-client types.ts append-only (FIXED_ISSUES.md).
- PAYMENTS_ENABLED / VITE_PAYMENTS_ENABLED default FALSE; flag OFF is a true no-op in gateway, web, admin. Never commit flag true.
- No Stripe/checkout/webhook this phase. No secrets in committed .env. Server-side enforcement; web locks cosmetic; never trust client tier.
- Run builds/tests before declaring complete. User reviews & pushes; no commit/push/merge to master.
