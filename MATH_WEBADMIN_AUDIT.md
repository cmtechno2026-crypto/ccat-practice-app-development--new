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
