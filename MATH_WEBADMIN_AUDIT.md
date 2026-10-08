# Math Olympiad ↔ Web Admin — Audit / Project Memory

**Repo:** `ccat-practice-app-development--new`
**Scope tracked:** changes in `D:\Concept Mastry Project\GitHub_CCAT App\ccat-practice-app-development--new` **and** `D:\Concept Mastry Project\Math Olympiad Web`.
**Purpose:** single reference so future debugging reads this file instead of re-scanning folders and old context.
**Update rule:** update this file **every time** code, files, or migrations change in either folder.

---

## Current project status

🟢 **Feature built end-to-end 2026-10-05.** Decisions D1–D4,D6,D7 locked; **D5 REVERSED** (see below). **Migrations 0059–0064 applied to prod.** Gateway: `program='math'` accepted (CCAT/NGAT unchanged), Math content API (admin-managed folders/sets), Support console, teacher-programs API, student list/create pool-scoped. Admin UI: **Math is a PROGRAM pill in the Practice workspace** (CCAT / NGAT / Math Olympiad) — Content page switches to the Math folder/track manager when Math is selected; Support page; Teachers program chips; Discount hidden for Math. **All issues I1–I7 resolved.**

> **D5 REVERSED (2026-10-05, user request):** Math is **NOT** a separate workspace. It is a **third PROGRAM** shown in the `ProgramPills` switcher inside the **Practice** workspace, alongside CCAT and NGAT. All programs share the Practice rail (Dashboard, Content, Students, Teachers, Support, Announcements, Audit); **Discount is CCAT+NGAT only** (hidden when Math is selected). The student-pool split still holds (Math students `site_id='math'`; CCAT+NGAT share `site_id='ccat'`) and is now driven by the program pill via the `X-Admin-Site` header, independent of site grants — so any Practice admin with `content.create` can manage Math (like NGAT, no allow-list).

⚠️ **Must do before deploy:** the device's `node_modules` has no installed deps, so **no full typecheck/build could run here**. All 21 changed files are **syntax-clean** (compiler transpile pass) and imports/types were manually verified, but run `pnpm install && pnpm -w typecheck` (or the gateway/admin build) locally before deploying. Math taxonomy is now **admin-created in the UI** (no seed needed).

**Locked decisions:** D1=A (separate Math accounts + linked-people view) · D2=B (content scoped by site_id) · D3=Yes (teacher_programs) · D4=reuse existing UI · D5=workspace · D6=RLS applied · D7=super-admins only (no admin_sites rows; bypass covers it).

---

## Change log

### 2026-10-08 (oo) — Fluid full-width layouts across all app UIs (Claude / Cowork)

Owner choice: **fluid full-width with a responsive side gutter**, **app pages only** (public landing/marketing pages left centered). Done centrally in each app's global CSS — no per-page edits. Gutter = `clamp(16px,4vw,64px)` so content never touches the screen edge and the margin grows on large monitors.
- **CCAT/NGAT student web** (`apps/web/src/theme.css`): removed the `--maxw` 720/900 cap on `.content`, `.appbar .inner`, `.inner-wide`, `.bm-bulkbar`, `.bm-review`; and the per-page caps `.home-a` (1240), `.content-wide` (1240), `.plan-wrap` (1400) + its appbar. All → `max-width:none` + clamp gutter. Reading/form blocks kept centered on purpose (`.session-content` 820 quiz, `.center-narrow` 440 login) — the PAGE is full-width, the card stays readable.
- **Admin console** (`apps/admin/src/theme.css`): `.page` 1200 cap → `max-width:none` + clamp gutter (every admin page now full-width; the Math content page already was via `.page:has(.mc-root)`). `.edbody` (single-question editor, 900) left centered intentionally.
- **Math Olympiad Web**: already fluid — its `<main>` is `flex:1` with no max-width cap, so no change needed.
**Deploy (user):** rebuild + deploy **web** and **admin** (vite). Math unchanged. CSS-only; no gateway/DB.

### 2026-10-07 (nn) — FIX Tests/Quiz tree 500 (deleted default folder) + responsive overlap (Claude / Cowork)

**BUG — `GET /v1/admin/math/tree?track=test` 500** (curriculum + study-materials were 200). Root cause: the auto default category ("All test papers" / "All quizzes") for a grade had `active=false` (it had been deleted). The tree handler's ensure-step looked only for an ACTIVE default, found none, and tried to INSERT a new row with the same unique `key` → unique-constraint violation → 500.
- **Immediate (live DB):** reactivated the 3 soft-deleted Math default categories (`active=true` where `key like 'math-%-all-%'`, track test/quiz) — Tests/Quiz load again on refresh, no redeploy needed.
- **Permanent (`apps/gateway/src/routes/admin-math-content.ts`):** ensure-step now finds the default regardless of `active`; reactivates it if soft-deleted, inserts only when truly absent (with `on conflict (key) do update set active=true` as a race-safety net). Needs gateway redeploy.

**UI — cards/overlap (`MathContent.tsx` MC_STYLE):** the panel at ~735px fell into the cramped mid grid (header labels + icon/badge/status overlapped). Raised the card breakpoint **720 → 980** (narrow widths now render as cards, not a squeezed grid), gave the first column a min width (sets 150/140, materials 180/160), and tightened the 980–1150 mid templates. Verified with a harness at 735/1050/1300: cards clean at narrow, table clean at mid, actions always visible, full-height preserved. Needs admin rebuild.

**Deploy (user):** redeploy gateway (ensure-step fix) + rebuild admin (responsive fix). The DB reactivation already unblocked Tests/Quiz now.
**Verify:** both files esbuild-clean; responsive harness screenshots confirmed.

### 2026-10-07 (mm) — Content page: full-height panel + responsive tables (all 3) (Claude / Cowork)

**Reported:** panel left dead space below; Publish/Retire/Delete were off-screen (fixed huge table min-width forced a horizontal scroll past the actions). Owner picked (via 2 rendered samples): **wide table → column-collapse at mid → cards on phone**, applied to **Study Material + Tests + Quiz**.
**`apps/admin/src/pages/MathContent.tsx`:**
- Full-height: root is `.mc-root` (flex column); injected `<style>` adds `.page:has(.mc-root){flex:1;min-height:0;display:flex;…;max-width:none;padding:16px 20px}` — the same `:has()` full-height hook the shell already uses for the calendar — so the panel attaches to the sidebar, the tab card, and the bottom of the viewport. Tables are flex:1 with an internal-scroll `.mc-tbody` and a sticky header.
- Responsive (CSS media queries, since inline styles can't): **≤1150px** hides low-priority columns (sets→UPDATED; materials→SIZE+UPDATED) and the grid retemplates; **≤980px** stacks the FOLDERS panel above the table; **≤720px** each row becomes a card (chips + full-width folder dropdown + full-size action buttons), no horizontal scroll.
- Both table renderers (`renderSetTable`, `renderMaterialTable`) rewritten from inline-grid to `.mc-*` classes; Publish/Retire/Delete (+ Preview/Edit/Reprocess) now always visible. Behaviour unchanged.
**Deploy (user):** rebuild admin app (vite). No gateway/DB changes. (Gateway checksum-fix redeploy from entry ll is already done — uploads work; see the 2 Draft PDFs.)
**Verify:** esbuild transpile OK; responsive pattern validated against the two rendered samples.

### 2026-10-07 (ll) — FIX study-material upload 500 + multi-file upload + chapter rename (Claude / Cowork)

**BUG (reported):** admin Add-material → signed upload + PUT succeeded (200) but `POST /v1/admin/math/study-materials` returned **500 Internal Server Error**. Cause: `ccat.content_assets.checksum_sha256` is **NOT NULL**, and the register insert omitted it → null-violation (whole tx rolled back, so no orphan rows; the signed source object stays in the bucket, harmless).
**Fix (`apps/gateway/src/routes/admin-study-materials.ts`):** compute `checksum` for the content_assets insert — inline path hashes the decoded bytes; signed path seeds a deterministic placeholder `sha256(storage_key)` (no bytes on hand at register) and the render job overwrites it with the real `sha256(source bytes)` once fetched. Insert now includes `checksum_sha256`. Needs a gateway redeploy.
**Enhancement 1 — multi-file upload (`MathContent.tsx` AddMaterialModal):** the file input is now `multiple`; selecting >1 file uploads each as its own material titled by its filename (description + chapter applied to all), with per-file progress. Single-file keeps the editable Title field.
**Enhancement 2 — rename chapter (`MathContent.tsx`):** each chapter row in the FOLDERS panel gets a pencil icon → `RenameFolderModal` → `api.mathRenameFolder` (existing endpoint) → refresh.
**Deploy (user):** redeploy gateway (checksum fix) + rebuild admin app (multi-file + rename). No DB/migration changes.
**Verify:** admin-study-materials.ts + MathContent.tsx pass esbuild transpile.

### 2026-10-07 (kk) — Study Material: Phase 2 STUDENT app wired (Math Olympiad Web) (Claude / Cowork)

**`Math Olympiad Web/src/screens/StudyMaterial.tsx`** — replaced the placeholder with the real screen: a responsive card grid of published materials (PDF/PPT badge, title, description, chapter chip, page count) + a full-screen **Viewer** that pages through the server-watermarked images. No download; `onContextMenu`/drag disabled, `pointer-events:none` on the image, keyboard arrows + Esc, "view only" labels. Honest limit noted in code: screen capture can't be blocked by a web app — the per-student watermark is the deterrent.
**`Math Olympiad Web/src/lib/api.ts`** — `studyMaterials()`, `studyMaterial(id)`, `studyPageUrl(id,n)` (auth-fetched blob URL for `<img>`; caller revokes).
**`Math Olympiad Web/src/lib/types.ts`** — `StudyMaterialItem` interface.
**Already correct, no change:** Test Prep (`api.catalog('test')`) and Quiz Arena (`api.catalog('quiz')`) — the gateway catalog joins sets on the student's grade across ALL categories, so they already span every chapter. Route `/material` already existed.

**Deploy (user-run):** rebuild + deploy Math Olympiad Web (vite, Windows). Still pending from earlier: gateway Docker redeploy (render packages) and admin app build. No DB changes this turn.

**Verify:** StudyMaterial.tsx, api.ts, types.ts pass esbuild transpile (cloud). Phase 1 + 2 code-complete; only the three user-run deploys remain.

### 2026-10-07 (jj) — Study Material + chapters: Phase 1 ADMIN UI (Content page rebuilt to mockup) (Claude / Cowork)

**Owner decisions this turn (AskUserQuestion):** inside a chapter, Tests/Quiz sub-tabs do FULL management, auto-filed to that chapter; curriculum-track question sets dropped from the page (user asked to delete Math curriculum sets from DB too); Study Material **Replace** NOT built (Delete + Add only).

**DB check:** queried the live DB for Math (site='math') curriculum-track question sets → **0 found** (only 2 empty Math curriculum categories, which are the chapters). So nothing was deleted — the destructive op was unnecessary; the 2 categories stay as chapters.

**`apps/admin/src/pages/MathContent.tsx` — rebuilt (609 lines) to `Content-Page-standalone.html`:**
- Four top tabs: **Curriculum · Study Material · Tests · Quiz Arena** (amber underline, same tab card + Grade dropdown as before).
- **Curriculum**: FOLDERS(chapters) panel + "+ add chapter"; selecting a chapter shows pill sub-tabs **Study Material / Tests / Quiz Arena**, each full-management and auto-filed to that chapter (`chapter_id`).
- **Study Material** (top tab): flat list of all materials across chapters; each row has a FOLDER dropdown (move chapter), Preview, Publish/Retire, Reprocess (when not ready), Delete; render-status chips (⏳ Processing / ⚠ Failed / state badge); auto-polls every 4 s while any material is processing.
- **Tests / Quiz Arena** (top tabs): flat set tables with a per-row FOLDER dropdown (`mathSetChapter`), plus the existing Bulk add / Upload set / Default-per-set / Edit / Publish / Delete (+ Tests time-limit column). Inside a chapter the same tables are scoped+filed to the chapter.
- **Add material modal**: file picker (PDF/PPT/PPTX) → `api.mathStudyUpload` (signed direct-to-bucket, base64 fallback) → register; title/description/chapter.
- **Preview modal**: pages through the watermarked images via `api.mathStudyPageUrl` (auth-fetched blob URLs, revoked on change). Reused SWR tree cache + grade dropdown; `fileSet`/`fileMaterial` optimistic.

**`apps/admin/src/lib/api.ts`** (merged over a concurrent user edit): `mathSetChapter`, `mathStudyList/UploadUrl/Register/Patch/Publish/Retire/Reprocess/Delete`, `mathStudyPageUrl` (auth blob), `mathStudyUpload` (full signed flow); `mathCreateSet` gained `chapter_id`.

**`apps/admin/src/components/BulkSets.tsx`**: threads `ctx.chapterId` into both exam/practice `createSet` bodies so bulk-created sets file into the chapter atomically (CCAT/NGAT pass nothing → unchanged).

**`apps/gateway/src/routes/admin-content-authoring.ts`**: `POST /v1/admin/content/sets` now accepts optional `chapter_id` and persists it on `question_sets` (null for CCAT/NGAT — non-breaking). This is the bulk-create path.

**Deploy (user-run):** admin app must be rebuilt (vite, on Windows — can't build in the Linux VM). Gateway redeploy (already required from entry ii) now also carries the content-authoring `chapter_id` change.

**Verify:** MathContent.tsx, api.ts, BulkSets.tsx, admin-content-authoring.ts all pass esbuild transpile (cloud). Not vite-built here (no Windows toolchain in the VM).

### 2026-10-07 (ii) — Study Material + curriculum-chapter restructure: Phase 1 BACKEND (Claude / Cowork)

**Scope:** Math Olympiad only (`program='math'`, `site_id='math'`). CCAT/NGAT untouched. Owner decisions: view-only files with the STRONGEST real hard-block (server-rasterized page images + per-student watermark — the raw file never reaches the browser; screenshots cannot be blocked by any browser, stated plainly to the owner); support **PDF + PPT/PPTX**; phase backend first.

**DB (live `cqzpzhdleqyrmedymypg`, applied via Supabase MCP; files in `packages/contracts/migrations/`):**
- `0066_math_study_material_and_chapters.sql` — `question_sets.chapter_id` (nullable → a curriculum category); new `ccat.study_materials` (grade-scoped, optional chapter, draft/published/retired), RLS enabled+forced+revoked like every Math table.
- `0067_math_study_material_render.sql` — `study_materials` render columns (`source_kind`, `page_count`, `render_state`, `render_error`, `pages_prefix`); provisions PRIVATE Storage bucket `study-secure` (public=false), guarded so the gateway migrate-runner skips it where it lacks storage privileges.

**Storage (`apps/gateway/src/services/storage.ts`):** `SupabaseStorage` gained a `private` mode (reads via the authenticated object route; `publicUrl()`→null). New `createSecureStorage()` → private `study-secure` (Supabase) or a local `secure/` subtree (dev). Public `assets` path unchanged. New config `secureStorageBucket` (`SUPABASE_SECURE_BUCKET`, default `study-secure`).

**Render pipeline (`apps/gateway/src/lib/studyRender.ts`, NEW):** `sourceKindOf`; `rasterizeSource` (pptx→pdf via LibreOffice headless, pdf→page PNGs via poppler `pdftoppm` @150dpi); `watermarkPng` (tiled rotated translucent identity watermark via ImageMagick `convert`, bounded tile cache). Renders run SERIALLY in-process (LibreOffice memory).

**Admin API (`apps/gateway/src/routes/admin-study-materials.ts`, NEW; registered in `app.ts`):** signed direct-to-private-bucket upload (`POST /upload-url`) so multi-MB files bypass the gateway's 16 MB JSON limit and never transit the student-data boundary; `POST /study-materials` (register + kick async render; dev base64 fallback); list (flat / by chapter / `none`=unassigned); patch (title/desc/move chapter); publish (blocked until render `ready`) / retire / reprocess / soft-delete (+best-effort object cleanup); watermarked admin page preview. Permission `content.create`; all audited.

**Student API (`apps/gateway/src/routes/math.ts`):** `GET /v1/math/study-materials` (published+ready, grade-scoped, ALL chapters, NO file URL), `/:id` (meta), `/:id/pages/:n` (watermarked PNG, `no-store`). Test Prep / Quiz Arena already span all chapters (catalog joins on grade, not chapter), so `chapter_id` is admin-organisational only.

**Sets↔chapters (`apps/gateway/src/routes/admin-math-content.ts`):** set-create accepts optional `chapter_id` (validated as a curriculum chapter); new `PATCH /v1/admin/math/sets/:id/chapter` files a set in/out of a chapter; tree `sets` now carry `chapter_id`.

**Infra (`apps/gateway/Dockerfile`):** run stage installs `poppler-utils`, `libreoffice-impress`, `libreoffice-core`, `imagemagick`, `fonts-dejavu-core`, `fonts-liberation` (heavy layer, cached independent of app code). ImageMagick is used ONLY for PNG compositing (PDF via poppler), so the default IM PDF-policy restriction is irrelevant.

**Deploy (user-run, not done here):** the gateway Docker image must be **rebuilt** (new system packages) and redeployed on Render; migrations are already applied to prod. No admin/student UI yet — Phase 1 admin Content-page rebuild + Phase 2 student wiring are next.

**Verify:** all new/edited gateway files pass esbuild transpile (cloud). Gateway runs via `tsx` (transpile-only — no type-check at boot), so syntax-clean = boots. Device-VM `tsc` can't resolve `@types/node` through Windows pnpm symlinks (environment, not code). DB columns + private bucket confirmed on the live DB.

### 2026-10-06 (hh) — Teacher Admin (Math Olympiad) restyled to the Teacher_Admin mockup (Claude / Cowork)

Scope confirmed with the user: **Math Olympiad program only** (CCAT/NGAT unchanged). Two parts, admin-only:

- **Teacher sidebar (`components/Layout.tsx`).** New `TEACHER_MATH_RAIL` = Students / Test Prep / Quiz Arena / Support as solid-colour chips (mockup tones: amber/orange/green/blue). Used when `me.is_teacher && program === 'math'`; CCAT/NGAT teachers keep Students / Practice / Exam. Nav mapping per the user: Test Prep → the timed exam tool (`/teacher-exam`), Quiz Arena → the practice tool (`/teacher-practice`), Support → `/support` (already program-aware). Fixed the Support double-inject guard so the Math rail doesn't duplicate it.
- **Student Detail (`pages/StudentDetail.tsx`), Math branch only.** New `MathStatsGrid` renders the mockup's 7 white stat tiles with colour dots — Status (badge), Grade, Age (computed), XP, Coins, **Test Prep done** (= exam/test papers), **Quiz done** (= practice sets); the existing `.stats` row stays for CCAT/NGAT. Section labels for Math: Assignments→**Homework**, Battery Practice→**Quiz Arena**, Exam Progress→**Test Prep**, and the Assign-sets modal toggle Practice/Exam→**Quiz Arena/Test Prep**. All gated on `program === 'math'`; the underlying data hooks, assignment endpoints and panels are reused unchanged (no backend work).

`tsc --noEmit` clean + `esbuild` transforms clean for both files. **Deploy admin (Vercel).** No gateway/DB change. (Not changed: deeper pixel polish of the assignment table / progress cards — the existing panels already carry this data and function; can refine further on request.)

---

### 2026-10-06 (gg) — Admin sidebar: solid-chip icons (Practice workspace) per mockup (Claude / Cowork)

Restyled the Practice-workspace rail to the `Sidebar-Solid-Chips` mockup: each nav item now shows a full-colour circular chip (32px) with a white glyph instead of an emoji, keeping the existing navy rail, white active pill, hover-expand, and footer. Per-item tones/paths from the mockup — Dashboard #2FA86A, Content #1A5EAB, Students #E8A020, Teachers #D4620E, Announcements #E8A020, Audit log #9A8CE0, Membership #2FA86A, Support (Math) #4FA3E3.

Implementation: `RailItem` gains optional `svg`/`tone`; added them to `BASE_RAIL`, the Membership item, and the Math `SUPPORT_ITEM`; the rail renders a `.rchip` chip when both are present, else the old emoji. **TeacherHub & teacher-only rails are untouched** (their items have no `svg`/`tone`, so they keep emoji). CSS scoped with `:has(.rchip)` so chip sizing/height apply only to chip items — no effect on TeacherHub. Files: `components/Layout.tsx`, `theme.css`. `tsc` clean + `esbuild Layout.tsx` transforms clean (full vite build runs on the Windows checkout; the Linux device VM has no usable vite). **Deploy admin (Vercel).** No gateway/DB change.

---

### 2026-10-06 (ff) — FIX: Test Prep list showed 100 min instead of admin's 30 (Claude / Cowork)

The Test Prep list card showed "100 questions · 100 min" — `TestPrep.tsx` computed the shown limit as `question_count` (1 min/question), ignoring the set's `duration_minutes`. (The in-run timer was already fixed in (bb)/(cc); this was only the list display, which reads the catalog, not the session.) Fixes:
- **Gateway `math.ts`** — `GET /v1/math/catalog` now selects and returns `sv.duration_minutes` per set.
- **Student type (`.../lib/types.ts`)** — `CatalogSet.duration_minutes?: number | null`.
- **`.../screens/TestPrep.tsx`** — card minutes = `duration_minutes` when set, else 30 (matching the admin default and the runner fallback), instead of question count.

With duration backfilled to 30 (cc), the card now reads "100 questions · 30 min". `tsc` clean (gateway + student). Note: an in-progress Resume session started before the gateway change keeps its old `started_at`; since the clock is now 30 min, a long-idle resume may auto-submit — Restart gives a fresh 30:00. **Deploy gateway (Render) + student site (Vercel).** No admin/DB change this entry.

---

### 2026-10-06 (ee) — HOTFIX: (dd) broke the admin build (App.tsx ContentSwitch) (Claude / Cowork)

`pnpm --filter @ccat/admin build` failed with `esbuild … App.tsx: Unexpected "}"`. The (dd) edit that added `CcatContentOnly` accidentally replaced the whole `ContentSwitch` function (not just appended after it), deleting its body and leaving a stray `}`. Restored `ContentSwitch` (`const { program } = useAuth(); return program === 'math' ? <MathContent /> : <Content />;`) above `CcatContentOnly`. Verified with `tsc --noEmit` (0 errors) **and** a direct `esbuild App.tsx` transform (the same step that failed) — both clean. (The vite "cannot find module" seen when building inside the Linux device VM is just missing `node_modules` there; the Windows checkout builds fine.) All (dd) behaviour unchanged. **Deploy admin (Vercel).**

---

### 2026-10-06 (dd) — FIX: Math program showing CCAT UI at /content/exams; set name now opens editor (Claude / Cowork)

Two issues, admin-only (`App.tsx`, `MathContent.tsx`), no gateway/DB change.

1. **Math program sometimes showed CCAT content UI.** `/content` is program-aware (`ContentSwitch` → `MathContent` for Math, else `Content`), but the CCAT-only content subroutes rendered unconditionally — so landing on **`/content/exams`** (CCAT "Exam papers") while the Math program was selected showed the CCAT batteries UI; clicking into `/content` then re-rendered the switch and showed Math. Fix: new `CcatContentOnly` wrapper redirects Math → `/content` for `/content/exams`, `/content/import`, and `/content/plans` (pages with no Math equivalent). Switching the program pill to Math while on one of those routes now auto-redirects too. CCAT/NGAT see those pages exactly as before.

2. **Clicking a set name now opens it for view/edit.** In the Math sets table the set name was static; it now opens the same `SetEditor` as the Edit button (`onClick → setEditId`, pointer cursor + hover underline, disabled until taxonomy loads).

`tsc` clean (admin). **Deploy admin (Vercel).**

---

### 2026-10-06 (cc) — FIX: student test showed 100 min while admin showed 30 (Claude / Cowork)

Admin TIME LIMIT column showed **30** but the student paper ran **99:50 (~100 min)**. Cause: the 6 existing Math test sets predate (bb), so their `duration_minutes` was **null** in the DB — the admin "30" is only a display default (`s.duration_minutes ?? 30`) and was never saved; the student clock then hit the 1-min/question fallback (100 questions → 100 min). Also the gateway change from (bb) that returns `duration_minutes` must be live for the student to receive it.

Fixes:
- **Data backfill (live DB `cqzpzhdleqyrmedymypg`)**: `update ccat.question_set_versions set duration_minutes=30` for all Math `track='test'` versions where null — the 6 Set 1–6 rows now hold 30, matching the admin display. Non-destructive (only filled nulls).
- **Student fallback (`Math Olympiad Web/src/components/SetRunner.tsx`)**: exam fallback when `duration_minutes` is unset changed from `questions.length` (1 min/q) to a flat **30 min**, matching the admin default — so an unset value can never again diverge to 100.

After this, with the (bb) gateway live, `practice/start` returns 30 and the student paper runs 30:00. New sets already default to a stored limit (Upload 30 / bulk examDur), so nulls shouldn't recur. `tsc` clean (student app). **Required deploys to make the 30 show up: gateway (Render) — the (bb) change returning `duration_minutes` — and student site (Vercel) for the fallback.** No admin/schema change this entry. CCAT/NGAT unaffected.

---

### 2026-10-06 (bb) — Tests: time limit now ENFORCED for students (Claude / Cowork)

Made the admin-set per-paper time limit real end-to-end (follow-up to (aa)). Correction to (aa)'s flag: Math test sets **already ran as timed exams** — `SetRunner.tsx` has a countdown + auto-submit, and exam mode is driven by the category's `track='test'` (`isExamTrack` in `math.ts`), not the `allowed_exam` flag. The only gap was the clock used a hardcoded **60s/question** instead of the admin's `duration_minutes`.

Changes:
- **Student runner (`Math Olympiad Web/src/components/SetRunner.tsx`)** — exam deadline now = `started_at + duration_minutes·60s`, falling back to 1 min/question when unset (back-compat; identical to old behaviour for the existing null-duration sets). Still anchored to server `started_at`, so it survives reloads and auto-submits at zero.
- **Student type (`.../src/lib/types.ts`)** — `PracticeSession.duration_minutes?: number | null`.
- **Gateway `math.ts`** — `POST /v1/math/practice/start` looks up the set version's `duration_minutes` for exam sets and returns it in the session payload.
- **Gateway `admin-math-content.ts`** — Upload-created test sets are now proper timed exams: `allowed_timers=['timed']` (was `'[]'`) and `duration_minutes` defaults to **30** (was null).
- **Admin `MathContent.tsx`** — bulk importer gets `exam={track === 'test'}`, so Bulk add sets on the Tests tab creates timed exam sets (with the importer's per-paper minutes, default 25) instead of untimed practice.

Flow: admin sets/edits each paper's limit in the (aa) TIME LIMIT column (persists via `patchSet`) → student's timed run uses exactly that. Existing 6 test sets (duration null) keep the 1-min/question fallback until the admin sets a limit in the column — no destructive migration. `tsc` clean for admin, gateway, and the student app. **Deploy gateway (Render) + admin (Vercel) + student site (Vercel).** CCAT/NGAT unaffected.

---

### 2026-10-06 (aa) — Math Content: editable TIME LIMIT (MIN) column, Tests track only (Claude / Cowork)

Added a **TIME LIMIT (MIN)** column to the sets table that shows **only on the Tests tab** (Curriculum/Quiz unchanged). Per-row editor = number input + ▲/▼ steppers (±5, clamped 1–180, defaults to 30 when unset). Edits persist via the existing program-agnostic `api.patchSet(setVersionId, { duration_minutes })` (PATCH `/v1/admin/content/sets/:id`), applied optimistically to `folders` + the SWR tree cache, reverting on error. Gateway `GET /v1/admin/math/tree` now returns `sv.duration_minutes` in each set row. `MathContent.tsx` (new `TimeLimitCell`, `isTest`/`cols`/`tableMinWidth`, `commitDuration`) + `admin-math-content.ts` (one column added to the sets select). `tsc` clean for admin + gateway.

**Known gap (flagged, not changed — standing "ask me" rule):** Math test sets are currently created as **untimed practice** sets (`allowed_exam=false`, `allowed_timers=['untimed']`) and the student **Test** screen (`Math Olympiad Web/src/screens/TestPrep.tsx`) has **no timer**. So the time limit is stored/editable in admin but **not yet enforced for students**. Making it real needs: (1) Math bulk/upload to create test sets as timed exams, and (2) the student Test screen to honor `duration_minutes`. Awaiting the user's go-ahead before wiring enforcement. **Deploy gateway (Render) + admin (Vercel).** CCAT/NGAT unaffected.

---

### 2026-10-06 (z) — FIX: Math bulk closed before showing Publish all / Done (Claude / Cowork)

The "Created N draft sets → Publish all / Done" screen was never visible in Math's bulk importer even though the shared `BulkSets` component renders it. Cause: `MathContent.tsx` passed `onDone={() => { setBulk(false); … }}`, but `BulkSets` calls `onDone()` immediately after creating the sets — so the modal closed before the created step could show. `onDone` is a refresh hook, not a close hook (CCAT's `Content.tsx` passes `onDone={load}`). Fixed to match CCAT: `onClose={() => { setBulk(false); reloadFresh(); }}` (the modal's own Done/Cancel closes + refreshes) and `onDone={reloadFresh}` (refresh only, no close). Per-row Publish, Publish all, and Done now appear for Math exactly as in CCAT. `MathContent.tsx` only; `tsc` clean. **Deploy admin (Vercel).** No gateway/DB change.

---

### 2026-10-06 (y) — Math Content: performance — tree SWR cache, parallel queries, request cancel (Claude / Cowork)

Fixed "too many requests / revisiting a grade reloads all its sets, too slow." Three changes (A+B+C of the proposed set):

- **A — client SWR cache (`MathContent.tsx`).** Module-level `treeCache` keyed by `track:gradeId`. On revisit the view paints instantly from cache (no full-screen spinner) while a fresh copy loads in the background and updates. Invalidated on every mutation (`act` row actions, SetEditor save, Bulk/AddFolder/NewSet `onDone` → new `reloadFresh()`), so data stays correct.
- **B — parallel gateway queries (`admin-math-content.ts`).** The tree's categories + subcategories + sets reads now run in one `Promise.all` instead of three serial `await`s — one trans-Pacific round trip instead of three (~2.1s → ~0.7s per fresh load). Ensure-default-folder step still runs before it.
- **C — request cancellation (`api.ts` + `MathContent.tsx`).** `req()` and `api.mathTree()` take an optional `AbortSignal`; `loadTree` aborts the previous in-flight tree fetch on each track/grade switch and on unmount, and only applies the response if it's still the current request. Removes the stacked/duplicate `tree?track=…` calls and fixes stale-overwrite races. `AbortError` is swallowed.

Not touched (standing/optional): default-folder SELECT still on the test/quiz hot path (D); `question_sets(category_id,grade_id)` index (E); **Seoul DB region (F) remains the absolute-latency ceiling — each remaining round trip is still ~200ms; only a NA-region move fixes that.** `tsc --noEmit` clean for admin + gateway. CCAT/NGAT unaffected. **Deploy gateway (Render) + admin (Vercel).**

---

### 2026-10-06 (x) — Math Content: Tests & Quiz Arena rebuilt flat to match mockups (Claude / Cowork)

Made the **Tests** and **Quiz Arena** tabs match `Tests-Page-standalone.html` / `Quiz-Arena-Page-standalone.html`: the left **FOLDERS** panel is hidden (Curriculum keeps it), the sets list goes full-width, and the breadcrumb reads **Tests → All test papers** / **Quiz Arena → All quizzes** instead of a folder name. Empty-state copy for these tabs now says "Use Bulk add sets or Upload set to get started" (no "add a folder").

Decision (asked, per standing rule): **Auto default folder**. Because the backend still requires a category per set, the gateway `GET /v1/admin/math/tree` now auto-creates/reuses **one** hidden default category per grade for `track='test'|'quiz'` (named "All test papers" / "All quizzes", key `math-<track>-all-<gradeId>`, idempotent existence-check before insert). So Bulk add / Upload "just work" with no folder picker, and the student catalog joins by category as before. Curriculum is untouched (real topic folders).

Files: `apps/admin/src/pages/MathContent.tsx` (derived `showFolders`/`crumbChild`, panel wrapped in `{showFolders && …}`), `apps/gateway/src/routes/admin-math-content.ts` (ensure-default block in the tree handler). DB verified live (`cqzpzhdleqyrmedymypg`): Math had folders only for Curriculum; Test/Quiz had zero — the default folders are created lazily on first view. `tsc --noEmit` clean for admin + gateway. **Deploy gateway (Render) and admin (Vercel).** CCAT/NGAT unaffected.

---

### 2026-10-06 (w) — Math Content: "Default per set" stepper added by Bulk add sets (Claude / Cowork)

Added the **DEFAULT PER SET** stepper (−/value/+) to the breadcrumb line, left of **Bulk add sets**, matching CCAT. Uses the same persisted helpers from `components/BulkSets` (`loadDefaultPerSet`/`saveDefaultPerSet`, clamped 1…`PER_SET_CEILING`=100, ±5 steps). The value is remembered (localStorage) and pre-fills "Questions per set" when the Math bulk importer opens. `MathContent.tsx` only. Syntax-clean, no gateway/DB change. **Deploy admin (Vercel).**

---

### 2026-10-06 (v) — Math Content: Delete / Retire are now one-click (removed confirm dialogs) (Claude / Cowork)

User request: remove the browser confirm prompts on Delete and Retire — act on one click. Removed the `window.confirm` messages passed to `act()` for both the **Retire** and **Delete** row actions in `MathContent.tsx` (the `confirmMsg` param remains in `act` but is no longer used). Publish/Copy were already one-click. Syntax-clean. Frontend only, no gateway/DB change. **Deploy admin (Vercel).**

---

### 2026-10-06 (u) — FIX: Requests/notifications dropdown rendered behind Math Content cards (z-index) (Claude / Cowork)

🔴 **Bug:** on the Math Content page, opening the header **Requests** (notifications) dropdown rendered it **behind** the Content cards (grade pill / folders).
**Root cause:** `theme.css` `.topbar` is `position: sticky; z-index: 5`, which caps the whole header — including the notifications dropdown — at stacking level 5. The Math Content tabs card (added in entry o) used `position: relative; zIndex: 15`, creating a stacking context **above** the topbar, so the Math content painted over the dropdown. CCAT/NGAT pages are unaffected (their content sets no z-index above 5).
**Fix (`MathContent.tsx`):** removed `position: relative; zIndex: 15` from the tabs+grade card (kept `overflow: visible`). The grade dropdown is `position: fixed` (viewport-positioned via `getBoundingClientRect`), so it still floats above the table/topbar without the card being a stacking context. Scoped to Math only; no shared CSS touched, no change to CCAT/NGAT.

Syntax-clean. Frontend only, no gateway/DB change. **Deploy admin (Vercel).**

---

### 2026-10-06 (t) — FIX: Publish blanked the table; removed Copy; actions on one line (Claude / Cowork)

🔴 **Bug: clicking a row's Publish "blanked the screen" then published.**
**Diagnosis (complete):** the per-row action handler `act()` called `loadTree()`, which sets the page `loading` flag → the **entire sets table** is replaced by a single "Loading…" line. Publish is **slow** — the gateway publish route validates every member question inside a transaction, over the trans-Pacific link to the **Seoul DB** (the user's Network tab showed the `publish` request at **3.02s**). So the table stayed blanked for ~3s+ (publish + tree refetch) before the row flipped to Published. Not a crash (no error boundary exists, and the set did publish) — it was the `loading` wipe over a slow request. The 3s latency itself is the DB-region issue (standing infra fix).

**Fix (`apps/admin/src/pages/MathContent.tsx`, frontend only):**
- `loadTree(silent?)` added; row actions (`act`) now call `loadTree(true)` — **silent refetch that does NOT toggle the page loading state**, so the full table stays visible. Only the clicked row shows busy (disabled buttons) during the call. No more blank.
- **Removed the Copy action.** Row actions are now **Edit · Publish/Retire · Delete**, and the actions cell is `flexWrap: nowrap` so they stay on one line (was wrapping Delete to a second line).

Syntax-clean. No gateway/DB change. **Deploy admin (Vercel).** (Publish will still take ~3s until the DB moves to a NA region — that's latency, not the blank.)

---

### 2026-10-06 (s) — Math Content: Publish button blue + bulk Publish-all/Done confirmed (Claude / Cowork)

- **Publish action button is now blue** (`#1A5EAB` filled), distinct from **Retire** which stays amber (`components` row actions in `MathContent.tsx`). Added a `primary` variant to the row's `actBtn`; the button uses `primary` when the set is draft (Publish) and `warn` when published (Retire). Matches the CCAT content row (image 2).
- **Bulk "Publish all / Done" screen:** no change needed — the reused shared `BulkSets` component already ends with the "Created N draft sets" screen (per-set Publish + Publish all + Done), identical to CCAT (image 1). It appears whenever the bulk create succeeds.

Syntax-clean. Frontend only, no gateway/DB change. **Deploy admin (Vercel).**

**Flagged (not changed, per "don't break CCAT/NGAT"):** the generic `POST /v1/admin/content/sets` (used by BulkSets) doesn't set `site_id`, so bulk-created Math sets get the column default `'ccat'` while their `category_id` is a Math category. They still appear correctly in the Math tree and student catalog (both join by **category** program/site, not the set's `site_id`) — it's a cosmetic mislabel only. One-line fix if wanted: in that handler derive `site_id` from the category (`select site_id from ccat.categories where id=$1`) and pass it into the `question_sets`/`question_set_versions` inserts — CCAT/NGAT categories resolve to `'ccat'` so they're unchanged.

---

### 2026-10-06 (r) — Math Content: folder-add moved to FOLDERS panel icon + Bulk add sets (CCAT parity) (Claude / Cowork)

User request on the Math Content page: remove the top-right **+ Add folder**, add an **add icon** in the FOLDERS panel to create folders, and put **Bulk add sets** where Add folder was (same as CCAT's bulk).

**Changes (`apps/admin/src/pages/MathContent.tsx`, frontend only):**
- FOLDERS panel header now has a **＋ icon** (right of the "FOLDERS" label) that opens the Add-folder modal. The top-right **+ Add folder** button is removed.
- Top-right now shows **⤓ Bulk add sets** (next to Upload set). It reuses the shared **`components/BulkSets`** — the exact CCAT bulk importer (same `parseImportText`, same split-into-sets flow).
- **Bulk context for Math:** `catId` = the selected folder, `subId` = '' (cat-only mode, no subfolder required), `qType` = `'math'` (free-text column, no constraint — verified), `maxPerSet` = `PER_SET_CEILING`. Button is disabled until a specific folder is selected (tooltip "Select a folder first"); "All folders" is not a valid bulk target.
- **Difficulty decision (user): default to Medium.** No difficulty picker added to Math; the bulk importer tags every created set/question with the **Medium** difficulty from `api.taxonomy('math')` (falls back to the first difficulty if 'medium' is absent). Keeps the Math UI clean; all Math content is one difficulty.

Syntax-clean. No gateway/DB change. **Deploy admin (Vercel).**

**⚠️ Smoke-test after deploy:** BulkSets was built for CCAT — confirm a Math bulk run (paste questions → Parse & check → Preview split → create) actually creates sets under the chosen Math folder and that they appear in the Math tree (sets are created via the generic content pipeline; they attach to the math category, so the Math tree — which joins by category program/site, not set.site_id — should list them). If created sets don't show, check that the generic `createSet` sets `site_id`/track consistently for the math category.

---

### 2026-10-06 (q) — FIX grade order (all programs) + Math Content page redesigned to the admin mockup (Claude / Cowork)

**1) Grade dropdown order wrong (Grade 1 after Grade 2) — all programs + teacher admin.**
🔴 Root cause: **data, not code.** `ccat.grades.display_order` was wrong — Grade 2 = `0`, Grade 1 = `1`, Grade 3 = `1`. Every admin content grade dropdown orders by `display_order`, so it rendered 2,1,3,4… everywhere. Fix (one-time data update on LIVE DB `cqzpzhdleqyrmedymypg`): `update ccat.grades set display_order = grade_number`. Now 1→12 across all programs and teacher admin. **No code change, no deploy — just refresh.**

**2) Math Content page rebuilt to `Content-Page-Admin_standalone.html`** (`apps/admin/src/pages/MathContent.tsx`, frontend only):
- Tabs relabeled **Curriculum / Tests / Quiz Arena** (tracks curriculum/test/quiz) with amber active underline.
- **GRADE pill** kept (fixed scrollable dropdown from entry o).
- **FOLDERS tree (left panel)** from `mathTree` — folders with per-folder set counts, selectable (active = blue), plus an "All folders" row. Breadcrumb `{track} → {folder}`.
- **Sets table** columns **SET · QUESTIONS · STATUS · UPDATED · ACTIONS**: set name (blue) + folder/subfolder subtitle; QUESTIONS as `{count} / 100` with an amber progress bar; status badge; updated date.
- **Actions wired to the existing program-agnostic set endpoints:** Edit → reuses the shared `components/SetEditor` with the **Math taxonomy** (`api.taxonomy('math')`) to author questions; Publish/Retire → `api.publishSet` / `api.retireSet` (label flips on state, Retire confirms); Copy → `api.copySet`; Delete → `api.deleteSet` (confirms). `+ Add folder` / `Upload set` modals unchanged. Stat-cards row dropped to match the mockup.

✅ **This also closes the gap flagged in entry (p):** there is now an in-page path to **author + publish** a Math set — create set → **Edit** (add questions via SetEditor) → **Publish**. Combined with (p)'s published-only catalog, published Math sets will now appear in the student app.

Syntax-clean; omitted `SetEditor` props are all optional. **Deploy admin (Vercel).** No gateway/DB change for part 2.

---

### 2026-10-06 (p) — FIX: admin Math content (folders/sets) never showed in the student web app (Claude / Cowork)

🔴 **Bug:** folders/sets created in Web Admin → Practice → Math → Content did not appear in `math-olympiad-web` (student) for Curriculum or Test.

**Diagnosis (admin side works; the student READ path was broken in 5 layers):**
1. `GET /v1/math/catalog` was a **hardcoded stub returning `[]`** — Curriculum & Quiz Arena always empty.
2. `catalog()` took **no track param** — Curriculum / Quiz / Test couldn't be separated; they'd show identical content.
3. Student Curriculum renders **sets grouped by folder**, so an **empty folder shows nothing** (the user's "Number System" folder, Grade 2, had 0 sets).
4. Admin sets are created `state='draft'`, `question_count=0`; the student catalog (like CCAT) shows **published only** → a fresh set won't show until authored + published.
5. **`TestPrep.tsx` was a static "coming soon" page** — made no API call, so Test could never show content.

**Decision (user):** show **only folders that contain published sets** → **published-only** (hide drafts & empty folders).

**Fix:**
- **Gateway `apps/gateway/src/routes/math.ts`:** implemented `GET /v1/math/catalog?track=curriculum|quiz|test`. Returns the student's-grade, `program='math'`/`site_id='math'`, `cat.track=<track>` sets where `sv.state='published'` **and** the version has active questions (mirrors the CCAT catalog publish gate). Maps to the client `CatalogSet` shape. Grouping by `category` client-side ⇒ only folders with ≥1 published set appear.
- **Student `Math Olympiad Web`:** `api.catalog(track?)` now sends `?track=`; `Curriculum.tsx` → `catalog('curriculum')`, `QuizArena.tsx` → `catalog('quiz')`; **`TestPrep.tsx` rewritten** to fetch `catalog('test')` and render folders/sets like Curriculum (with its empty state).

All syntax-clean. **DB:** no change. **Deploy:** gateway (Render) + the student site (Vercel).

**⚠️ To actually SEE content (published-only):** a folder alone is not enough. The admin must (1) add a **set** to the folder, (2) **author questions** into it, (3) **publish** it (`publishSet` → `POST /v1/admin/content/sets/:id/publish`, which exists and is program-agnostic). The user's empty "Number System" folder correctly stays hidden until it has a published set. **Open UX gap (not built, not requested):** the Math Content page (`MathContent.tsx`) only creates folders + empty draft sets — it does not yet expose question authoring or a publish button for Math. Until that's wired (or the generic Content editor is used for Math sets), there's no in-page way to author+publish a Math set. Offer to build Math authoring/publish next.

---

### 2026-10-06 (o) — FIX: Math Content GRADE dropdown clipped (no scroll) + "Grade Grade 2" label (Claude / Cowork)

🔴 **Bugs (Web Admin → Practice → Math → Content):** (1) opening the GRADE pill showed a dropdown that **couldn't scroll** — only the top was visible; (2) the pill read **"GRADE Grade 2"** (duplicated "Grade").

**Root causes:** (1) the dropdown was `position: absolute` inside the tabs+grade card, which has `overflow: hidden` — the ancestor **clipped** the popover, so its `maxHeight/overflowY` never took effect and the list (12 grades) was cut off. (2) `ccat.grades.name` is already "Grade 2" … "Grade 12", and the pill also prepended a "GRADE" caption → "GRADE Grade 2".

**Fix (`apps/admin/src/pages/MathContent.tsx`, frontend only):**
- Dropdown now renders with **`position: fixed`**, anchored to the trigger via `getBoundingClientRect()` (new `gradeBtnRef` + `gradePos` state, computed in an `openGrade()` handler). Fixed positioning escapes the card's `overflow:hidden`, so the full list scrolls (`maxHeight: min(60vh,360px)`, `overflowY:auto`). Backdrop closes it; closes on window resize.
- Removed the redundant "GRADE" caption from the trigger → shows just **"Grade 2"**. Placeholder "Select grade" when none chosen. Added `aria-haspopup/expanded/role=listbox`.

Syntax-clean. No gateway/DB change. **Redeploy admin (Vercel).**

**Samples:** delivered `grade-dropdown-samples.html` (3 interactive variants — Sample 1 = clean pill "Grade 2" (implemented); Sample 2 = labelled "GRADE 2"; Sample 3 = 4×3 grade grid, no scroll). Awaiting user's pick; will swap to 2 or 3 if preferred.

---

### 2026-10-05 (n) — FIX: support chat didn't update without a manual refresh (live polling) (Claude / Cowork)

🔴 **Bug:** after (m) connected the threads, new messages only appeared after a page refresh on **both** apps — no live update.

**Root cause:** neither Support UI polled. Student app (`Math Olympiad Web/src/screens/Support.tsx`) fetched messages once when the thread opened; admin (`apps/admin/src/pages/Support.tsx`) fetched the thread only on open and after sending. The clients talk to the Fastify gateway, not Supabase directly (the RLS pattern revokes `anon`/`authenticated`), so Supabase **Realtime is not available to them** — polling is the right mechanism.

**Fix (frontend only, no gateway/DB change):** poll every **5s** while the Support view is open (user choice; trades responsiveness vs load on the Seoul DB).
- **Student app:** the messages effect now loads on open + `setInterval(load, 5000)`, cleaned up on unmount/thread-change (guarded with an `alive` flag). Auto-scroll changed to fire **only when the message count grows** (via a `prevLen` ref), so a poll doesn't yank the view while the student reads history.
- **Admin app:** added a 5s interval that refreshes the student list (unread badges / last-message) **and** the open thread (`supportThread(selId)`), skipping the thread poll while a send is in flight (`!busy`), cleaned up on unmount. No forced scroll on poll.

**Note:** polling frequency interacts with the latency issue in (m) — each poll is a trans-Pacific round-trip. Fine at today's volume; after the DB region move, 5s is comfortable. If load becomes a concern before then, raise the interval or add a cheap "any messages since <ts>?" head-check endpoint.

**Changed:** `Math Olympiad Web/src/screens/Support.tsx`, `apps/admin/src/pages/Support.tsx`. Both syntax-clean. **Redeploy both frontends** (Vercel): the student site (`math-olympiad-web`) and the admin app.

---

### 2026-10-05 (m) — FIX: student ↔ admin support chat not connected + perf diagnosis (Claude / Cowork)

🔴 **Bug:** messages sent by the student (math web app) and by staff (admin Support console) did **not** appear to each other — two disconnected threads. Proven in live DB: student `"Hello Ma'am"` was stored with `case_id = student_id` (`7c16ad36…`), staff `"hi"` with `case_id = support_cases.id` (`098600d9…`).

**Root cause:** the student math support endpoints in `apps/gateway/src/routes/math.ts` keyed `ccat.support_messages` on the **raw `student_id`**, while `apps/gateway/src/routes/admin-support.ts` keys on the **get-or-created `ccat.support_cases.id`** (site='math'). Different keys ⇒ never the same thread.

**Fix (gateway code):** rewrote the three student support endpoints to use the **same shared model** as admin — one Math `support_cases` row per student (`site_id='math'`), get-or-created from either side; both read/write `support_messages` by `case_id`. Mirrors the existing `support.ts` pattern (student-filed cases, `opened_by=null`). Helpers added: `mathSupportRef()` (collision-checked `SUP-xxxxxx`), `mathCaseId(studentId, create)`. `GET …/messages` resolves the case (no create, returns `[]` if none); `POST …/messages` get-or-creates then inserts `sender='student'`. Shape unchanged (`{id, me, text, at}`). One file: `math.ts`, syntax-clean.

**Fix (one-time data repoint, applied to LIVE DB `cqzpzhdleqyrmedymypg`):** moved orphaned student-keyed messages onto the student's Math case. Only **1** orphan existed (Child A's `"Hello Ma'am"`); now both messages share case `098600d9…`. Verified 0 orphans remain. SQL: create a math case for any orphan math student lacking one (none needed), then `update support_messages set case_id = <student's latest math case> where case_id is a math student_id and not an existing case`.

> **⚠️ Deploy ordering:** the data repoint + the code change must go live together. The **old deployed** gateway reads the student thread by `student_id`; since the orphan moved to the case id, the student app shows the thread **empty until the gateway is redeployed**. After redeploy both sides show both messages.

**🔎 Performance / speed diagnosis (asked by user):**
- **Primary cause (confirmed): DB region.** Live Supabase project `cqzpzhdleqyrmedymypg` is in **`ap-northeast-2` (Seoul)**. Users + the Render gateway are in North America (GTA). Every query is a **trans-Pacific round-trip** (~150–250ms each — general-knowledge estimate, unverified for this link). Endpoints that run several sequential queries therefore take ~1–2s even when warm. This dominates everything else.
- **Gateway region / plan (unverified — I can't query Render):** if the Render service is on a free/starter tier it **spins down when idle**, adding a multi-second cold-start to the first request. Check the Render plan and region. Co-locate the gateway in the **same NA region** as the DB.
- **Indexes (secondary, not the current bottleneck):** Supabase perf advisor reports 91 unindexed foreign keys, incl. `support_cases.student_id` (the new support lookup filters on `student_id`+`site_id`). At today's data volume (hundreds of students, ~1 support case) these are **negligible** — not worth changing now. `support_messages.case_id` is already indexed, so the thread read is fine. Revisit indexes only after the region move, at scale.
- **The real fix is infrastructure (user action — cannot be done from the repo):** move the Supabase project to a **North-American region** (`ca-central-1` or `us-east-1`). Region can't be changed in place — either create a new project in the NA region and migrate data, or add a read replica there. Then co-locate the Render gateway in that same region. Expected effect: per-query latency drops from ~150–250ms to single-digit ms; multi-query pages go from ~1–2s to ~100–300ms. **No amount of code/index tuning substitutes for this.**

**Changed:** `apps/gateway/src/routes/math.ts` (support chat). **DB:** one-time data repoint on `cqzpzhdleqyrmedymypg` (no schema change, no migration). **Deploy the gateway (Render).**

---

### 2026-10-05 (l) — FIX: student web app showed "No teacher assigned yet" despite admin assignment (Claude / Cowork)

🔴 **Bug:** on `math-olympiad-web` (student app), the **Support & 1-on-1** page always showed *"No teacher assigned yet"* even when a teacher was assigned to that student in Web Admin.

**Root cause:** the student-facing endpoint `GET /v1/math/teachers` in `apps/gateway/src/routes/math.ts` was a **hardcoded stub**: `app.get('/v1/math/teachers', authed, async () => [] as unknown[])`. It returned an empty array for every student unconditionally — the UI was correct, the backend never returned data.

**Fix (gateway only):** wired the endpoint to the real assignment source — `ccat.teacher_students` (teacher↔student, managed on the Teachers page in Web Admin) joined to `ccat.admin_profiles` where `is_teacher=true`, filtered to the authenticated `req.student.studentId`. Returns `{ id, name }` matching the client `Teacher` type.

```sql
select p.id, p.display_name as name
  from ccat.teacher_students ts
  join ccat.admin_profiles p on p.id = ts.teacher_admin_id
 where ts.student_id = $1 and p.is_teacher = true
 order by p.display_name
```

**Decision (user, 2026-10-05):** show **ALL** assigned teachers regardless of account status — **no `status='active'` filter**. So a student whose only assigned teacher is `disabled` (e.g. Anaaya → Shweta Ma'am) still sees that teacher.

**⚠️ CORRECTION (entry m, same day):** the data-model note originally here was wrong — it was run against the **wrong Supabase project** (`wazutprwrhnabjfggghp`, the `ap-northeast-1` project, which has no Math migrations and no `support_messages`). **The LIVE database both apps use is `cqzpzhdleqyrmedymypg`** ("cm-whiteboard", `ap-northeast-2` Seoul — see entry j). Against the LIVE DB: `ccat.students` **does** have a `site_id` column; Child A **exists** (`7c16ad36-77c5-43cd-a71c-24ffc382bbce`, `site_id='math'`) and is assigned **Jyoti Ma'am** (active). The teacher-list fix is correct and is **confirmed working in production** (student app now shows Jyoti Ma'am). Always use project **`cqzpzhdleqyrmedymypg`** for SQL/migrations on these apps (also recorded in memory `topics/supabase.md`).

Syntax-clean. **One file changed:** `apps/gateway/src/routes/math.ts`. No DB/migration change. **Deploy the gateway (Render).**

---

### 2026-10-05 (k) — Math Content page restyled to the mockup (Claude / Cowork)

`pages/MathContent.tsx` rebuilt to match `Content-Page-standalone.html` as closely as possible, keeping the admin-managed folder/set model (backend unchanged — `mathGrades`/`mathTree`/`mathCreateFolder`/`mathCreateSet`):
- White **tabs card** (Curriculum / Quiz / Test with line icons) + a rounded **GRADE pill dropdown** (custom popover), exact mockup styling/colors.
- Row of **stat cards** (SETS · PUBLISHED · IN PROGRESS · FOLDERS).
- **Sets table** card: header title/subtitle + **Upload set** (blue) and **+ Add folder** buttons; columns `SET · GRADE · ITEMS · UPDATED · STATE` with the mockup's state badges (Published/In review/Scheduled/Draft/Retired). Folder (and subfolder) shown as the set's subtitle.
- Sets are flattened from the folder tree for the table; creating a set uses a small modal (pick/〈+ New〉 folder, optional subfolder, name); Add folder uses a modal.

Syntax-clean. No gateway/DB change. Deploy admin.

---

### 2026-10-05 (j) — ROOT CAUSE of slowness: DB is in Seoul; + Support thread one-query (Claude / Cowork)

🔴 **Root cause of the slow admin, confirmed:** the Supabase project `cqzpzhdleqyrmedymypg` (name "cm-whiteboard") is in region **`ap-northeast-2` (Seoul, South Korea)**. Users + the Render gateway are in Canada (GTA). Every DB query is a **trans-Pacific round-trip (~180–250ms each)**, so any endpoint running several queries takes ~1–2s even when warm. This is why every page is slow, not a cold start.

**The real fix is infrastructure (user action — I can't move a project's region):**
1. **Move the database to a region near the users** — `ca-central-1` (Montréal) or `us-east-1`. Supabase can't change an existing project's region, so: create a new project in that region, migrate the schema + data (dump/restore), repoint the gateway's `DATABASE_URL`, and cut over. (This is a bigger migration than the earlier wazut→cqzp move but the same shape.)
2. **Host the Render gateway in the same region as the DB** — co-locating gateway+DB removes the multiplier (the gateway makes many queries per request; each one currently crosses the Pacific).
3. Until then, the parallelization + single-query work below is the only in-code mitigation; it cannot beat physics.

**Code mitigation this round:**
- `routes/admin-support.ts` — the thread read (`/support/students/:id/thread`) was 3 sequential queries → now **ONE query** (student + case + messages via `json_agg` lateral). Saves ~2 trans-Pacific round-trips per open.
- `pages/Support.tsx` — guard so clicking the same student doesn't re-fire the (slow) thread request (the latency was provoking repeat clicks → multiple `thread` calls).

Syntax-clean. The big win is the region move; the code changes only trim round-trips.

---

### 2026-10-05 (i) — Support redesign (message-anyone) + Math-only + remove Gamification (Claude / Cowork)

Decisions confirmed with user before building: list = **all/assigned students (message anyone)**; **Math Olympiad only**; keep **unread badges**, drop quick-action chips + INC tag; teachers see **assigned students only**.

**Gateway — `routes/admin-support.ts` rewritten** (now student-centric, Math-only):
- `GET /v1/admin/support/students` — lists Math students (`site_id='math'`); super-admin/admin → all, **teacher → only assigned** (`teacher_students`). Each row: last message, sender, time, and **unread** (= student messages since the last staff reply).
- `GET /…/students/:id/thread` — student + their Math case (if any) + messages; `assertStudentVisible` enforces teacher scope; no create on read.
- `POST /…/students/:id/messages` — staff message; **creates the case on first contact** (get-or-create), then appends. Lets staff message anyone.
- `POST /…/students/:id/state` — open/closed (kept; UI doesn't surface it).
- Gated `student.directory` + per-student `assertStudentVisible` (so teachers can reply to their assigned students). Scope hardcoded to `SITE='math'`.

**Admin frontend:**
- `pages/Support.tsx` — rebuilt to the mockup (image 3): left = searchable student list with avatar, name, `Grade · Math Olympiad`, last-message preview, time, **unread badge**; right = chat thread (student/staff bubbles) + `Message the student…` + Send + Open profile. No chips, no INC tag.
- `lib/api.ts` — support methods replaced: `supportStudents`, `supportThread`, `supportSend`, `supportSetState(studentId,…)`.
- `components/Layout.tsx` — **removed Gamification** from the rail; **Support injected only when the Math program is selected** (admins: after Teachers; teachers: appended). Not shown under CCAT/NGAT or TeacherHub.
- `App.tsx` — removed all `/gamification/*` + `/rewards/*` routes; added `/support` to the **teacher-role** route block.
- `pages/Dashboard.tsx` — removed the Super-Admin control link to `/gamification/economy` (the one reachable dead link).

All changed files syntax-clean. Run `pnpm -w typecheck` + rebuild/redeploy gateway + admin before testing. (Gamification page files remain in the repo but are unrouted/unreachable.)

---

### 2026-10-05 (h) — Perf: parallelize hot endpoints (slow load) (Claude / Cowork)

Admin pages were slow because the heaviest endpoints ran many **sequential** DB queries — each one a full round-trip to a far/cold gateway+DB. Collapsed them into single parallel batches (identical output):
- `routes/admin-students.ts` — `/students/:id/detail` ran ~11 independent reads one-after-another → now ONE `Promise.all` batch (≈2.3s → ~1 round-trip).
- `routes/admin-dashboard.ts` — `/dashboard` ran ~11 aggregates sequentially → now ONE `Promise.all` batch.
- `routes/admin.ts` — `/me` (gates every page) now fetches profile + teacher-programs in parallel.

These cut the gateway↔DB latency that dominates page load. (Trade-off: a handful of concurrent queries per request — fine for low-frequency admin pages and the pooled connection.)

**Remaining factor = infrastructure (not code):** the live symptoms (multiple requests each 1.5–2.4s, timelines spanning seconds) point to a **cold / far Render gateway**. The free/starter tier spins down after ~15 min idle, so the first hit after idle cold-starts (tens of seconds). To fix the "slow first load":
1. Point an uptime monitor (e.g. UptimeRobot / cron) at **`GET https://ccat-gateway-payment.onrender.com/health/live`** every 5–10 min to keep it warm (public, no auth, no DB), **or**
2. Use a Render plan without spin-down.
3. Confirm the Render service and the Supabase project are in the **same/nearby region** (the user is in the GTA) — cross-region gateway↔DB round-trips multiply every query's latency.

Syntax-clean. Run `pnpm -w typecheck` + rebuild/redeploy gateway before measuring.

---

### 2026-10-05 (g) — Teacher accounts: restrict program pills to assigned programs (Claude / Cowork)

A teacher-role account (`is_teacher`) must only see/switch the programs assigned to it on the Teachers page (`ccat.teacher_programs`), not all three.
- `routes/admin.ts` — `/v1/admin/me` now returns `programs` (the account's `teacher_programs`).
- `lib/auth.tsx` — `Me.programs`; new `allowedPrograms` (teacher → assigned, default `['ccat']`; non-teacher → all three); the active program is **clamped** to an allowed one after auth resolves (a teacher whose remembered program isn't assigned lands on their first allowed program).
- `components/ProgramPills.tsx` — renders only `allowedPrograms`; hides entirely for a single-program teacher (nothing to switch). Non-teacher admins unchanged (all three).

Syntax-clean. Run `pnpm -w typecheck` + rebuild admin before deploy.

---

### 2026-10-05 (f) — Fix: Students showed all CCAT under Math; remove in-page program switcher (Claude / Cowork)

**Bug (Students showed the full CCAT pool under the Math program):** root cause was a frontend timing bug, not the scoping SQL (which was correct). The API client seeded `adminSite` (the `X-Admin-Site` pool signal) from the *site* key (`ccat_admin_site` = 'ccat'), not the program, so the first Students fetch on a fresh load/navigation went out as `ccat` before the auth effect could correct it — returning all CCAT students. **No student data touched** (CCAT accounts are a live paid service — read/scoping only).
- `lib/api.ts` — `adminSite` now seeded synchronously from the program (`ccat_admin_program === 'math' → 'math'`; TeacherHub → `teacher`), so the first request already carries the right pool.
- `lib/auth.tsx` — `setProgram` updates `adminSite` **synchronously** on switch (no reliance on effect ordering).
- `components/Layout.tsx` — page `<Outlet>` keyed by `activeSite:program`, so switching the program pill **remounts and refetches** the current page with the new pool.

**Content page — removed the in-page program switcher** (redundant with the global top-bar PROGRAM pill): `pages/Content.tsx`, `pages/ExamPapers.tsx`, `pages/ImportQuestions.tsx` (removed `<ProgramPills/>` + imports; the top-bar pill in `Layout` remains).

**Verify after deploy:** if Math still shows the CCAT pool after redeploying the **admin** app, confirm the **Render gateway** actually deployed commit `0bb26ac` (the `site_id` filter lives there). Both apps must be on that commit. Syntax-clean; run `pnpm -w typecheck` locally before deploy.

---

### 2026-10-05 (e) — Math as PROGRAM (not workspace) — D5 reversed (Claude / Cowork)

User: Math should be a program pill in the Practice workspace (CCAT / NGAT / Math Olympiad), not a separate workspace. All programs share dashboard/Teacher/Audit/etc.; Discount is CCAT+NGAT only.

**Admin frontend:**
- `components/ProgramPills.tsx` — now 3 options (CCAT / NGAT / **Math Olympiad**), status dot per option.
- `lib/auth.tsx` — `program` state is `ccat|ngat|math`; **removed Math from the site switcher** (no Math workspace). `X-Admin-Site` now derived from the program (Math→`math`, else `ccat`; TeacherHub keeps `teacher`), so the student/support pool follows the program pill.
- `components/Layout.tsx` — removed `MATH_RAIL`/Math workspace; **added Support to the Practice rail**; render a labelled **PROGRAM** pill row in the Practice top bar (non-teacher admins).
- `App.tsx` — `/content` → `ContentSwitch` (Math program ⇒ `MathContent`, else `Content`); removed `/math*` routes; kept `/support`.
- `pages/Dashboard.tsx` — Discount control hidden when program = Math.

**Gateway:**
- `routes/admin-math-content.ts` — dropped `requireSite('math')`; gated by `content.create` only (Math is a program like NGAT, no site grant needed).
- `routes/admin.ts`, `admin-students.ts`, `admin-support.ts` — student/support **pool derived from the raw `X-Admin-Site` header** (`math` vs `ccat`), independent of site grants — fixes non-super admins (who lack a `math` site grant) seeing the wrong pool.

**Verification:** all changed files syntax-clean (`ts.transpileModule`). Still no full tsc (no deps on device) — run locally before deploy. No new migration (0059–0064 unchanged; the `math` row in `ccat.sites` is retained only as the FK target for `site_id='math'`).

---

### 2026-10-05 (d) — Admin-managed taxonomy + full frontend pass (Claude / Cowork)

**Decision refinement (Math taxonomy):** NOT seeded. Admin creates the tree in the UI — three **tracks** (Curriculum / Quiz / Test), and per **grade**, **folders** (categories) + **subfolders** (subcategories) + **sets**.

**DB:** `0064_math_category_tracks.sql` applied — nullable `track` + `grade_id` on `categories` (Math-only; CCAT/NGAT rows NULL). CHECK `track in (curriculum,quiz,test)`.

**Gateway (new/edited):**
- **New** `routes/admin-math-content.ts` — Math taxonomy API: grades, tree(track,grade), create/rename/delete folder + subfolder, create set. All `program='math'`,`site_id='math'`; gated `requireSite('math')`+`content.create`. Registered in `app.ts`.
- `routes/admin.ts` — students **list/lite/stats** scoped by workspace (`site_id`); non-Math workspaces map to `'ccat'` (CCAT/TeacherHub unchanged), Math → `'math'`.
- `routes/admin-students.ts` — new students created with `site_id = activeSite` (math workspace → math).
- `routes/admin-support.ts` — site helper mapped to `math`-or-`ccat`.

**Admin frontend (new/edited):**
- `lib/api.ts` — sends `X-Admin-Site` header (`setAdminSite`); Math/support/teacher-program methods; `program` type widened to include `'math'`.
- `lib/auth.tsx` — Math site for super-admins (D7); `program` pinned to `'math'` on the Math workspace; `setAdminSite` synced.
- `components/Layout.tsx` — `SITE_NAMES['math']='Math Olympiad'`, `MATH_RAIL`, `railForSite`, switcher → `/math/content`, URL→site sync.
- `App.tsx` — routes `/math/content`, `/support`.
- **New** `pages/MathContent.tsx` — track tabs + grade selector + folder tree + add folder/subfolder/set (Content mockup).
- **New** `pages/Support.tsx` — two-pane student-messaging console (Support mockup).
- `pages/Teachers.tsx` — Programs column with CCAT/NGAT/Math chips (D3).

**Verification:** 21 files syntax-clean via `ts.transpileModule`; imports/usage manually cross-checked; the `X-Admin-Site` regression risk (TeacherHub student list) closed by the non-Math→ccat mapping. **Full tsc/build NOT run** (no deps on device) — run locally before deploy.

---

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
