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
- **`pages/Content.tsx`** — `ProgramPills` in the **toolbar row, left of "Bulk add sets"**; `api.sets(program)` + `api.taxonomy(program)`. On switch it refetches and resets only the subcategory — it does **not** null `tax`/`sets` or reset `grade` (grades are shared across programs), which avoids the blank-flash and keeps the pill from moving.
- **`pages/ExamPapers.tsx`** — same: `ProgramPills` in the toolbar row (left of "Bulk add sets"); on switch refetches + resets battery to `verbal`, keeps grade, no null-flash.

> **Fix (2026-10-01, post-first-deploy):** the pill was originally in the content-nav row and the switch nulled `tax`/`sets`/`grade`. That caused the pill to jump (the grade selector beside it vanished during reload) and a brief blank (sets resolved while taxonomy was still null → empty tree). Moved the pill to the always-present toolbar and made the switch non-blanking. **Redeploy `apps/admin` on Vercel to pick this up.**
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

---

## 8. Bulk-add upgraded for NGAT picture formats — Part A / B / C (2026-10-01)

The data model already supported image stems, image options, and **multiple** correct answers (`correct_option_ids` is an array). The bulk-add authoring path was upgraded to use them so the three NGAT Verbal picture formats can be transcribed verbatim from the booklet.

**Parser — `apps/admin/src/lib/importParse.ts`:**
- `Answer:` now accepts **one or more** labels, separated by `and`, comma, `&` or `/` — e.g. `Answer: 1 and 2` (Part C, which-two-go-together) as well as `Answer: C` / `Answer: 3`. Every label is validated against the present options. Multiple correct flow straight through `authorSet` → `correct_option_ids`.
- Option labels may be **letters (A–F) or numbers (1–6)** — the papers print options as 1–6, so they transcribe directly. Numbers are normalised to A–F by position; a letter and its matching number can't be used for the same slot.
- Image-only options (`1-Image: file.png`) and a question stimulus image (`Q-Image:`) work as before — Part A/C use six image options; Part B uses one stimulus image plus six image options.
- Unit-tested: single-letter, numeric, two-answer (`1 and 2` → two corrects), comma form, stimulus+numeric, and the invalid/no-answer error paths.

**Editor — `apps/admin/src/components/SetEditor.tsx`:** the per-option correct control changed from a **radio (single)** to a **checkbox (toggle)**, so a Part C set's two correct answers survive manual editing. Validation still requires ≥1 correct.

**Samples — `apps/admin/src/components/BulkImport.tsx`** (`FORMAT_TEXT` + `SAMPLE_FILE_TEXT`, shared by both bulk panels): rewritten with worked **Part A (odd-one-out), Part B (complete-the-pair), Part C (which-two-go-together)** examples, numbered image options, the multi-answer `Answer:` syntax, and the picture-paper rules. "Download sample" / "Copy format" now emit these.

**How to author an NGAT picture set in bulk:** Content → NGAT → Verbal → *Bulk add sets* → "Download sample", fill in the blocks (one stimulus image for Part B; `Answer: 1 and 2` for Part C), zip the text file with the option images (filenames matching the `-Image:` lines), upload, preview, create, publish.

### Downstream dependency — DONE (see §9)
Part C's two-answer rendering/scoring in the student app has now been built and fixed.

---

## 9. Part C student-app fixes (2026-10-01)

Three issues surfaced testing an authored NGAT Part C set; fixed at the real root cause (mostly student app, not the bulk tool):

1. **Could select more than two.** The gateway sent only `multi: true`, not how many to pick, so the client couldn't cap. Fixed: `apps/gateway/src/routes/sessions.ts` now also returns `multi_count` (the count of correct options — count only, never which); `packages/api-client/src/types.ts` gains `multi_count?: number`; `apps/web/src/screens/SessionScreen.tsx` caps selection at `multi_count` (can't pick a 3rd), shows "Pick 2 answers, then Check", and enables Check only when exactly that many are chosen.
2. **6th option had no letter.** `SessionScreen.tsx` had `KEYS = ['A','B','C','D','E']` — the 6th fell off. Fixed to include `F`.
3. **Black image tiles vs the clean paper look.** The asset uploader stores image bytes **unchanged** (no format conversion/flatten), so the black backgrounds are **baked into the source PNGs** that were uploaded — not added by the tool. Can't be stripped in code. Mitigations: question/option figures now render on a clean **white, padded tile** (`theme.css` `.q-figure` / `.opt-figure`) so correctly-sourced (white/transparent) images look like the paper; and the bulk format/sample (`BulkImport.tsx`) now tells authors to use clean white/transparent images (a black-background file stays black). **Action for you:** re-upload clean versions of the affected option images (kiwi, needle, thread, ant in that set) to remove the black.

**Redeploy for §9:** `apps/web` and `apps/gateway` (Render) — the multi-select cap needs both. `apps/admin` redeploy picks up the updated sample text.

---

## 10. Bulk image-upload reliability — cold-start retry (2026-10-01)

**Symptom:** bulk-creating a large figure set (e.g. 60 Part A questions × 6 images) failed with `POST /v1/admin/content/assets/batch` showing `(failed)` after ~25s, with the preflight taking ~13s. **Cause:** the gateway host (`ccat-gateway-payment.onrender.com`) had spun down; the slow preflight is the cold start, and the first heavy POST was dropped while the instance woke. The admin client's `fetch` has no timeout, so it surfaced as a dropped connection, not an HTTP error. Not a payload-size bug — the client already chunks uploads, and the downscaled WebP figures are small.

**Fix (`apps/admin/src/lib/bulkFile.ts`):** each upload chunk now **retries with backoff** (up to 3 retries, 2s/4s/8s) on transient failures (network error, 5xx, 429, 408); a 4xx throws immediately. The retry lands once the instance is up, so a cold start no longer fails the whole import. Chunk size lowered 30 → 20 images for lighter first requests. Applies to both bulk panels (Bulk add sets and Bulk add from file). **Redeploy `apps/admin`.**

> If a bulk upload still fails after this, the gateway instance may be down rather than merely cold — check the Render service `ccat-gateway-payment` is live (and that its `DATABASE_URL` points at the live DB `cqzpzhdleqyrmedymypg`). On a free/spun-down instance, simply retrying the Create once (now automatic per-chunk) warms it.

---

## 11. Bulk image-upload speed — dedup + parallel + preflight cache (2026-10-01)

**Symptom:** uploading a 360-image set ("Uploading 360 images…") took ~9.7 min across ~56 requests.

**Why so many requests:** 360 images were uploaded in sequential chunks of 20 (~18 `assets/batch` POSTs), and because the admin and gateway are different origins, **each POST pays its own CORS preflight** (the `OPTIONS` "preflight" rows), roughly doubling the count — plus the 60-second notification poll firing throughout. So: ~18 POST + ~18 preflight + notification polls ≈ 56.

**Fixes:**
- **Client `apps/admin/src/lib/bulkFile.ts`:**
  - **Content dedup** — images are now hashed (SHA-256) and **identical pictures upload once**, shared by every reference. A paper that reuses the same art across questions collapses hundreds of refs to a few dozen real uploads (the single biggest win).
  - **Parallel chunks** — chunks upload 3-at-a-time instead of one-by-one.
  - **Bigger chunks** — 20 → 40 images (10 MB) per request, so fewer round-trips. Retry/backoff retained.
- **Gateway `apps/gateway/src/app.ts`:** CORS `maxAge: 86400` — the browser caches the preflight for 24h, so the many chunk POSTs no longer each trigger an `OPTIONS`. Removes ~half the requests and the per-chunk preflight latency.
- **Gateway `apps/gateway/src/routes/admin-content.ts`:** `STORAGE_UPLOAD_CONCURRENCY` 10 → 16 — each batch stores more images in parallel.

**Also:** fewer, smaller source images help most. For odd-one-out/pair papers that reuse the same emoji, reuse the **same filename** (and bytes) across questions so both the client content-dedup and the server checksum-dedup skip re-uploading. Or split a very large battery into a couple of bulk runs.

**Redeploy:** `apps/admin` (Vercel) and `apps/gateway` (Render).

---

## 12. Direct-to-storage bulk upload (2026-10-01)

The real fix for large figure sets: the browser now uploads image bytes **straight to Supabase Storage** via short-lived signed URLs the gateway mints, so image bytes never pass through the Render instance (which was crashing/timing out buffering them). Chosen over "gentle/slower" and "bigger instance" for speed + reliability at any size.

**Flow:** client hashes + content-dedups images → `POST /v1/admin/content/assets/sign-batch` (gateway mints one signed URL per *new* image, returns existing asset for repeats) → browser `PUT`s each image directly to Supabase (bounded-parallel, retried) → `POST /v1/admin/content/assets/register` records the `content_assets` rows. Falls back automatically to the old server-batch path when the driver can't sign (local dev) or signing is unreachable.

**Files:**
- `apps/gateway/src/services/storage.ts` — `createSignedUploadUrl(key)` on the Supabase driver (REST `object/upload/sign`); local/unconfigured drivers return null (→ fallback).
- `apps/gateway/src/routes/admin-content.ts` — `sign-batch` (content.create-gated, checksum-dedup, gateway-generated `content/<uuid>.<ext>` keys) and `register` (content.create-gated, key-regex validated, checksum-dedup, inserts rows + public_url).
- `apps/admin/src/lib/api.ts` — `signAssetBatch`, `registerAssetBatch`.
- `apps/admin/src/lib/bulkFile.ts` — `uploadImages` rewritten: content-dedup → direct sign/PUT/register, fallback to server batch; `DirectUploadApi` type.
- `apps/admin/src/components/BulkSets.tsx` + `BulkImport.tsx` — pass the direct callbacks.

**Security guardrails (implemented):**
- Only `content.create` admins can mint URLs or register (same gate as before — doesn't widen who can upload).
- **Gateway generates the object key** (`content/<uuid>.<ext>`); client can't choose paths. `register` validates the key against `^content/<uuid>.(png|jpg|jpeg|webp)$`.
- Signed URLs are short-lived, single-object, one-time.
- **Live `assets` bucket locked** (applied to prod DB): `file_size_limit = 5 MB`, `allowed_mime_types = png/jpeg/webp`, public-read, **no anon write** (no RLS write policies → only the service key and signed tokens can write). This is the backstop that enforces size/type since the gateway no longer sees the bytes.
- **Trade-off (accepted):** the gateway no longer decodes images to validate real format/dimensions; that validation now rests on the bucket's MIME/size limits. Acceptable for a staff-only tool.

**Redeploy:** `apps/gateway` (Render) and `apps/admin` (Vercel). The bucket lockdown is already live.

> First-run check: the browser `PUT`s cross-origin to `*.supabase.co`. Supabase Storage allows CORS for signed uploads, so this should work; if a `PUT` is CORS-blocked, tell me and I'll add a PUT-failure fallback to the server batch path.

---

## 13. NGAT Verbal subcategory renames + Quant/Non-verbal with NO subcategory (2026-10-01)

**Verbal subcategory renames (live DB + migration `0054`):** Part A → **Picture Classification**, Part B → **Picture Analogies**, Part C → **Picture Pairs** (keys `part_a/b/c` unchanged, so content/import logic is unaffected). The `Verbal Battery Test` subcategory is unchanged.

**Quant & Non-verbal: sets attach directly to the battery, no subcategory** (admin + student + teacher). Verbal and all of CCAT are unaffected.
- **DB (live + migration `0057`):** their subcategories (`general`, `battery_test`) were set **inactive** — the taxonomy reads only active subcategories, so these batteries now expose none. (Used `UPDATE active=false`, not `DELETE`: a delete on `ccat.subcategories` hangs on this DB from an unindexed FK validation.)
- **Gateway `admin-content-authoring.ts`:** `createSet` now allows a **null subcategory** for a practice set *only when the category has no active subcategories* (CCAT/Verbal still require one). Per-set cap for such battery-level sets = the app ceiling (100).
- **Admin `Content.tsx`:** the category tree now shows subcategory-less batteries via a `cat:<id>` sentinel ("All sets"); set filtering, the New-set dialog, and Bulk-add all create/select with `subcategory_id = null`. `SetsView` (New set) hides the subcategory field and sends null when the battery has none. `BulkSets` sends null and scopes numbering to null-subcategory sets.
- **Admin/teacher browse `TeacherContent.tsx`:** the subcategory tab row is hidden when a battery has a single/empty group → battery → sets directly.
- **Student `PracticeScreen.tsx`:** a battery whose sets have no subcategory skips the category step and routes straight to the set list (`__sets__` sentinel + a redirect effect).

No content exists for Quant/Non-verbal yet, so this was a clean structural change. **Redeploy `apps/gateway` (Render) + `apps/admin` and `apps/web` (Vercel).** Can't typecheck over the mount — run the builds before deploy.

**Author-endpoint fix (422 on bulk-create into a subcategory-less battery):** two further blockers surfaced and were fixed:
- `apps/gateway/src/routes/admin-content-authoring.ts` — the `author` (batch question save) Zod schema required `subcategory_id` to be a UUID → **422**. Now `subcategory_id` is nullish, and the `logical_questions` insert passes `null` when absent.
- DB (live + migration `0058`): `ccat.logical_questions.subcategory_id` was `NOT NULL` — dropped the NOT NULL (metadata-only) so questions can exist with no subcategory. CCAT/Verbal questions still carry one via the app; nothing backfilled.
- `apps/admin/src/components/SetEditor.tsx` — per-set cap is 100 (not 15) for a subcategory-less set.
- Known minor: the deprecated `/v1/admin/content/questions` list inner-joins subcategories, so it won't show null-subcategory questions. That page is redirected to Content; not used.

## 14. Publish 422 on subcategory-less NGAT sets (2026-10-01)
- Symptom: `POST /v1/admin/content/sets/:id/publish` returned 422 `SET_TOO_LARGE` ("This set allows up to 15 questions") for the newly created NGAT Quantitative/Non-verbal sets (20 questions each).
- Cause: the publish handler re-validates the per-set cap. For a set with no subcategory, the `left join ccat.subcategories` yields no row, so `coalesce(sub.max_questions_per_set, 15)` fell back to **15**. Authoring was already raised to the 100 ceiling, but publish still defaulted to 15.
- Fix (`apps/gateway/src/routes/admin-content.ts`, publish handler): the cap query now also selects `(qs.subcategory_id is not null) as has_sub`, and `maxq` is `allowed_exam ? 60 : (has_sub ? sub.max_questions_per_set : 100)`. No-subcategory practice sets use the 100 ceiling that authoring uses; exam=60; subcategory sets unchanged → CCAT/Verbal behavior identical.
- DB: none.
- Deploy: `apps/gateway` (Render) rebuild + redeploy.

## 15. Set-name collision across subcategory-less batteries (2026-10-02)
- Symptom: in Grade 4 Non-verbal (Medium) the Bulk-add dialog reported "A set with this name already exists here" for Set 1/2/3 and auto-numbered 4/5/6, even though Grade 4 Non-verbal Medium was empty. Grade 4 **Quantitative** Medium had Set 1/2/3.
- Cause: the client name/number scope (`inScope` in `BulkSets.tsx`, plus the rename `existingNames` in `Content.tsx` and `siblingNames` in `SetEditor.tsx`) matched on grade + subcategory + difficulty but **not battery/category**. For subcategory-less batteries it matched on `!subcategory_id`, so every subcategory-less battery in the same grade+difficulty (NGAT Quantitative and Non-verbal) shared one number/name space and collided with each other. (Not a cross-grade bug — that was already fixed; this is cross-battery within a grade.)
- Fix: the no-subcategory branch now also requires `category_id` to match (`!s.subcategory_id && s.category_id === ctx.catId`); the two rename checks add `&& x.category_id === …`. Subcategory sets are unaffected (a subcategory already implies its battery). No gateway/DB change — set-name uniqueness is client-side only.
- Files: `apps/admin/src/components/BulkSets.tsx`, `apps/admin/src/components/SetEditor.tsx`, `apps/admin/src/pages/Content.tsx`.
- Redeploy: `apps/admin` (Vercel).
