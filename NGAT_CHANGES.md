# NGAT Workspace — As-Built Changes (Phase 1 implementation)

**Repo:** `ccat-practice-app-development--new`
**Date:** 2026-10-01 · **Author:** Claude (Cowork)
**Companion:** see `NGAT_WORKFLOW.md` for the design/plan. This file is the **implementation record** — read it first when debugging or continuing NGAT work.
**Git:** nothing was pushed. All changes are working-tree edits for you to review and push.

---

## 1. Decisions this build implements

| # | Decision |
|---|----------|
| A | NGAT = **Verbal only** at launch (Part A/B/C). **No content seeded** — only the taxonomy scaffold. Admin will add questions later. Grades 2–6 (taxonomy is grade-agnostic; grade scoping happens when sets are created). |
| B | Bookmarks are **program-scoped**. |
| C | Switcher lives in the **Sidebar header + mobile drawer** (not a separate top bar). |
| D | NGAT is gated to **allow-listed accounts** (`user_d` / Child D) via a server `ngat_enabled` flag — this is also the **seam for a future paywall**. |

CCAT **login page untouched** (confirmed — no edits to `LoginScreen.tsx` or auth).

---

## 2. The model in one line

A single new column — `ccat.categories.program` (`'ccat' | 'ngat'`) — carries the whole split. Every scoped read (catalog, practice/exam sessions list, assignments, progress, bookmarks, exam history) filters by it through the existing category join. Shared features (profile, coins, XP, rewards, achievements, plan/entitlements) are **not** scoped. Every scoped endpoint **defaults to `ccat`**, so the mobile app and any un-updated client are unaffected.

---

## 3. File-by-file changes

### 3.1 Database — `packages/contracts/migrations/0054_ngat_program.sql` (NEW)
- Adds `program text not null default 'ccat'` to `ccat.categories`.
- Replaces the global `unique(key)` with `unique(program, key)` (so NGAT can reuse `verbal`); adds `check (program in ('ccat','ngat'))` and `categories_program_idx`.
- Seeds the **NGAT taxonomy scaffold only**: one category `('verbal','Verbal Reasoning','ngat')` + three subcategories `part_a`/`part_b`/`part_c` ("Part A/B/C"). **No question sets, no questions.**
- Fully idempotent; safe to run before the gateway/web code (all reads default to `ccat`).

### 3.2 Gateway (`apps/gateway/src/`)
- **`config.ts`** — new `ngatEnabledUsernames: string[]` from env `NGAT_ENABLED_USERNAMES` (comma-separated, lowercased). **Default `['user_d']`.** Change the account(s) here without touching code.
- **`routes/catalog.ts`**
  - `GET /v1/catalog` now accepts `?program` (default `ccat`) and filters `... join ccat.categories cat on cat.id = qs.category_id and cat.program = $2`.
  - `GET /v1/grades` `practice_ready` subquery pinned to `cat.program = 'ccat'` (registration stays CCAT).
  - `GET /v1/profile` now returns **`ngat_enabled`** = username ∈ allow-list.
- **`routes/progress.ts`** — `progOf(query)` helper; `program` threaded through `finishedSetRows`, `computeProgressSummary`, `computeProgressSets`, `computeBreakdown` and every category-joined query inside them (battery skeleton, subcategory list, totals, practice-time, time series, exam papers done/total, breakdown completion). All default `ccat`. `computeSetReview` left unscoped (a `setId` already implies its program). `progressCardTotals` (admin) stays CCAT by default.
- **`routes/assignments.ts`** — `GET /v1/assignments?program` (default `ccat`), filtered via set→category.
- **`routes/bookmarks.ts`** — `GET /v1/bookmarks?program` (default `ccat`), filtered via question→category. The single-question review/PUT/DELETE endpoints are unscoped (program implied by the question).
- **`routes/sessions.ts`** — `GET /v1/exams/history?program` (default `ccat`), filtered via category.
- **`routes/admin-content.ts` + `routes/admin-content-authoring.ts`** — admin category reads pinned to `program='ccat'` so the (deferred) admin console keeps operating on CCAT only and the `key='verbal'` authoring anchor can’t accidentally grab the NGAT row.

> Not scoped (correct by design): `lib/achievements.ts`, `lib/entitlements.ts`, economy — these are **shared** and span both workspaces. `sessions.ts` content/session reads join by `category_id` (already program-correct per the set).

### 3.3 Shared client (`packages/api-client/src/`)
- **`types.ts`** — new `export type Program = 'ccat' | 'ngat'`; `StudentProfile.ngat_enabled?: boolean`.
- **`index.ts`** — `withProgram(path, program)` helper (appends `program=ngat` only, else no-op). Optional `program?` added to `catalog`, `assignments`, `bookmarks`, `examHistory`, `progressSummary`, `progressBreakdown`, `progressSets`.

### 3.4 Web — student SPA (`apps/web/src/`)
- **`lib/store.tsx`** — new `program` / `setProgram` in the app store; restores last workspace from `localStorage['cm_active_program']` (no CCAT bias; first visit → CCAT); an effect snaps back to CCAT if a non-entitled profile is somehow in NGAT.
- **`components/WorkspaceSwitch.tsx` (NEW)** — segmented `[ CCAT · NGAT ]` pill. **Self-hides unless `profile.ngat_enabled`.** On switch it resets scoped drill-down (mid-session/result → Home; Practice/Exam → keep `mode`, drop battery/category/set).
- **`components/Sidebar.tsx`** — renders `<WorkspaceSwitch/>` under the brand (so it also shows in the mobile drawer); brand sub-label now reads "NGAT Practice" in NGAT; assignment badge count fetched per `program`.
- **`screens/PracticeScreen.tsx`** — `client.catalog(program)`, refetches on switch. Serves **both** Practice and Exam; the 3-battery shell + empty-battery auto-hide are unchanged, so NGAT shows only Verbal.
- **`screens/ProgressScreen.tsx`** — summary, sets, and the Exam-Progress panel all scoped to `program`.
- **`screens/AssignmentsScreen.tsx`**, **`screens/BookmarksScreen.tsx`** — scoped to `program`.
- **`screens/HomeScreen.tsx`** — the practice-analytics widget (`progressSummary`) scoped to `program`; shared widgets (rewards, achievements, coins/XP) unchanged.
- **`theme.css`** — styles for `.ws-switch` / `.ws-seg` (hidden in the collapsed rail; visible on hover-expand and in the drawer, like the nav labels).

---

## 4. Feature status

| Feature | Status | Notes |
|--------|--------|-------|
| `program` column + NGAT taxonomy | ✅ written (migration) | **You run it on Supabase.** |
| Workspace switcher (gated) | ✅ complete | Visible only for allow-listed accounts. |
| Persisted/last-used workspace | ✅ complete | localStorage, no CCAT bias. |
| Practice scoped to program | ✅ complete | NGAT shows Verbal only until sets exist. |
| Exam scoped to program | ✅ complete | Same screen; NGAT empty until exam sets exist. |
| Assignments scoped | ✅ complete | |
| Progress scoped (summary/sets/exam history) | ✅ complete | |
| Bookmarks scoped | ✅ complete | |
| Shared profile/coins/XP/rewards/achievements/plan | ✅ unchanged | One identity + balances across both. |
| Paywall seam | ✅ seam in place | `ngat_enabled` flag; swap allow-list for an entitlement check later. |
| Typecheck/build in this environment | ⚠️ not run | pnpm symlinks aren’t traversable over the mount (I/O error). **Run locally — see §6.** |
| NGAT content (questions) | ⛔ not in scope | Admin adds later. |
| Admin NGAT authoring UI | ⛔ deferred | Admin pinned to CCAT for now. |
| Mobile app | ⛔ unchanged | Calls gateway without `program` → sees CCAT. |

---

## 5. Shared vs Separate (as built)

- **Shared (unscoped):** `students`/profile, economy/coins, XP, rewards, achievements, entitlements/plan, bookmarks review of a single question.
- **Separate (scoped by `program`):** catalog, practice & exam set lists, sessions-derived progress (summary/sets/breakdown/exam-history), assignments, the bookmark **list**.

---

## 6. What you must do (and how)

1. **Run the migration on Supabase** (you asked to own this):
   - Apply `packages/contracts/migrations/0054_ngat_program.sql` the same way you run other migrations (e.g. `pnpm migrate`, or your Supabase migration path).
2. **Typecheck/build locally** (couldn’t run here — pnpm symlinks over the mount):
   ```
   pnpm --filter @ccat/api-client typecheck
   pnpm --filter @ccat/gateway build        # or your gateway typecheck
   pnpm --filter @ccat/web typecheck
   pnpm --filter @ccat/web build
   ```
3. **Set the NGAT allow-list** (optional): confirm the test account’s **username** is `user_d`. If different, set `NGAT_ENABLED_USERNAMES=<username>` in the gateway env (comma-separated for several). Default is `user_d`.
4. **Git push** — you own this. Nothing was committed.

### Local verification walk-through
- Log in as the allow-listed test account → the `CCAT | NGAT` pill appears in the sidebar (hover to expand the rail, or open the mobile drawer).
- Switch to NGAT → Practice shows the **Verbal** battery only (empty state until sets exist) → Part A/B/C once content is added.
- Coins/XP/achievements stay identical across both workspaces.
- Switch back to CCAT → all CCAT data intact.
- Log in as a **non**-allow-listed account → no switcher; app behaves exactly as before.

---

## 7. Known issues / follow-ups

- **Typecheck not run in this environment** — must be run locally (§6). Edits were applied with exact-match assertions and hand-reviewed for param indexing/types, but a local `tsc` is the final gate.
- **Admin NGAT authoring deferred** — admin is pinned to CCAT. NGAT content can’t be created from the admin UI until that phase; this scaffold gives the taxonomy for it to target.
- **Legacy `GET /v1/progress`** (learning-plan coverage, used by a Home widget) is **not** program-scoped — NGAT has no learning plans so it returns empty/overall; scope it when NGAT learning plans exist.
- **Mobile app** untouched (sees CCAT).
- **Registration/grade picker** intentionally CCAT-only (`practice_ready` pinned to `ccat`).
