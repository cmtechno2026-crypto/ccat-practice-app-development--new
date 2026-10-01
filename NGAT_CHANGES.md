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

---

## 8. Workspace-switch performance fix (post-review)

**Symptom:** every CCAT⇄NGAT switch showed a full-screen loader and re-fetched everything, even when switching back to a workspace already loaded in the same session.

**Cause:** `useAsync` had no cache. Changing `program` flipped `loading:true` and refetched; screens gate the `<Loader/>` on `loading`, so the spinner appeared on every switch.

**Fix — stale-while-revalidate cache (session-lived):**
- `apps/web/src/lib/async-cache.ts` (NEW) — a shared in-memory `Map` + `clearAsyncCache()` (own module to avoid a ui↔store import cycle).
- `apps/web/src/components/ui.tsx` — `useAsync` takes an optional `cacheKey`. With a key: first load spins once, then the result is cached; subsequent mounts/switches render the cached data **instantly** (no spinner) and refresh silently in the background. Without a key: unchanged behaviour.
- Cache keys added to the program-scoped calls: catalog (`catalog:<program>`), progress summary/sets, exam history, assignments, bookmarks, Home (`home:<program>`).
- `apps/web/src/lib/store.tsx` — `signOut()` calls `clearAsyncCache()` so a different account signing in to the same tab never sees the previous user's cached data.

**Result:** one brief spinner per workspace per session on first open; every switch after is instant. Data still refreshes in the background each switch, so it never goes stale.

**Follow-up note (separate, not this fix):** the Home "Practice — pick a battery" preview shows all three battery cards regardless of program. In NGAT only Verbal has content, so Quantitative/Non-Verbal there lead to an empty Practice screen. If you want Home to show only batteries with content in the active workspace, that's a small HomeScreen change — tell me and I'll do it.

---

## 9. Switcher UI reposition (variant B)

Per review, the workspace switch moved out of the sidebar into the Home page.

- **`apps/web/src/components/WorkspaceSwitch.tsx`** — repurposed from a sidebar pill to **`WorkspaceTabs`**: a CCAT/NGAT tabbed header used inside the Home "ready to practise" card. Still self-hides unless `profile.ngat_enabled`.
- **`apps/web/src/screens/HomeScreen.tsx`**
  - The right-rail mascot card ("Ready for today's practice?") now leads with the `WorkspaceTabs`; the line reads "…today's NGAT practice?" when NGAT is active.
  - The **hero** top-right avatar is replaced by the active **workspace wordmark** (`NGAT` / `CCAT` + "WORKSPACE") for allow-listed accounts; other accounts keep the avatar unchanged.
- **`apps/web/src/components/Sidebar.tsx`**
  - Removed the sidebar switch pill. Added a small **read-only** "Workspace · NGAT" label (allow-listed accounts only) so the current workspace is always visible even though switching happens on Home.
  - Profile avatar given higher contrast (`.ws-avatar`: warm tint + orange ring).
- **`apps/web/src/theme.css`** — styles for `.ws-tabs`, `.hh-ws`, `.ws-foot`, `.ws-avatar`.

**Behaviour:** switching happens on the Home card only; Practice/Exam/Progress show the current workspace's data and the sidebar label reflects it. (Earlier `.ws-switch` sidebar styles remain in theme.css, now unused — harmless.)

---

## 10. Leak fixes + top-panel workspace name (T3)

**Two data-leak fixes (NGAT was showing CCAT data):**
- `packages/api-client/src/index.ts` — `examHistory()` accepted `program` but never appended it to the URL. Now appends `program=ngat`, so **NGAT Progress → Exam Progress** no longer shows CCAT exam history.
- `apps/web/src/components/AssignmentPanel.tsx` (Home "My Assignments" widget) — was calling `client.assignments()` with no program. Now passes `program` (and refetches on switch), so **NGAT Home** no longer shows CCAT assignments. (The full Assignments page was already scoped.)

**UI changes:**
- `apps/web/src/components/ui.tsx` — AppBar top-right now shows the **workspace name wordmark** (`CCAT`/`NGAT`, plain T3 style) on every in-app page for NGAT-enabled accounts; other accounts keep the avatar control.
- `apps/web/src/screens/HomeScreen.tsx` — hero wordmark dropped the "WORKSPACE" sublabel (just `CCAT`/`NGAT`).
- `apps/web/src/components/Sidebar.tsx` — removed the "Workspace · CCAT/NGAT" footer label.
- `apps/web/src/theme.css` — added `.appbar-ws`. (Old `.ws-foot` / `.hh-ws small` rules now unused — harmless.)

Needs a web redeploy + the shared-client change to take effect; the gateway already scoped correctly.

---

## 11. NGAT battery symbols (distinct from CCAT)

NGAT batteries now use their own icons (CCAT keeps `Aa/123/◧▲` practice and `🔤/🔢/🧩` exam):
- **Practice:** Verbal ✎ · Quantitative 📐 · Non-verbal 🧩
- **Exam:** Verbal 📝 · Quantitative 🧮 · Non-verbal ◪

Wired in two places, program- and mode-aware:
- `apps/web/src/screens/HomeScreen.tsx` — `NGAT_SYMBOLS` + `batterySymbol(program, mode, bt)` for the Home Practice/Exam cards.
- `apps/web/src/screens/PracticeScreen.tsx` — `NGAT_ICONS` override in `batteryMeta` for the Practice/Exam battery landings.

CCAT is untouched; needs a web redeploy to show.
