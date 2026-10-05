# Math Olympiad ↔ Web Admin — Audit / Project Memory

**Repo:** `ccat-practice-app-development--new`
**Scope tracked:** changes in `D:\Concept Mastry Project\GitHub_CCAT App\ccat-practice-app-development--new` **and** `D:\Concept Mastry Project\Math Olympiad Web`.
**Purpose:** single reference so future debugging reads this file instead of re-scanning folders and old context.
**Update rule:** update this file **every time** code, files, or migrations change in either folder.

---

## Current project status

🟡 **Phase 0 (planning) — awaiting decisions.** No implementation code written. Workflow/architecture documented in `MATH_WEBADMIN_WORKFLOW.md`. Build is blocked on decisions D1–D6 (see that doc §17).

---

## Change log

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
| I1 | 🔴 Critical | **OPEN** | RLS **disabled** on `student_notes`, `support_messages`, `math_contests`, `math_contest_entries`, `math_levels` (anon key exposed). | Migration M1 (enable+force RLS, gateway-only policy). Pending D6. |
| I2 | 🟠 | OPEN | `DRAFT_math_site_scoping.sql` header says "NOT APPLIED" but §1/§2/§4 are live; §3/§5 not. | This file tracks true state; retire/update draft header. |
| I3 | 🟠 | OPEN | Content not scoped for Math → `program='ccat'` Math sets would leak into CCAT. | Adopt `program='math'` (M2) before authoring Math content. Pending D2. |
| I4 | 🟡 | OPEN | No Student/Teacher mockups supplied. | Reuse existing pages; confirm (D4). |
| I5 | 🟡 | OPEN | No admin support console; `support_cases` has no site column. | `admin-support.ts` + `support_cases.site_id` (M3). |
| I6 | 🟡 | OPEN | `students.site_id` backfill/NOT NULL unverified; no `math` admin grants. | M6 verify; grant `math` in `admin_sites` (D7). |
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
