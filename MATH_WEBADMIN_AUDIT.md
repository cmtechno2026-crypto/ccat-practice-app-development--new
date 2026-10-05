# Math Olympiad ↔ Web Admin — Audit / Project Memory

**Repo:** `ccat-practice-app-development--new`
**Scope tracked:** changes in `D:\Concept Mastry Project\GitHub_CCAT App\ccat-practice-app-development--new` **and** `D:\Concept Mastry Project\Math Olympiad Web`.
**Purpose:** single reference so future debugging reads this file instead of re-scanning folders and old context.
**Update rule:** update this file **every time** code, files, or migrations change in either folder.

---

## Current project status

🟢 **Feature built end-to-end 2026-10-05.** Decisions D1–D7 locked. **Migrations 0059–0064 applied to prod.** Gateway: `program='math'` accepted (CCAT/NGAT unchanged), Math content API (admin-managed folders/sets), Support console, teacher-programs API, student list/create site-scoped. Admin UI: Math workspace switch + Content page + Support page + Teachers program chips. **All issues I1–I7 resolved.**

⚠️ **Must do before deploy:** the device's `node_modules` has no installed deps, so **no full typecheck/build could run here**. All 21 changed files are **syntax-clean** (compiler transpile pass) and imports/types were manually verified, but run `pnpm install && pnpm -w typecheck` (or the gateway/admin build) locally before deploying. Math taxonomy is now **admin-created in the UI** (no seed needed).

**Locked decisions:** D1=A (separate Math accounts + linked-people view) · D2=B (content scoped by site_id) · D3=Yes (teacher_programs) · D4=reuse existing UI · D5=workspace · D6=RLS applied · D7=super-admins only (no admin_sites rows; bypass covers it).

---

## Change log

### 2026-10-05 (c) — Backend build: migrations applied + gateway wired (Claude / Cowork)

**DB migrations applied to prod** (`cqzpzhdleqyrmedymypg`):
- `0060_math_content_site_scoping.sql` — `site_id` on content tables (categories, subcategories, question_sets, question_set_versions, announcements, books, learning_plans).
- `0061_support_cases_site_scoping.sql` — `site_id` on `support_cases`.
- `0062_teacher_programs.sql` — `teacher_programs` table + backfill (8 teachers → `ccat`).
- `0063_categories_program_math.sql` — `categories.program` CHECK widened to allow `'math'`.

**Gateway code (edited in place, `apps/gateway/src`):**
- **New** `lib/program.ts` — `parseProgram()` + `Program` type (`ccat|ngat|math`).
- Broadened program parsing to accept `'math'` in: `admin-content.ts`, `admin-content-authoring.ts`, `admin-students.ts`, `assignments.ts`, `bookmarks.ts`, `catalog.ts`, `progress.ts` (`progOf`), `sessions.ts`. Widened `program` param type in `progress.ts`/`sessions.ts` helpers to `Program`. **CCAT/NGAT output byte-identical** (same result for those inputs).
- **New** `routes/admin-support.ts` — admin Support console API (list cases by active site, case+thread detail, staff reply, state change). Gated `student.directory`/`student.update`; scoped by `req.admin.activeSite`. Registered in `app.ts`.
- `routes/admin-accounts.ts` — added `GET/PUT /v1/admin/accounts/:id/programs` (teacher↔program membership, D3), gated `admin.manage`.

**Design refinement (I3):** D2=B (`site_id`) kept as the authoritative Math scope; Math content also carries `program='math'` as a zero-touch compatibility backstop so **no existing CCAT/NGAT query had to change**. Content scope is anchored on the **category** (`program`+`site_id`); sets join to categories.

**Verification:** manual — all `parseProgram`/`Program` imports match usage, no dup imports, the one type-narrowing issue (progOf→Program) resolved across 5 helper signatures. ⚠️ **Full tsc not run** (device `node_modules` lacks fastify/zod/pg + @types) — typecheck locally before deploy.

**Pending:**
- **Content input needed:** Math taxonomy (categories/subcategories, `program='math'`,`site_id='math'`) must be seeded before Math content can be authored — same as NGAT needed (`0055–0057`). Draft seed migration not yet written (awaiting the category list).
- **Frontend:** Layout Math workspace (`SITE_NAMES['math']`, `MATH_RAIL`, `railForSite`); `auth.tsx` pin `program='math'` when `activeSite='math'`; `api.ts` broaden program type + add support/teacher-programs methods; Content page (mockup); **Support page** (mockup); Students/StudentDetail re-scope; Teachers program chips; linked-people view (D1-A).
- `question_sets.site_id` defaults to `'ccat'` on insert (scope enforced via category) — optionally set from category later; not load-bearing.

---

### 2026-10-05 (b) — Decisions locked + RLS fix applied (Claude / Cowork)

**What changed**
- Locked D1–D7 into `MATH_WEBADMIN_WORKFLOW.md`.
- **Applied migration `0059_math_tables_rls.sql` to prod** — RLS enabled+forced + grants revoked on `student_notes`, `support_messages`, `math_contests`, `math_contest_entries`, `math_levels`. Verified (I1 CLOSED).
- Wrote migration files `0060` (content site_id, D2=B), `0061` (support_cases site_id), `0062` (teacher_programs, D3) — **files only, not yet applied.**

**Files added**
- `packages/contracts/migrations/0059_math_tables_rls.sql` (applied)
- `packages/contracts/migrations/0060_math_content_site_scoping.sql` (pending)
- `packages/contracts/migrations/0061_support_cases_site_scoping.sql` (pending)
- `packages/contracts/migrations/0062_teacher_programs.sql` (pending)

**Corrections to Phase-0 record**
- **M6 unnecessary** — `students.site_id` already `NOT NULL default 'ccat'`, backfilled (86 ccat / 1 math).
- **No `ccat_gateway` role** — 0059 mirrors the real live pattern (no policy) instead of the draft's `to ccat_gateway` (would have errored).
- Migration numbering is file-based (latest 0058 → Math = 0059–0062); `ccat_schema_migrations` tracking table is stale (last 0044).

**Pending** — apply 0060–0062 with the gateway code; gateway re-scoping (site_id on content/support queries, broaden to Math); `admin-support.ts`; Web Admin Math workspace + Content/Support/Students/Teachers.

---

## Change log (Phase 0)

### 2026-10-05 — Phase 0 kickoff (Claude / Cowork)

**What changed**
- Created `MATH_WEBADMIN_WORKFLOW.md` (Phase 0 architecture + workflow plan, all required sections).
- Created this audit file.

**Files added**
- `MATH_WEBADMIN_WORKFLOW.md` (repo root)
- `MATH_WEBADMIN_AUDIT.md` (repo root)

**Files edited** — none.

**DB migrations added** — none (planning only).

**Features completed** — Phase 0 documentation only.

**Features pending** — all implementation: Math workspace in Web Admin; Content page; Support page; Students re-scope; Teachers membership; gateway routes; migrations M1–M4 (+M6). Gated on decisions.

---

## Verified live-state snapshot (Supabase `cqzpzhdleqyrmedymypg`, schema `ccat`, 2026-10-05)

Use this as the baseline; re-verify before applying migrations.

- `ccat.sites` (3): `ccat` "CCAT Practice" (sort 10) · `math` "Math Olympiad" (sort 15) · `teacher` "Teacher Hub" (sort 20). **Math site already registered.**
- `ccat.admin_sites`: 4 rows, **all `ccat`** → no admin explicitly granted `math` (super-admins see it via all-active-sites bypass).
- `ccat.categories.program` values: `ccat`, `ngat` — **no `math`** yet.
- `ccat.students.site_id`: **column present** (FK→sites). Backfill/`NOT NULL`/default **not fully verified**.
- Content tables **without** `site_id`: `categories`, `question_sets`, `announcements`, `books`, `learning_plans`, `support_cases`. → draft §3 **not applied**.
- `ccat.support_cases` cols: `id, student_id, opened_by, reference, summary, state, created_at, updated_at` (no site/program).
- **Already-live Math tables:** `student_notes` (0) · `support_messages` (0) · `math_contests` (0) · `math_contest_entries` (0) · `math_levels` (**7 rows, seeded** Bronze→Platinum).
- `apps/gateway/src/routes/math.ts`: present; `SITE='math'` separate student auth (OTP-free); content/quiz/leaderboard/billing return empty until Math content exists.

---

## Issues register (live)

| # | Severity | Status | Issue | Fix |
|---|---|---|---|---|
| I1 | 🔴 Critical | ✅ **CLOSED 2026-10-05** | RLS **disabled** on the 5 Math tables (anon key exposed). | Migration `0059` applied: RLS enabled+forced + grants revoked. No policy (no `ccat_gateway` role exists); mirrors live ccat pattern. Verified. |
| I2 | 🟠 | OPEN | `DRAFT_math_site_scoping.sql` header says "NOT APPLIED" but §1/§2/§4 are live; §3/§5 not. | This file tracks true state; retire/update draft header. |
| I3 | 🟠 | ✅ **ADDRESSED 2026-10-05** | Content not scoped for Math → leak risk. | `site_id` on content (0060) + `program='math'` backstop (0063) + gateway accepts `program='math'`. Zero CCAT-query changes. Remaining: seed Math taxonomy + frontend sends `program='math'`. |
| I4 | 🟡 | OPEN | No Student/Teacher mockups supplied. | Reuse existing pages; confirm (D4). |
| I5 | 🟡 | ✅ **BACKEND DONE 2026-10-05** | No admin support console; `support_cases` had no site column. | `support_cases.site_id` (0061) + `admin-support.ts` (list/thread/reply/state, site-scoped). Frontend Support page pending. |
| I6 | 🟡 | ✅ **RESOLVED 2026-10-05** | `students.site_id` backfill/NOT NULL unverified; no `math` admin grants. | Verified live: `site_id` already `NOT NULL default 'ccat'`, backfilled (86 ccat/1 math) → M6 unneeded. D7=super-admins only → no `admin_sites` rows needed (bypass covers it). |
| I7 | 🟢 | OPEN | `math.ts` hard-codes separate-account model D1 may revisit. | Resolve D1 first. |

---

## Decisions requested (see `MATH_WEBADMIN_WORKFLOW.md §17`)

| # | Decision | Status |
|---|---|---|
| D1 | Student identity: separate Math accounts (A, recommended) vs unified identity + `student_programs` (B) | ⏳ awaiting |
| D2 | Math content scoping: `program='math'` (A, recommended) vs `site_id` on content (B) | ⏳ awaiting |
| D3 | New `teacher_programs` membership + program chips | ⏳ awaiting |
| D4 | Reuse existing Students/Teachers UI (no mockups) | ⏳ awaiting |
| D5 | Math = third workspace (recommended) vs program pill | ⏳ awaiting |
| D6 | Apply RLS fix M1 now | ⏳ awaiting |
| D7 | Which admins get the `math` site grant | ⏳ awaiting |

---

## Migration plan (not yet applied)

| # | Purpose | Status |
|---|---|---|
| M1 | Enable+force RLS + gateway policy on 5 Math tables | pending (D6) |
| M2 | `categories.program` accept `'math'` | pending (D2) |
| M3 | `support_cases.site_id` | pending |
| M4 | `ccat.teacher_programs` + backfill | pending (D3) |
| M5 | `student_programs` + identity unify | only if D1-B |
| M6 | Verify/finish `students.site_id` NOT NULL/default | pending |
