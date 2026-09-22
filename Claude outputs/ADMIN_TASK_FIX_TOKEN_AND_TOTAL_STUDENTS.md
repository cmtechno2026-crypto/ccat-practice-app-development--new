# Admin — fix "Invalid or expired admin token" retry loop + replace Active Students KPI with Total Students

Editing Claude in the CCAT clone. **First read PROJECT_STATE.md and `claude/ADMIN_WEB_OVERVIEW.md`** (admin auth/session
model, dashboard KPI source, FIXED_ISSUES). Don't re-derive. NOT a payments feature. Branch off master
(`fix/admin-token-and-total-students`). **No commit/push — STOP after the build check for review.** Two independent fixes.

---

## 1. BUG — "Invalid or expired admin token" + Retry does nothing (the important one)

**Symptom:** Admin Dashboard (and likely every admin page) shows the red card "Invalid or expired admin token" with a
**Retry** button. Clicking Retry changes nothing — the screen stays on the error. Only signing out and back in recovers.

**Root cause (confirm in code):** the admin session token has expired. The gateway returns 401 with this message. The
dashboard's Retry handler simply **re-issues the same request with the same expired token**, so it fails identically.
Retry can never succeed against an expired token.

**Fix — make expiry recoverable, not a dead end:**
- Locate the admin API layer (the fetch/client wrapper) and the auth/session store (where the admin token is kept + its
  TTL). Report what you find first.
- On a 401 / "invalid or expired admin token" response, do ONE coherent thing instead of re-firing the dead call:
  - If the admin auth has a **refresh** mechanism: silently refresh the token, then replay the original request once. If
    refresh fails, fall through to re-login.
  - If there is **no refresh** (single short-lived admin token): **clear the stored token and redirect to the admin login
    screen** (with a short "Your session expired — please sign in again" notice). Do NOT leave the user on a Retry button
    that reuses the dead token.
- Make this centralized in the API layer so EVERY admin page benefits, not just the Dashboard. The per-page "Retry"
  should then either succeed (post-refresh) or route to login — never silently no-op.
- Also check the token TTL itself: if it's unreasonably short (e.g. a few minutes) and that's why this keeps happening,
  note the current value and propose (don't silently change) a saner TTL. Security note: keep admin tokens short-ish and
  HTTP-only where applicable — don't loosen security to paper over the UX; fix the refresh/redirect path.

**Acceptance:** with an expired token, the admin app auto-recovers (refresh) or sends the user to login; Retry is never a
no-op. Verify by simulating an expired/garbage admin token.

---

## 2. Dashboard KPI — replace "Active Students" with "Total Students"

Current first KPI: **Active Students** = students with a session in the last 7d, subtitle "Students with a session · vs
previous 7d", with a +% delta vs previous window.

Replace it (same card slot + icon position) with **Total Students**:
- Value = count of all **real registered** students. DEFAULT scope (confirm against how the Directory counts students):
  **exclude preview/test accounts and deleted/purged**; include active + suspended. Do not filter by a time window.
- Subtitle: "registered students" (drop the "vs previous 7d" delta — a total has no window). If a small "+N last 7d"
  new-signups hint is trivial from existing data, it's optional; otherwise omit.
- Reuse an existing count if the gateway/dashboard already computes a total-students figure (the Directory or stats
  endpoint likely has it). Do NOT add a heavy new query if one exists. If you must add a count, keep it a single COUNT.
- Keep the other 7 KPI cards unchanged.

**Acceptance:** the first card reads "Total Students" with an all-students headcount matching the Directory's total; no
stale 7d-delta wording remains.

---

## Constraints
- Minimal, surgical edits; obey FIXED_ISSUES. No schema change expected — if one is truly needed, put it in a migration
  `.sql` and DON'T apply it (give me the path).
- Don't weaken admin auth to fix the token UX. The recovery path (refresh or redirect-to-login) is the fix.
- Children's PII product: the total-students count is staff-facing only; keep it behind the same admin auth as the rest.

## Deliverables
- Fix #1: the centralized 401/expired-token handling (files + the API-layer function touched); state whether you used
  refresh or redirect-to-login, and the current admin token TTL.
- Fix #2: the Total Students KPI (files touched; the count source/query used and its scope).
- Note any migration (path, not applied).
- Build check (no commit/push): `pnpm@10 --filter @ccat/gateway build` (or typecheck) and `--filter @ccat/admin build`.
- Update PROJECT_STATE.md (token-expiry recovery; Total Students KPI). Then STOP for review.

FIRST: read PROJECT_STATE.md + ADMIN_WEB_OVERVIEW.md, confirm the branch, and report (a) the admin API layer + auth/session
store and whether a token refresh exists, (b) the current admin token TTL, (c) the dashboard KPI data source and where the
total-students count lives, (d) the exact files/functions you'll touch. Wait for my go before editing.
