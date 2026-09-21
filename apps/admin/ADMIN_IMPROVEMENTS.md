# CCAT Web Admin — Extending & Improving

> Companion to **ADMIN_OVERVIEW.md**. This file is the practical guide for **making changes**, **adding
> features**, and a running **backlog** of improvement options for the Admin Web. Keep it current: when a
> backlog item ships, move it to "Done / shipped" with a date.

_Last updated: 2026-09-21._

---

## 1. How to make a change (dev workflow)

1. **Locate it** with ADMIN_OVERVIEW §4/§7 — which page, which `admin-*.ts` route, which permission.
2. **Change the layer that owns it:**
   - UI-only tweak (labels, layout, a control) → the `pages/*.tsx` or `components/*.tsx` file, and any
     new call in `lib/api.ts`.
   - New/changed behavior or validation → the gateway `routes/admin-*.ts` (Zod schema + SQL), then wire
     the client in `lib/api.ts`.
   - Data shape / limits → Supabase (column, constraint, or migration), then reflect it in the gateway
     and UI.
3. **Gate it**: add/choose a permission key; `requirePermission` on the gateway, `can()` in the UI.
4. **Verify**: type-check/transpile the changed files; sanity-check the SQL on a couple of rows.
5. **Deploy** per ADMIN_OVERVIEW §2 (admin/web → Vercel, gateway → Render, DB already live on Supabase).

### Add a new API endpoint
1. Pick the right `apps/gateway/src/routes/admin-*.ts` (or add one and register it in `app.ts`).
2. Define a **Zod** schema for the body/query; validate first.
3. `requirePermission(req, '<key>')` before any work.
4. Write the SQL (parameterized). Append to `ccat.audit_log` for governance actions.
5. Add a typed method in `apps/admin/src/lib/api.ts`.
6. Call it from the page; surface errors with `ui.tsx` (ErrorBox / toast).

### Add a new admin page/section
1. New `pages/Foo.tsx`; add a `<Route>` in `App.tsx`.
2. Add a rail item (or sub-tab) in `components/Layout.tsx`, with a `perm` if it should be gated.
3. Back it with a gateway route + `api.ts` method as above.

### Add a permission
Add the key to the gateway permission set, reference it via `requirePermission`, expose it on the
**Admin accounts** page so it can be granted, and gate the UI with `can()`.

---

## 2. Multi-site direction (making this the admin for several sites)

Today the admin manages one property (CCAT). To bring more of Concept Mastery's sites under it without a
rewrite, the intended path:

- **Introduce a `site` (or `property`) dimension** — a table of sites, and a `site_id` on the
  content/students/entitlements a given site owns. Most `admin-*` queries then filter by the active site.
- **Site switcher** in the header (`Layout.tsx`) that sets the active site in context; the API client
  sends it (header or query) and the gateway scopes every read/write.
- **Per-site permissions** — extend the permission model so an admin can be scoped to one site or all.
- **Per-site config** — grades, tiers/prices, themes, and flags become site-scoped where they differ.
- **Shared vs. per-site content** — decide which content is global and which is site-owned.

Until that lands, treat the current admin as the CCAT property's admin; don't hard-code assumptions that
block a future `site_id` (e.g., keep queries centralized in `admin-*.ts` so scoping can be added in one place).

---

## 3. Improvement backlog (options)

Grouped; each is a candidate, not a commitment. Pull one, confirm scope, implement.

**Students**
- Bulk actions (multi-select suspend/delete/export).
- Saved filters / segments (e.g., "registered this week", "paid, expiring < 30 days").
- Column chooser persistence per admin; CSV export of the current filter (partly present).
- Expiring-soon view: guardians whose `current_period_end` is within N days.

**Content**
- Set templates / duplicate-across-grades.
- Question bank search across sets; find-and-replace in stems/options.
- Preview a set exactly as the student sees it.
- Validation dashboard: grades/batteries missing published sets (blocks signup via `practice_ready`).

**Memberships / payments**
- Renewals view + one-click extend (+1 year) from an expiring list.
- Distinguish comp/trial (perpetual) vs paid (dated) defaults explicitly in the grant UI.
- Refund/downgrade audit surfacing; webhook event log page.

**Governance / ops**
- Admin activity view per staff member (already partly in audit facets).
- Feature-flag change history.
- Health page: surface last webhook received, job lag, error rates.

**Platform / multi-site**
- The `site_id` scoping in §2 (foundational for everything multi-site).
- Per-site branding/theme in the admin header.

**Quality**
- A short CONTRIBUTING note + a smoke checklist per area for pre-deploy testing.
- Type-safety: shared response types between gateway and `api.ts` via `packages/contracts`.

---

## 4. Done / shipped (recent)

- Per-set question cap raised to **100** (practice + exam): DB constraint, gateway Zod, frontend ceilings.
- **Bulk add**: settable "Questions per set" + remembered "Default per set" on the Content page.
- **Students**: registration-date **separators** (accent-band) + From–To registration-date filter; date-grouped list.
- **Membership expiry**: stored as a bare **date**; paid/manual grants default to **grant date + 1 year**; existing paid rows backfilled.
- Content toolbar: removed "New question"; grouped actions on the right.
- Grade 2 added; signup grade gating is coverage-based (`practice_ready`).
- Student "Delete" = purge; Reset PIN; admin-created student accounts (no OTP).

_When you ship a backlog item, add it here with the date and remove it from §3._
