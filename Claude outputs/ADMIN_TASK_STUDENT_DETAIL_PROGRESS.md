# Admin — Student Detail: sets-done cards, single-line membership, per-student Battery/Exam progress + set download

Editing Claude in the CCAT clone. **First read PROJECT_STATE.md and `claude/ADMIN_WEB_OVERVIEW.md`** (admin structure,
student-detail page, existing progress contracts, FIXED_ISSUES). Don't re-derive. NOT a payments feature — do NOT gate
behind PAYMENTS_ENABLED. Work on a branch off master (`feat/admin-student-progress`). **No commit/push — STOP after the
build check for review.** Match the 4 mockups the owner approved (Student Detail cards + single-line membership,
Battery Practice sets-done, Exam Progress sets-done, Set-detail with Download).

## Reuse, do NOT rebuild — the analytics already exist
The **student web** `apps/web/src/screens/ProgressScreen.tsx` already renders exactly this data via `@ccat/api-client`:
- `client.progressSummary(query)` → per-battery `{ key, setsDone, setsTotal }` (combine excluded) **and** `exam.papersDone / exam.papersTotal`.
- `client.progressSets({ battery, subcategory, ...query })` → `ProgressSetRow[]` (setId, subcategory, score, accuracy, avg time/q).
- `client.progressSetReview(setId)` → `ProgressSetReview` (the actual attempt: questions, the student's answers, the key, score).
- `GET /v1/exams/history` (see `ExamHistoryItem`) → exam papers with per-battery `correct/total`.

**Your job is to expose these per-student to the admin and render them on the admin Student Detail page.** Do not invent
new totals or new derivations — the denominators (`setsTotal`, `papersTotal`) come straight from `progressSummary`.

### The one gap to close (server)
Those endpoints are student-authenticated (the caller's own progress). The admin needs them for a **specific** student.
- FIND how the admin already reads a single student (the Student Detail page's existing loader) and follow that exact auth
  pattern. Add **admin-scoped** access to the same progress logic keyed by `student_id` — reuse the existing service
  functions; do NOT fork the query logic. Prefer thin admin routes (e.g. under the existing admin router) that call the
  same internal functions the student endpoints call, passing the target `student_id` instead of the session's.
- If an admin progress endpoint already exists, use it. List what you found before coding.

## 1. Top stat cards — replace two (position unchanged)
On the admin Student Detail card row, keep all others as-is. Replace exactly two:
- **Readiness → "Practice Sets Done"**: `Σ setsDone / Σ setsTotal` across batteries from `progressSummary` (combine excluded, same as web P1 boxes). Show `18 / 45` style; small sub-line `40% of practice sets` is optional.
- **Streak → "Exam Sets Done"**: `exam.papersDone / exam.papersTotal` from `progressSummary` (or `/v1/exams/history`). Show `3 / 12` style.
Use the sky-tint card treatment from the mockup so the two read as the new metrics.

## 2. Membership — CSS only, single line, position unchanged
The Membership card wraps to two rows with dead space. Fix layout ONLY (no logic/tier/grant change): icon + `$99 · Plus` +
status on the left, then TIER (flex-grow) · REASON · EXPIRY · **Save grant** on one row (flex-nowrap, align items end).
The note line stays below. Do not move the card or change what Save grant does.

## 3. Battery Practice + Exam Progress sections (admin, per-student, READ-ONLY)
Add two sections below Membership on Student Detail, mirroring the web ProgressScreen for the selected student:
- **Battery Practice**: Verbal/Quantitative/Non-verbal tabs. Per-subcategory boxes show **Sets Done / Total** (e.g. `1/5`),
  NOT a percent (owner decision: percent removed from the box headline). Combine box included. Below: the Sets table
  (Set | Description | Status | Score | Avg time/q) from `progressSets`. Each Set name is clickable (→ section 4).
- **Exam Progress**: per-battery **Sets/Papers Done / Total** boxes (same treatment) + an exam papers table (Paper |
  Description | Status | Score | Time) from `/v1/exams/history`. Each paper clickable (→ section 4) where a review exists.
- Admin view is read-only (no answering, no state change). Reuse the web's data shapes; restyle to the admin card system.
- Keep `score` in the table (owner: accuracy % may remain as a table column if the row already carries it; the **box
  headline** is the fraction, not the percent).

## 4. Set/paper click → review + Download
Clicking a Set (or exam paper) opens a review of the student's actual attempt (reuse `progressSetReview` / the exam
review data — "same as web ccat"): each question, the student's answer marked right/wrong vs the key, score/accuracy/avg
time header. Admin-facing, so showing the answer key is fine.
- Add a **Download this set (PDF)** action (and optionally "answers only"). Generate a PDF of the attempt (questions +
  student answers + key + score header). **Reuse the repo's existing PDF tooling if present** (ReportLab per the CM brand
  spec, or whatever the content/export pipeline already uses); do not add a new PDF stack if one exists. If no server PDF
  path exists, a clean client-side print-to-PDF of the review is acceptable for v1 — say which you chose.
- The download must be scoped to that student+set and require admin auth (no public/unauthenticated export).

## Constraints
- Minimal, surgical edits; obey FIXED_ISSUES. Reuse existing progress/exam services and contracts — no parallel analytics.
- No schema change expected (all data already computed). If you truly need one, put it in a migration `.sql` and DON'T
  apply it — give me the path.
- Respect entitlement/visibility rules already in the admin; this is staff-facing student data (children's PII) — keep it
  behind the same admin auth as the rest of Student Detail. No new public surface.

## Deliverables
- Server: the admin-scoped per-student progress access (list the routes/functions touched).
- Admin UI: two replaced cards, single-line membership, Battery Practice + Exam Progress sections, Set/paper review +
  Download. List every file changed.
- Note whether a migration was needed (path if so, not applied) and which PDF path you used.
- Build check (no commit/push): `pnpm@10 --filter @ccat/gateway build` (or typecheck) and `--filter @ccat/admin build`.
- Update PROJECT_STATE.md (new admin progress cards + set download). Then STOP for review.

FIRST: read PROJECT_STATE.md + ADMIN_WEB_OVERVIEW.md, confirm the branch, list (a) the admin Student Detail file(s),
(b) the existing progress endpoints/services you'll reuse, (c) whether an admin per-student progress endpoint already
exists, and (d) the files/functions you'll touch. Wait for my go before editing.
