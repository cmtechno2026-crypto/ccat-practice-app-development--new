# CCAT Web Admin — Overview

> Concept Mastery's central **web admin** (the "Admin Web") — the control panel staff use to run the
> company's online learning properties. Today it drives the **CCAT Practice App** (student website +
> mobile), and it is built to grow into the shared admin for the company's other web properties.
> This document is the map: what the admin is, how it's put together, and where each thing lives.
> Read it before changing the admin or adding a feature. Its companion, **ADMIN_IMPROVEMENTS.md**,
> holds the how-to-extend playbook and the feature backlog.

_Last updated: 2026-09-21._

---

## 1. What this admin is for

The Admin Web is a single, permissioned back office for staff. From it they:

- manage **students** (accounts registered on the CCAT website): search, view detail, suspend, delete, reset PIN, create accounts, and see when each registered;
- author and publish **content** — practice sets and exam papers, per grade / battery / subcategory / difficulty, including bulk import;
- run **memberships / plans** (free, $49, $99, $199 tiers) and record paid or complimentary grants with expiry;
- configure **gamification** — achievements, avatar/theme customization, and the coins/XP economy;
- publish **announcements** and manage the **book store**;
- manage **grades**, feature **flags**, **admin accounts & permissions**, and read the **audit log**;
- watch **service health** and operational status.

**"Multiple websites."** The admin is the company's back office, not a single site's CMS. It currently
owns the CCAT Practice property end-to-end; the same account model, permission system, content model, and
membership engine are the foundation for bringing Concept Mastery's other sites under one admin. See
ADMIN_IMPROVEMENTS.md → "Multi-site direction" for how that extension is intended to work.

---

## 2. System shape (where everything runs)

Monorepo, pnpm workspaces. Four apps + shared packages:

| Part | Path | Stack | Deploys to |
|---|---|---|---|
| **Admin Web** (this) | `apps/admin` | Vite + React + TypeScript (SPA) | **Vercel** |
| **Student website** | `apps/web` | Vite + React (SPA) | **Vercel** |
| **Gateway API** | `apps/gateway` | Fastify + `pg` + Zod (ESM) | **Render** |
| **Mobile** | `apps/mobile` | (React Native) | app stores |
| Shared code | `packages/` | `api-client`, `client-core`, `contracts`, `shared` | consumed by apps |
| **Database** | — | Supabase **Postgres**, schema **`ccat`** (project ref `wazutprwrhnabjfggghp`) | Supabase |

Data flow: **Admin Web → Gateway API → Supabase**. The admin never talks to the database directly; every
action is an authenticated call to the gateway, which enforces permissions and writes to `ccat`.

Deploy rule of thumb after a change:
- touched `apps/admin` (or `apps/web`) → redeploy that app on **Vercel**;
- touched `apps/gateway` → redeploy on **Render**;
- schema/data change → applied on **Supabase** (SQL / migration), no redeploy needed for the DB itself.

---

## 3. Authentication & permissions

- Staff sign in with **work email + password** (`POST /v1/admin/auth/login`). No MFA; 5 failed attempts
  lock the account for 15 minutes. Success returns a **bearer JWT** kept in `sessionStorage`.
- Every gateway admin route is guarded by `requirePermission(req, '<key>')` (or `requireSuperAdmin`).
  `super_admin` holds **all** permissions implicitly.
- The admin UI hides controls the signed-in admin lacks (`can('<key>')` from `useAuth`), but the
  **gateway is the real gate** — hiding a button is not security.

**Permission keys in use** (grouped):

- Content: `content.create`, `content.edit`, `content.publish`, `content.retire`, `content.review`
- Students: `student.directory`, `student.update`, `student.suspend`/`unsuspend`, `student.ban`/`unban`,
  `deletion.support`, `student.deletion.override`, `device.revoke`, `device.break_glass`
- Gamification: `achievement.manage`, `avatar.manage`, `theme.manage`, `reward.adjust`
- Comms: `announcement.manage`, `announcement.publish`, `push.request`, `push.approve`, `book.manage`
- Governance: `admin.manage`, `grade.manage`, `flags.emergency`, `config.global`,
  `audit.read.global`, `audit.export.self`

Admin accounts, roles, and per-account permissions are managed on the **Admin accounts** page (`/admins`,
`admin.manage`).

---

## 4. Navigation & pages

Primary rail (left) → sections; some sections have sub-tabs. Off-rail pages are reached from the header.

| Rail / page | Route | Page component | Gateway routes | Purpose |
|---|---|---|---|---|
| Dashboard | `/` | `Dashboard.tsx` | `admin-dashboard.ts` | KPIs, at-a-glance health |
| Content · Practice | `/content` | `Content.tsx` | `admin-content.ts`, `admin-content-authoring.ts` | Practice sets by grade/battery/sub/difficulty; bulk add; default-per-set |
| Content · Exam papers | `/content/exams` | `ExamPapers.tsx` | same | Single-battery timed exam sets |
| Content · Import | `/content/import` | `ImportQuestions.tsx` | `admin-content-authoring.ts` | Scoped bulk question import |
| Content · Learning plans | `/content/plans` | `LearningPlans.tsx` | `admin-content.ts` | Learning-plan config |
| Students | `/students`, `/students/:id` | `Students.tsx`, `StudentDetail.tsx` | `admin-students.ts`, `admin.ts` | Directory, detail, status, PIN reset, delete, create, membership |
| Gamification · Achievements | `/gamification/achievements` | `Achievements.tsx` | `admin-rewards.ts` | Achievements |
| Gamification · Customization/Themes | `/gamification/customization`, `/themes` | `Customization.tsx` | `admin-rewards.ts` | Avatars, themes |
| Gamification · Economy | `/gamification/economy` | `CoinsXp.tsx` | `admin-economy.ts` | Coins/XP economy |
| Book Store | `/books` | `Books.tsx` | `admin-comms.ts` | Book catalog + retailer links |
| Announcements | `/announcements` | `Announcements.tsx`, `Push.tsx` | `admin-comms.ts` | In-app announcements, push |
| Audit log | `/audit` | `Audit.tsx` | `admin.ts` | Audit trail, CSV export |
| Service health | `/health` | `Health.tsx` | `admin-ops.ts` | Health, jobs, providers |
| Admin accounts | `/admins` | `Admins.tsx` | `admin-accounts.ts` | Staff accounts, roles, permissions |
| Config · Grades | `/config/grades` | `Grades.tsx` | `admin-config.ts` | Grades (add/edit) |
| Config · Flags | `/config/flags` | `Flags.tsx` | `admin-config.ts` | Feature flags |
| Config · Membership | `/config/membership` | `Membership.tsx` | `admin-entitlements.ts` | Manual plan grants (only when `PAYMENTS_ENABLED`) |

Shared admin components: `Layout.tsx` (rail, header, requests bell), `BulkSets.tsx` / `BulkImport.tsx`
(bulk authoring), `SetEditor.tsx` / `SetsView.tsx` / `RenameSetName.tsx` (set editing),
`QuestionEditor.tsx`, `GamTabs.tsx`, `ui.tsx` (Modal, toasts, ErrorBox). The typed API client is
`apps/admin/src/lib/api.ts`; auth/permissions in `apps/admin/src/lib/auth.ts`.

---

## 5. Data model highlights (schema `ccat`)

Only the parts the admin touches most; not exhaustive.

- **students** — one row per account. Rich detail is assembled from lateral lookups (readiness,
  progress, devices, streaks, last-active). **Ledgers are append-only** (`xp_transactions`,
  `coin_transactions`, `student_achievements`, `student_status_events`, `consents`) with
  mutation-forbidding triggers, so a student **cannot be hard-deleted**. "Delete" = **purge**
  (anonymize name/username/birth, `status='purged'`, drop credentials/guardians, scrub devices),
  and purged rows sort to the bottom of the directory. `created_at` drives the registration-date
  grouping in the list.
- **grades** — `ccat.grades`; the student website only offers a grade at signup when it has ≥1 published
  practice set in **all three** batteries (verbal, quantitative, non-verbal) — the `practice_ready` rule.
- **subcategories** — `max_questions_per_set` is the practice per-set cap (**currently 100**,
  column default 100).
- **question_sets / question_set_versions** — sets are versioned; `question_count` hard-bounded
  **0..100** by `set_versions_size_hard_bounds`. Exam sets are single-battery, timed, subcategory
  optional; the per-set cap is **100** for both practice and exam.
- **entitlements** — one row per guardian email. `tier` ∈ `free | t50 | t250 | t500` (internal keys,
  **never renamed**; shown as **Free / $49 / $99 / $199**). `current_period_end` is a **`date`**
  (no time) — a paid or manual grant to any paid tier sets it to **grant date + 1 year**; `free` = no
  expiry. `source` ∈ `manual | webhook`; `grant_reason` ∈ `paid | sale | discount | comp | trial | other`.
  Real charge amounts come from Render env `PAYPAL_PRICE_T50/T250/T500` — the admin's dollar labels are
  display only.
- **audit_log** — append-only; every governance action writes here; readable/exportable on `/audit`.

---

## 6. Conventions worth knowing

- **Never rename tier keys** (`t50/t250/t500`); only their displayed prices change.
- **Permission-gate every new admin action** on the gateway, then hide the UI with `can()`.
- **Optimistic concurrency**: student edits use `If-Match` against `students.version`; handle
  `VERSION_CONFLICT` by reloading.
- **Money/expiry**: expiry is a bare date; paid ⇒ +1 year; free ⇒ null.
- **Content caps**: 100 questions/set everywhere (DB constraint + gateway Zod + frontend ceilings).
- **Deletes of students are purges**, not row deletes — by design.

---

## 7. Quick file map

```
apps/admin/src/
  App.tsx                 # routes
  lib/api.ts              # typed gateway client (every endpoint)
  lib/auth.ts             # login, permissions (can())
  lib/payments.ts         # PAYMENTS_ENABLED flag
  components/Layout.tsx   # rail + header + requests bell
  components/BulkSets.tsx # bulk set authoring + per-set chooser
  pages/*.tsx             # one file per screen (see §4)

apps/gateway/src/
  routes/admin-*.ts       # admin API, grouped by area (see §4 table)
  routes/paypal-*.ts      # checkout + webhook (grants)
  lib/entitlements.ts     # tier resolution
  lib/paypal-grant.ts     # webhook grant (+1yr expiry)
  security/, plugins/adminAuth.ts  # auth, requirePermission
```
