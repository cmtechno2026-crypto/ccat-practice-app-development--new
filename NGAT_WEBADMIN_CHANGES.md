# NGAT in Web Admin — As-Built Changes (Phase 1 implementation)

**Repo:** `ccat-practice-app-development--new`
**Date:** 2026-10-01 · **Author:** Claude (Cowork)
**Companion:** `NGAT_WEBADMIN_WORKFLOW.md` (the approved plan). This file is the **implementation record** — read it first when debugging or continuing Web Admin NGAT work.
**Git:** nothing was pushed. All changes are working-tree edits for you to review and push.
**DB:** migration `0055` was **applied to the live production Supabase** (`cqzpzhdleqyrmedymypg`, the project Render points to) — see §6.

---

## 1. Decisions implemented (your answers — 2026-10-01)

| # | Decision |
|---|----------|
| 1 | **Admin** NGAT switcher = **in-page pills** in Content / Exam papers / Import (and in the teacher Practice/Exam browse for non-teacher admins). Not a second global top-bar pill. |
| 2 | **Teacher-role** accounts (`is_teacher`) get a **top-bar NGAT pill** that scopes Practice/Exam browse + the per-student Progress & Assignments panels in Student Detail. No new teacher rail pages. |
| 3 | **No allow-list** — the admin NGAT switcher is always visible to content admins and teachers. (The student app keeps its own `ngat_enabled` gate; that flag is not used on the admin side.) |
| 4 | **Full 3-battery** NGAT authoring. Verbal already existed (`0054`); this build adds NGAT **Quantitative** + **Non-verbal** via `0055`, each with one **"General"** subcategory (flat launch — subcategory names to be refined later, §7-A). |
| B | Learning plans stay **CCAT-only** this phase (untouched). |
| C | Assignments are **program-scoped for both** admins and teachers. |

The SITE switcher (`CCAT Practice | TeacherHub`) is a **separate dimension** and was left exactly as-is. The new PROGRAM switcher (`CCAT | NGAT`) is independent of it.

---

## 2. The model in one line

The whole split rides the existing `ccat.categories.program` column (`'ccat' | 'ngat'`) from `0054`. Every admin read that joins categories now takes an optional `?program` (default `ccat`) and filters through that join. Content created under an NGAT category is NGAT automatically — no `program` column on sets/questions/sessions/assignments. Every scoped endpoint defaults to `ccat`, so mobile and any un-updated client are unaffected.

---

## 3. File-by-file changes

### 3.1 Database — `packages/contracts/migrations/0055_ngat_full_batteries.sql` (NEW)
- Adds NGAT categories `quantitative` ("Quantitative Reasoning", `display_order` 20) and `non_verbal` ("Non-verbal Reasoning", `display_order` 30), each with one subcategory `general` ("General"). Structure only — no sets, no questions. Idempotent (`on conflict (program,key)` / `(category_id,key)`). **Applied to production** (§6).

### 3.2 Gateway (`apps/gateway/src/routes/`)
Pattern: read `program` from the query (coerce to `'ngat'` only when exactly `'ngat'`, else `'ccat'`) and add `and cat.program = $n` to the category join. All default `ccat`.
- **`admin-content.ts`**
  - `GET /v1/admin/content/taxonomy` — now `(req)`; accepts `?program`; categories and subcategories both filtered to that program (subcategories joined to categories). **This is the master gate**: the authoring UI builds every picker from taxonomy, so created content inherits the program.
  - `GET /v1/admin/content/questions` — list now filters `cat.program = $5` (default ccat). (UI route is deprecated/redirected, scoped for safety.)
  - `GET /v1/admin/content/sets` — accepts `?program`; set list filtered via `cat.program = $1`.
- **`admin-content-authoring.ts`**
  - `POST /v1/admin/content/import` — accepts `?program`; the taxonomy name-resolution (categories + subcategories) is scoped to that program.
  - `POST /v1/admin/content/exam-papers/scaffold` — accepts `?program`; the `key='verbal'` anchor (and fallback first-category) resolves within the chosen program.
  - `POST /v1/admin/content/sets` (createSet) — **unchanged**; it already uses the client-supplied `category_id` (now program-correct via program-aware taxonomy).
- **`admin-students.ts`**
  - `GET /v1/admin/teacher/catalog` — accepts `?program`; `and cat.program = $2`.
  - `GET /v1/admin/students/:id/assignments` (list) and `.../assignments/catalog` — accept `?program`; filtered via set→category.
  - `GET /v1/admin/students/:id/progress/{summary,sets}` — thread `progOf(req.query)` into `computeProgressSummary` / `computeProgressSets` (default ccat). `set-review` left unscoped (setId implies program).
  - `GET /v1/admin/students/:id/exams/history` — passes `progOf(req.query)` into `computeExamHistory`.
  - Imports `progOf` from `./progress.js`.
- **`sessions.ts`** — `computeExamHistory(db, sid, range, program = 'ccat')` gains a program param and a `cat.program = $n` predicate (only the admin Student Detail path uses this function; the student `/v1/exams/history` route has its own already-scoped copy).

### 3.3 Admin client (`apps/admin/src/lib/api.ts`)
Optional `program?: 'ccat' | 'ngat'` added to: `taxonomy`, `sets`, `scaffoldExamPapers`, `importScopedQuestions`, `teacherCatalog`, `getStudentProgress`, `getStudentProgressSets`, `getStudentExamHistory`, `getStudentAssignments`, `getStudentAssignmentsCatalog`. Appends `program=ngat` only when NGAT; omitted ⇒ ccat (today's behaviour).

### 3.4 Admin SPA (`apps/admin/src/`)
- **`lib/auth.tsx`** — new `program` / `setProgram` in the auth context, persisted to `localStorage['ccat_admin_program']` (fallback `ccat`). **Separate from** the site state (`activeSite` / `ccat_admin_site`).
- **`components/ProgramPills.tsx` (NEW)** — the `[ CCAT · NGAT ]` segmented pill; reads/sets the program state. Visually mirrors the site pill but is clearly the program axis.
- **`pages/Content.tsx`** — `ProgramPills` in the content nav; `api.sets(program)` + `api.taxonomy(program)`; refetches and resets grade/subcategory on program switch.
- **`pages/ExamPapers.tsx`** — `ProgramPills` in the content nav; `api.sets(program)` + `api.taxonomy(program)`; resets grade + battery on switch.
- **`pages/ImportQuestions.tsx`** — `ProgramPills` in the toolbar; `api.importScopedQuestions(rows, program)`.
- **`pages/TeacherContent.tsx`** — uses the program state; `api.teacherCatalog(gradeId, program)`, refetches + resets browse position on switch. In-page `ProgramPills` shown for **non-teacher admins** (teacher accounts use the top-bar pill instead).
- **`components/Layout.tsx`** — renders `ProgramPills` in the top bar **only for teacher accounts** (`me.is_teacher`) on program-scoped routes (`/teacher-practice`, `/teacher-exam`, `/students`). No program pill added to the regular-admin top bar (decision #1).
- **`pages/StudentDetail.tsx`** — the Progress panels (summary, sets, exam history) and the Assignments panel + assign-catalog modal all read the active `program` and refetch on switch.
- **`components/SetEditor.tsx`** — the sibling-name uniqueness fetch (`api.sets`) now passes `program` so editing an NGAT set checks NGAT siblings.

---

## 4. Feature status

| Feature | Status | Notes |
|--------|--------|-------|
| `program` column + NGAT Verbal scaffold (`0054`) | ✅ live in prod | Pre-existing (student build). |
| NGAT Quant + Non-verbal batteries (`0055`) | ✅ written + **applied to prod** | One "General" subcategory each; refine names later. |
| Admin Content authoring scoped to program | ✅ complete | Taxonomy/sets/import/exam scaffold program-aware. |
| Admin Content in-page NGAT pills | ✅ complete | Content / Exam / Import. |
| Teacher top-bar NGAT pill | ✅ complete | `is_teacher` only, scoped routes. |
| Teacher Practice/Exam browse scoped | ✅ complete | `teacher/catalog?program`. |
| Per-student Progress scoped (summary/sets/exam history) | ✅ complete | In Student Detail. |
| Per-student Assignments scoped (list + assign) | ✅ complete | Decision C. |
| Persisted program (last-used) | ✅ complete | `localStorage['ccat_admin_program']`, separate from site. |
| Backward-compat (default ccat everywhere) | ✅ complete | Mobile/un-updated clients unaffected. |
| Typecheck / build in this environment | ⚠️ not run | pnpm symlinks aren't traversable over the device mount. **Run locally — see §5.** |
| Learning plans under NGAT | ⛔ out of scope | CCAT-only (decision B). |
| Mobile app | ⛔ unchanged | Sees CCAT. |

---

## 5. What you must do

1. **Typecheck / build locally** (couldn't run here):
   ```
   pnpm --filter @ccat/gateway build        # or your gateway typecheck
   pnpm --filter @ccat/admin typecheck
   pnpm --filter @ccat/admin build
   ```
2. **Migration** — `0055` is **already applied to production Supabase**. The file is in `packages/contracts/migrations/` so it also runs via your normal `pnpm migrate` (idempotent — safe to re-run).
3. **Redeploy after review:** `apps/admin` → Vercel; `apps/gateway` → Render. DB already done.
4. **Git push** — you own this. Nothing was committed. (Note: the working tree also still contains the **earlier student-build** NGAT edits under `apps/web/*`, `apps/web/src/lib/async-cache.ts`, and the `NGAT_CHANGES.md` update — those are from the student-side NGAT work, not this admin build. Review/commit as you see fit.)

### Local verification walk-through
- Sign in as a content admin → **Content** → flip the pill to **NGAT** → taxonomy shows Verbal (Part A/B/C) + Quantitative + Non-verbal (General). Create/import/scaffold a set → it lands under NGAT, not CCAT; flip to **CCAT** → CCAT content intact.
- Publish an NGAT set → it appears in the student NGAT workspace and in the teacher NGAT browse.
- Sign in as a **teacher** account → top-bar `CCAT | NGAT` pill → NGAT scopes Practice/Exam browse; open a student → Progress + Assignments reflect NGAT; assign an NGAT set; flip to CCAT → CCAT data intact.
- Confirm the `CCAT Practice | TeacherHub` site pill still works independently.

---

## 6. Production DB change applied

Ran against **`cqzpzhdleqyrmedymypg`** (the live project Render points to), ccat schema, inserting NGAT-only rows (no CCAT rows touched):
- `ccat.categories`: `('quantitative','Quantitative Reasoning','ngat',20)`, `('non_verbal','Non-verbal Reasoning','ngat',30)`.
- `ccat.subcategories`: one `('general','General')` under each.
Verified: NGAT now has verbal (Part A/B/C), quantitative (General), non_verbal (General). CCAT categories unchanged.

> **Note:** the same NGAT rows were first applied to `wazutprwrhnabjfggghp` (also named "ccat-practice-app-development") before you clarified the live DB. Those rows are harmless additive NGAT taxonomy. Say the word if you want them removed from that project.

---

## 7. Known issues / follow-ups

- **A. NGAT Quant/Non-verbal subcategories are placeholder "General".** Rename / add real subcategories later (a small migration or an admin taxonomy editor). Practice authoring works today against "General".
- **Typecheck not run here** — must pass `tsc` locally before deploy. Edits were applied with exact-match asserts and type-reviewed; a local build is the final gate.
- **Admin "Questions" list endpoint** is program-scoped defensively though its UI route is redirected to Content.
- **Learning plans** not program-scoped (NGAT has none this phase).
- **Mobile app** untouched (sees CCAT).
- **Exam-paper scaffold** for NGAT uses the `verbal` battery as the anchor within NGAT (same convention as CCAT).
