# Math Olympiad in Web Admin — Phase 0 Workflow & Architecture Plan

**Project:** CCAT Practice App — **Web Admin** (`apps/admin`) + Gateway (`apps/gateway`)
**Repo:** `ccat-practice-app-development--new` (monorepo, pnpm workspaces)
**Feature:** Manage the **Math Olympiad** platform (Content, Students, Teachers, Support) from the existing Web Admin, alongside CCAT and NGAT.
**Companion docs:** `NGAT_WEBADMIN_WORKFLOW.md` (the NGAT precedent — read it; this doc deliberately mirrors it), `MATH_OLYMPIAD_WORKFLOW.md` (student-web plan, lives in the Math Olympiad Web repo), `MATH_WEBADMIN_AUDIT.md` (the as-built audit file — created alongside this doc).
**Author:** Claude (Cowork) · **Date:** 2026-10-05
**Status:** 🟡 **DRAFT for Ankita's review.** No admin/gateway implementation code has been written. Build starts only after the decisions in §14 are answered.

---

## 0. How to read this document

This is the single source of truth for the **Web Admin → Math Olympiad** build. It is written so you can approve the approach before code exists, any implementer can follow it step by step, and later debugging reads this file + `MATH_WEBADMIN_AUDIT.md` instead of re-scanning three folders.

Everything in §1–§8 is grounded in the **actual current code and the live database** (real file paths, symbol names, table/column facts as of 2026-10-05, read directly from Supabase project `cqzpzhdleqyrmedymypg`). Where a fact could not be fully verified, it is flagged. External/estimated figures are flagged where they occur.

> **The one concept to internalise first (§4):** Web Admin already has **two independent switching dimensions** — **SITE** (`CCAT Practice ⇄ TeacherHub`) and **PROGRAM** (`CCAT ⇄ NGAT`). Math Olympiad must be slotted onto these two axes deliberately. The recommendation in this doc is: **Math is a new SITE** (third workspace) **for accounts/people**, and **a new PROGRAM value** (`program='math'`) **for content** — because that reuses two already-proven patterns and touches zero existing CCAT/NGAT queries. §14-D1 is where you confirm or override that.

---

## 1. Executive summary

- The Math Olympiad **student web** is a separate repo + separate Vercel deployment, but it already **shares this Render gateway and this Supabase `ccat` schema**. Part of the Math backend (separate site-scoped student auth in `apps/gateway/src/routes/math.ts`, a `math` row in `ccat.sites`, `students.site_id`, and five new Math feature tables) is **already live**. This Web Admin build is the **admin-side counterpart** — it does not stand up new infrastructure.
- Web Admin manages Math by adding a **third workspace** (`activeSite='math'`, "Math Olympiad") next to Practice Web and TeacherHub, reusing the existing site switcher, rail, header, and page shell. The two attached mockups (`Content-Page-standalone.html`, `Support-Page-standalone.html`) are exactly this: the current admin shell rendered with Math data.
- **Content** and **Support** get Math-specific admin pages (built from the mockups). **Students** and **Teachers** reuse the existing Web Admin pages, re-scoped to Math.
- **Blocking conflict to resolve first (§14-D1):** the Math student-web was built on **fully separate student accounts** (`students.site_id='math'`, its own registration in `math.ts`). Your new rule — *"students/teachers can belong to CCAT, NGAT, Math, or multiple; don't duplicate"* — describes a **shared-identity + program-membership** model, which is **incompatible** with separate accounts for students. This must be decided before any Students/Teachers code is written.
- **Security issue found (§13-I1, critical):** the five Math tables already in production have **Row-Level Security disabled** — the Supabase anon key can read/write them. Must be fixed.

---

## 2. Scope

**In scope (this build):**
1. Add a Math Olympiad **workspace** to Web Admin (site switch + Math rail).
2. **Content** admin page for Math (from `Content-Page-standalone.html`).
3. **Support** admin page for Math (from `Support-Page-standalone.html`).
4. **Students** management for Math (reuse existing `Students.tsx` / `StudentDetail.tsx`, re-scoped).
5. **Teachers** management for Math + make teacher↔program membership first-class (reuse existing `Teachers.tsx` / TeacherHub directory).
6. Gateway endpoints + Supabase migrations needed to back the above.
7. Keep CCAT + NGAT admin fully working; keep Render integration working.

**Out of scope:** Math student-web features (that repo); payments/plan specifics for Math (pricing TBD per memory); mobile app; any GitHub push (you handle Git).

---

## 3. Current architecture (what exists today — verified)

### 3.1 Monorepo (confirmed live)

```
ccat-practice-app-development--new/
├── apps/
│   ├── web/       @ccat/web      — CCAT student SPA (NGAT already shipped)
│   ├── admin/     @ccat/admin    — Web Admin SPA (Vite + React 18 + react-router 6) → Vercel   ← target
│   ├── gateway/   @ccat/gateway  — Fastify API (the only backend clients talk to) → Render
│   └── mobile/    @ccat/mobile   — React Native (out of scope)
└── packages/
    ├── api-client/   shared DTO types + HTTP client
    ├── client-core/  framework-agnostic helpers
    ├── contracts/    SQL migrations (DB source of truth) + OpenAPI
    └── shared/
```

Data flow: **Admin SPA → Gateway → Supabase** (schema `ccat`). The admin never touches the DB directly. Gateway: `https://ccat-gateway-payment.onrender.com`. DB: `https://cqzpzhdleqyrmedymypg.supabase.co`.

### 3.2 Admin app shape (`apps/admin/src`)

- `main.tsx` → `AuthProvider` (`lib/auth.tsx`) → `App` (`App.tsx` — route table + role gating).
- `components/Layout.tsx` — left rail + top bar; holds the **site** switcher (`switchSite`), the **notification bell**, theme toggle. Rail chosen by `railForSite(activeSite)`.
- `components/ProgramPills.tsx` — the **program** (CCAT/NGAT) switcher; in-page pills on Content/Exam/Import.
- `lib/auth.tsx` — `me`, `can(perm)`, **site** state (`sites`, `activeSite`, `switchSite`) and **program** state (`program`, `setProgram`).
- `lib/api.ts` — the single typed gateway client (`api.*`); passes `?program=ngat` where relevant; token in `sessionStorage`.
- `pages/*.tsx` — one screen per file (Dashboard, Content, Students, StudentDetail, Teachers, TeacherDirectory, ExamPapers, ImportQuestions, Announcements, Audit, …).

### 3.3 The two existing dimensions (the crux — see §4)

| | **SITE** dimension (workspace) | **PROGRAM** dimension |
|---|---|---|
| Values today | `ccat` ("Practice Web") ⇄ `teacher` ("TeacherHub") | `ccat` ⇄ `ngat` |
| What it switches | Which back-office you are in (different rail, different pages) | Which student-content catalog a content/teacher view shows |
| Frontend | `lib/auth.tsx` `activeSite`/`switchSite`; `components/Layout.tsx` top-bar pill; `localStorage['ccat_admin_site']` | `components/ProgramPills.tsx`; `setProgram`; `localStorage['ccat_admin_program']` |
| Gateway coupling | `ccat.sites` + `ccat.admin_sites`; header `X-Admin-Site`; `requireSite(req, siteId)` in `plugins/adminAuth.ts` | `ccat.categories.program` column; `?program=` query param defaulting to `'ccat'` |
| Backend guard | `adminAuth.ts` → `activeSite`, `assertSite`, `requireSite` | each route: `const program = req.query.program === 'ngat' ? 'ngat' : 'ccat'` |

### 3.4 Two different meanings of "teacher" (do not conflate)

| Term | What it is | Rail / routes |
|---|---|---|
| **TeacherHub** (a *site*) | A staff back-office: teacher directory, booking links, leave, staff training. Lives in `admin-teacher.ts`, gated `requireSite(req,'teacher')`. Program-agnostic. | `TEACHER_RAIL`, `/teacherhub/*` |
| **Teacher-role account** (`admin_profiles.is_teacher = true`) | A tutor who logs into Web Admin, **locked** to Students directory + read-only Student Detail + Practice/Exam browse. Student reads scoped to assigned students via `ccat.teacher_students`. | `TEACHER_ONLY_RAIL` |

### 3.5 Support today (`apps/gateway/src/routes/support.ts`)

- Students file "Report a problem" cases into **`ccat.support_cases`** (`opened_by` null when student-filed). Columns (verified): `id, student_id, opened_by, reference, summary, state, created_at, updated_at`.
- There is **no admin-side support console yet** and **no site/program column on `support_cases`** — Math support cannot be separated from CCAT support today.
- A new table **`ccat.support_messages`** (case-threaded chat: `case_id, sender ∈ {student,staff}, body, created_at`) **already exists in prod** (0 rows) — it is the backing store the Support mockup's chat pane expects.

---

## 4. Existing Math Olympiad footprint already in the shared backend (verified live)

This is the most important section for avoiding duplicate/conflicting work. The following is **already in production** in `cqzpzhdleqyrmedymypg`:

| Object | State in live DB | Source |
|---|---|---|
| `ccat.sites` row `('math','Math Olympiad', active, sort 15)` | **Present.** Sites now: `ccat`(10), `math`(15), `teacher`(20). | draft §1, applied |
| `ccat.students.site_id` column | **Present** (text, FK → `ccat.sites`). Backfill/`NOT NULL`/default state **not fully verified** — confirm at apply time. | draft §2, applied (partial) |
| `ccat.student_notes` | **Present** (0 rows). Has `site_id`. | draft §4a |
| `ccat.support_messages` | **Present** (0 rows). Case-threaded chat. | draft §4b |
| `ccat.math_contests`, `ccat.math_contest_entries` | **Present** (0 rows). | draft §4c |
| `ccat.math_levels` | **Present, seeded (7 rows:** Bronze→Platinum). | draft §4d |
| **RLS on the five tables above** | ❌ **DISABLED** — see §13-I1 (critical). | draft §5 **NOT applied** |
| `site_id` on **content** tables (`categories`, `question_sets`, `announcements`, `books`, `learning_plans`) | ❌ **Not present.** Content is **not** site-scoped. | draft §3 **NOT applied** |
| `ccat.categories.program` values | `ccat`, `ngat` only — **no `math`**. | live |
| `apps/gateway/src/routes/math.ts` | **Present.** Site-scoped (`SITE='math'`) **separate student auth** — OTP-free registration, login, email-availability; content/quiz/leaderboard/billing endpoints return empty until Math content exists. CCAT's own routes untouched. | live code |
| `ccat.admin_sites` | 4 rows, **all `ccat`** → no admin is explicitly granted the `math` site. Super-admins see it via the all-active-sites bypass; normal admins do **not** yet. | live |

> ⚠️ **Divergence flag:** the draft migration file `Math Olympiad Web/migrations/DRAFT_math_site_scoping.sql` is headed *"NOT APPLIED"*, but §1, §2 (partial), and §4 of it **are** in prod, while §3 and §5 are **not**. The draft file is therefore stale as a record of reality. `MATH_WEBADMIN_AUDIT.md` now tracks the true state.

**Consequence:** the Math **account pool** scaffolding exists (separate accounts via `site_id`). The Math **content** scaffolding does **not** (no `site_id` on content, no `program='math'`). Today, if Math sets were created with `program='ccat'`, they would **leak into CCAT admin/content** because CCAT content queries filter by `program` only, not by site. This directly drives the content-model recommendation in §5.2.

---

## 5. How Web Admin will manage Math — the model (recommended)

> This whole section is the **recommended** design. The decisions that make it binding are in §14. Nothing here is assumed as final.

### 5.1 People / accounts → the SITE dimension

Add **Math as a third workspace** (`activeSite='math'`, label "Math Olympiad"):
- Reuse the existing site switcher in `Layout.tsx` (`SITE_NAMES`, `railForSite`, `switchSite`, `X-Admin-Site`).
- A **Math rail**: Dashboard · Content · Students · Teachers · Support · Audit.
- Gateway Math-admin routes gated by `requireSite(req,'math')` (mirrors `requireSite(req,'teacher')`).
- Grant the `math` site to the relevant admins via `ccat.admin_sites` (super-admins already see it).

### 5.2 Content → the PROGRAM dimension (`program='math'`), NOT site_id-on-content

**Recommendation: model Math content as a new `program` value `'math'`, reusing the NGAT plumbing — do *not* apply the draft's `site_id`-on-content approach.**

Reasoning (this is the lowest-risk path and the single most important content decision — §14-D2):
- Every existing CCAT content/assignment/bookmark/progress query already filters `program` and **defaults to `'ccat'`**. Adding `program='math'` means those queries **naturally exclude** Math with **zero changes to existing CCAT/NGAT queries** — exactly how NGAT was added safely.
- The alternative (add `site_id` to every content table and make all CCAT queries also filter `site_id='ccat'`) **touches existing CCAT behaviour** on every content endpoint — higher blast radius, violates "don't break CCAT".
- `categories.program` would need to accept `'math'`. Confirm its column type/constraint at apply time (enum vs text + check); if it's a CHECK/enum, the migration extends it.

Net: **accounts are scoped by `site_id` (math), content is scoped by `program` (math).** These are orthogonal and coherent — `site_id` = which login pool a person is in; `program` = which catalog a content row belongs to. A Math student (`site_id='math'`) works Math content (`program='math'`).

### 5.3 Support → add a scope column to `support_cases`

`support_cases` has no site/program column. Add **`site_id`** (default `'ccat'`, backfill existing) so the admin Support console can filter to Math. The chat pane uses the existing `support_messages` table.

### 5.4 Why this matches the mockups

Both mockups render the **existing admin shell** (same dark rail, header, service-health, emergency controls) populated with Math data — confirming "reuse the Web Admin layout". The Content mockup is the Content section inside the shell; the Support mockup is a two-pane student-messaging console inside the shell. See §6/§9.

---

## 6. Content management workflow (from `Content-Page-standalone.html`)

**What the mockup specifies (extracted from the bundle):** the full admin shell (left rail, header with "Practice Web / TeacherHub"-style channel pills, notifications, service health). The **Content** section shows:
- **Tabs:** `Curriculum` ⇄ `Question banks` (in-page pills, like today's Content).
- **Grade filter** (`All grades / Grade 3 / Grade 6 / Grade 9 …`).
- **Sets table:** columns `SET | ITEMS | UPDATED | STATE`, with state badges **Published / In review / Scheduled / Draft**.
- **`Upload set`** primary action.
- Sample Math data: "Number Theory Sprint", "Geometry Proofs Ladder", "Combinatorics Lab", "CMKC Mock Paper 4", topics like "Modular arithmetic", "Pigeonhole drills".

**Workflow:**
1. Admin switches to the **Math** workspace → **Content**.
2. Page calls the existing content endpoints with **`?program=math`** (`api.taxonomy`, `api.sets`, `api.importScopedQuestions`, `api.scaffoldExamPapers`) — the same functions NGAT uses, extended to accept `'math'`.
3. Create/import/publish question sets → stored with `program='math'`, invisible to CCAT/NGAT.
4. Reuse the existing set lifecycle (Draft → In review → Scheduled → Published) and `ImportQuestions` bulk flow.

**Build approach:** reuse `pages/Content.tsx` + `ExamPapers.tsx` + `ImportQuestions.tsx`; make `program` resolve from the active workspace (when `activeSite==='math'`, program is pinned to `'math'`). The Math Content page is the existing Content page under the Math rail, styled per mockup. Minimal net-new UI.

---

## 7. Student management workflow

**Build approach: reuse `pages/Students.tsx` + `StudentDetail.tsx`** (directive: reuse existing layout — no Student mockup was supplied, see §13-I4).

- In the Math workspace, the Students directory lists **Math students** (`students.site_id='math'`). Columns as today (STUDENT · GRADE · STARTED · STATUS; search by name/email/student ID — all present in the mockup shell).
- `StudentDetail` shows Math progress/assignments/exams by calling the per-student endpoints with **`?program=math`** (the endpoints already take a `program` param).
- Create/suspend/grade-change reuse existing flows, scoped to `site_id='math'`.

**The membership question (blocking — §14-D1):** today a Math student is a **separate account** (`site_id='math'`). That satisfies "logically separate" but **contradicts** "a student can belong to CCAT, NGAT, Math, or multiple without duplication." Two coherent resolutions:

- **D1-A (recommended, least rework):** keep Math accounts separate. "Multi-program" means **CCAT+NGAT share one account** (already true — shared pool, program dimension); **Math is its own pool**. To honour "don't duplicate / clearly identify membership", add an **admin-side linked-people view**: match the same family across pools by guardian email/phone (`guardian_contacts`) and surface "also has a CCAT account" in Student Detail. No student-login change; no migration of 87 live CCAT students + 64 credentials.
- **D1-B (bigger change):** unify student identity — one `students` row per person with an explicit **`student_programs`** membership table (ccat/ngat/math). Requires **rewriting Math student-web auth** (`math.ts` separate registration/login), reworking `site_id` semantics, and migrating existing data. Higher risk; re-opens the already-shipped Math account model.

> I will **not** choose this. §14-D1.

---

## 8. Teacher management workflow

**Build approach: reuse `pages/Teachers.tsx` + TeacherHub `TeacherDirectory.tsx`** (no Teacher mockup supplied — §13-I4).

Current state: a teacher is `admin_profiles.is_teacher=true`; assigned students via `ccat.teacher_students`; there is **no program/site tag on teachers today**. The directive "teachers can belong to CCAT, NGAT, Math, or multiple" is **clean and additive** here (unlike students):

**Recommendation (§14-D3):** add a first-class **teacher↔program membership**:
- New table **`ccat.teacher_programs`** (`teacher_admin_id, program ∈ {ccat,ngat,math}`), many-to-many. One teacher record, multiple program tags — no duplication.
- The Teachers page gains a **program chips** multi-select per teacher (CCAT / NGAT / Math).
- Assignment of a teacher to a Math student is still `teacher_students`; the program tag governs which catalogs they can browse/assign from.
- Teacher-role accounts in the Math workspace get the same locked rail (Students · Practice · Exam) with program pinned to `math`.

This keeps one teacher identity across programs and makes membership explicit and queryable, satisfying the directive without touching CCAT/NGAT teacher behaviour (default membership = `{ccat}` for all existing teachers via backfill).

---

## 9. Support workflow (from `Support-Page-standalone.html`)

**What the mockup specifies (extracted):** a two-pane **student-messaging console** inside the admin shell:
- **Left:** list of student message threads; `Search students…`; each row shows student + program (`Math Olympiad`) + channel (`Practice Web`).
- **Right:** chat thread with the student; composer `Message the student…`; `Send`; `Open profile` (deep-link to Student Detail).
- Header carries the workspace/emergency-control chrome (`flags: web/app/signup/payments/maintenance`).

**Workflow:**
1. Admin (Math workspace) → **Support** → sees open Math cases/threads.
2. Selects a student → reads the thread (`support_messages` for that `case_id`) → replies (`sender='staff'`).
3. Resolve/close updates `support_cases.state`.

**Backend:** `support_messages` exists. Need: (a) `site_id` on `support_cases` (§5.3) to scope to Math; (b) **new admin support endpoints** (list cases by site, get thread, post staff message, change state) — none exist today (`support.ts` is student-only). (c) RLS on `support_messages` (§13-I1).

**Build approach:** net-new `pages/Support.tsx` built to the mockup, under the Math rail. (Could later be generalised to CCAT support, but scope here is Math.)

---

## 10. Shared-user logic across CCAT, NGAT, Math (summary)

| Entity | CCAT | NGAT | Math | Mechanism |
|---|---|---|---|---|
| **Student account** | `site_id='ccat'` | `site_id='ccat'` (same pool as CCAT) | `site_id='math'` (separate pool) | `students.site_id` |
| **Student content seen** | `program='ccat'` | `program='ngat'` | `program='math'` (recommended) | `categories.program` + `?program=` |
| **Teacher identity** | one `admin_profiles` row | same row | same row | `is_teacher` + proposed `teacher_programs` tags |
| **Admin workspace** | site `ccat` | (inside `ccat`, program pill) | site `math` | `admin_sites` + `X-Admin-Site` |

"Logically separate even when users are shared": Math content (`program='math'`) and Math accounts (`site_id='math'`) never intersect CCAT/NGAT queries. Shared *people* are represented either by the linked-people view (D1-A) or unified identity (D1-B) — **pending §14-D1**.

---

## 11. Database table plan

> Additive-only, schema `ccat`, nothing renamed/dropped, nothing outside `ccat`. Each as a numbered migration after the current max in `public.ccat_schema_migrations`. Final set depends on §14 answers.

**Already live (no new migration — but fix RLS, see I1):** `sites('math')`, `students.site_id`, `student_notes`, `support_messages`, `math_contests`, `math_contest_entries`, `math_levels`.

**New migrations needed (recommended model):**

| # | Migration | Purpose | Risk |
|---|---|---|---|
| M1 | **Enable RLS + gateway-only policy** on `student_notes`, `support_messages`, `math_contests`, `math_contest_entries`, `math_levels` | Close the critical hole (I1). This is draft §5, never applied. | Low (gateway connects as owner, bypasses RLS) |
| M2 | **`categories.program` accept `'math'`** (extend CHECK/enum if constrained) | Lets Math content exist as a program, excluded from CCAT/NGAT by default | Low (additive value) |
| M3 | **`support_cases.site_id`** (text, default `'ccat'`, backfill, FK→`sites`) | Scope support to Math | Low (additive, defaulted) |
| M4 | **`ccat.teacher_programs`** (`teacher_admin_id`, `program`), backfill existing teachers → `ccat` | First-class teacher↔program membership (§8) | Low (new table + backfill) |
| M5 *(only if D1-B)* | **`ccat.student_programs`** + identity unification | Unified student membership | **High** — changes shipped Math account model |
| M6 *(verify)* | Finalise `students.site_id` `NOT NULL` + default `'ccat'` if not already | Consistency with draft §2 | Low — **confirm current state first** |

**Not recommended:** draft §3 (`site_id` on content tables) — superseded by M2 (`program='math'`). Keep it only if §14-D2 overrides to the site_id model.

---

## 12. API / backend plan (gateway)

**Reuse (extend `'ngat'` handling to accept `'math'`):** `admin-content.ts`, `admin-content-authoring.ts`, `admin-students.ts`, `assignments.ts`, `bookmarks.ts`, `catalog.ts` — anywhere that currently does `program === 'ngat' ? 'ngat' : 'ccat'`, broaden to accept `'math'`. **Keep the `'ccat'` default** so mobile/un-updated clients are untouched.

**New (Math admin surface), mirroring `admin-teacher.ts`'s `requireSite` pattern:**
- `admin-support.ts` *(new)* — list Math cases, get thread, post staff message, set state. Gated `requireSite(req,'math')` + a support permission.
- Math workspace dashboard KPIs endpoint (optional, like `admin-teacher.ts` dashboard).
- Teacher program-membership read/write (extend `admin-teacher.ts` or `admin-accounts.ts`) for `teacher_programs`.

**Frontend `lib/api.ts`:** broaden the `program?: 'ccat' | 'ngat'` type to include `'math'`; add Math support client methods.

**Render:** no infra change — same gateway, same env. New routes register in the existing Fastify app. Confirm no new required env vars (Math reuses CCAT PayPal/entitlement config per memory).

---

## 13. Frontend page / component plan (Web Admin)

| Page/Component | Action | Source |
|---|---|---|
| `components/Layout.tsx` | Add `math` to `SITE_NAMES` + `railForSite`; add `MATH_RAIL`; show Math in the site switcher (gate on `admin_sites`/super-admin) | edit |
| `lib/auth.tsx` | Allow `activeSite='math'`; when Math active, pin `program='math'` | edit |
| `pages/Content.tsx`, `ExamPapers.tsx`, `ImportQuestions.tsx` | Accept `program='math'` from workspace; style per Content mockup | reuse/edit |
| `pages/Students.tsx`, `StudentDetail.tsx` | Scope to `site_id='math'`; per-student calls with `program='math'` | reuse/edit |
| `pages/Teachers.tsx`, `TeacherDirectory.tsx` | Program chips (CCAT/NGAT/Math) via `teacher_programs` | reuse/edit |
| `pages/Support.tsx` | **New** — two-pane Math support console per Support mockup | new |
| `lib/api.ts` | Broaden `program` type; add support methods | edit |
| `App.tsx` | Add `/support` route; Math rail routing | edit |

All new UI uses the existing design tokens/classes (the mockups already use the live palette: `#0F1B33` rail, `#1A5EAB` brand, `#E8A020` accent).

---

## 14. Role & permission plan

- New permission(s): e.g. `math.support.manage` (and reuse `student.directory`, `content.*`, `teacher.*` with site scoping). Confirm naming against `ccat.permissions` (41 rows today).
- `requireSite(req,'math')` guards all Math-admin routes; `requirePermission` for the action.
- Grant the `math` site to specific admins via `ccat.admin_sites` (currently 4 rows, all `ccat`). Super-admins already reach it.
- Teacher-role accounts: unchanged lock model; program pinned to `math` in the Math workspace.

---

## 15. Deployment impact

- **Render (gateway):** redeploy with new routes + broadened program handling. No new service, no DB connection change. **Confirm env vars** — expect none new.
- **Vercel (Web Admin):** redeploy `apps/admin`. No new env expected.
- **Vercel (Math student web):** **unaffected** by this build (separate deployment).
- **Supabase:** run migrations M1–M4 (+ M6 verify) in order; M1 (RLS) should go first and is independent.
- **Order:** M1 (RLS) → M2/M3/M4 → gateway deploy → admin deploy. Each migration additive and reversible.
- **No GitHub push by Claude** — you handle all pushes.

---

## 16. Issues found

| # | Severity | Issue | Proposed fix |
|---|---|---|---|
| **I1** | 🔴 **Critical** | The 5 live Math tables (`student_notes`, `support_messages`, `math_contests`, `math_contest_entries`, `math_levels`) have **RLS disabled** — exposed to the Supabase anon/authenticated roles. (Supabase advisor flags this, plus 9 pre-existing CCAT tables.) | Migration **M1**: `enable + force RLS`, gateway-only policy (draft §5, never applied). Do **not** blind-enable without the policy or you lock the gateway out. |
| **I2** | 🟠 | The draft file `DRAFT_math_site_scoping.sql` is headed "NOT APPLIED" but §1/§2/§4 **are** in prod; §3/§5 are **not**. Source-of-truth drift. | `MATH_WEBADMIN_AUDIT.md` now records true state; update/retire the draft header. |
| **I3** | 🟠 | Content has **no site/program scoping for Math** today. If Math sets are created with `program='ccat'`, they **leak into CCAT content**. | Adopt `program='math'` (M2) **before** any Math content is authored. |
| **I4** | 🟡 | **No Student or Teacher mockups supplied.** Directive says reuse existing layout — done — but confirm that's acceptable vs. a bespoke Math layout. | Reuse `Students.tsx`/`Teachers.tsx`; flag for your confirmation (§17-D4). |
| **I5** | 🟡 | `support_cases` has **no admin console** and **no site column**; `support.ts` is student-only. | New `admin-support.ts` + `support_cases.site_id` (M3). |
| **I6** | 🟡 | `students.site_id` present but **backfill/`NOT NULL`/default not fully verified**; `admin_sites` has **no `math` grants** (normal admins can't see Math). | Verify/finish `site_id` (M6); grant `math` in `admin_sites` to chosen admins. |
| **I7** | 🟢 | Math student auth in `math.ts` is **OTP-free** and uses separate accounts — intentional per memory, but it hard-codes the separate-account model that D1 may revisit. | Resolve D1 before Students/Teachers code. |

---

## 17. Decisions needed from you (BLOCKING — nothing is assumed)

> Lead answers here; I'll lock them into a table like `NGAT_WEBADMIN_WORKFLOW.md §1` and only then write code.

**D1 — Student identity model (the big one).**
A. *(recommended)* Keep **Math accounts separate** (`site_id='math'`); "multi-program" = CCAT+NGAT share one account, Math is its own pool; add an admin **linked-people view** (match by guardian email/phone) to show cross-pool families. No student-login/migration churn.
B. **Unify** student identity + `student_programs` membership across all three — rewrites Math student-web auth and migrates data. Higher risk.
→ **A or B?**

**D2 — Math content scoping.**
A. *(recommended)* `program='math'` (reuse NGAT pattern; zero changes to existing CCAT/NGAT queries).
B. `site_id` on content tables (draft §3; touches every CCAT content query).
→ **A or B?**

**D3 — Teacher membership.** Approve new **`teacher_programs`** table + program chips (CCAT/NGAT/Math) on the Teachers page, default `{ccat}` for existing teachers? **Yes/No.**

**D4 — Students/Teachers UI.** Confirm **reusing the existing Web Admin Students/Teachers pages** (re-scoped) is acceptable, since no mockups were supplied? **Yes/No** (if No, supply mockups).

**D5 — Is Math a third workspace (site switch + own rail) or a program pill inside Practice Web (like NGAT)?** Recommendation: **third workspace** (matches the mockups + separate accounts). **Confirm.**

**D6 — RLS fix (I1) now?** Approve applying migration **M1** (enable + force RLS + gateway-only policy) as the first, independent step. **Yes/No.**

**D7 — Admin grants.** Which admin accounts should be granted the `math` site in `admin_sites` (super-admins already have it)?

---

## 18. What happens after you answer

1. Lock decisions into a table at the top of this doc.
2. Write migrations (M1 first) → review → apply to Supabase.
3. Gateway: broaden program handling + new Math-admin/support routes.
4. Admin: Math workspace + Content/Support pages + Students/Teachers re-scope.
5. Test (CCAT+NGAT regression first, then Math).
6. Update `MATH_WEBADMIN_AUDIT.md` at every change.
7. You push to GitHub.

*No implementation code is written until D1–D6 are answered.*
