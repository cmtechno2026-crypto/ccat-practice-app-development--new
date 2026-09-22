# Admin — Service Health: make Email OTP clickable → "Email Formats & Cases" viewer

Editing Claude in the CCAT clone. **First read PROJECT_STATE.md, `claude/ADMIN_WEB_OVERVIEW.md`, and the email service
(see below).** Don't re-derive. NOT a payments feature. Branch off master (`feat/admin-email-format-viewer`).
**No commit/push — STOP after the build check for review.** Match the approved mockup (a modal with a left list of email
cases and a per-case Subject + rendered body + template variables).

## What & why
On Service Health → Third-party providers, the **Email OTP** row is static. Make it **clickable** → open an "Email Formats
& Cases" panel that shows, for every email the platform can send, the **subject + rendered HTML body + the template
variables**. This lets staff see exactly what each email looks like without triggering a send. Read-only preview.

## The cases = whatever the email service actually defines (source of truth)
Do NOT hardcode a case list from this prompt. **Enumerate the real templates from the codebase.**
- FIND the email service / templates. Likely a gateway module (e.g. `apps/gateway/src/.../email*` / a templates file) —
  it may be partial or not yet built. Report exactly what exists.
- If a template registry exists, drive the viewer from it (id, subject, html, variables) so the panel stays in sync as
  templates change. If templates are inline strings, refactor them into a small shared registry the viewer can import
  (keep behaviour identical — this is a lift, not a rewrite).
- The cases we EXPECT (confirm/adjust against code): Guardian Email Verification (OTP), PIN Reset (OTP), Welcome,
  Plan Upgraded, Guardian Sign-in-Blocked alert. If some don't exist yet, show them only if wired; do not fabricate
  copy for emails the system can't send. Mark each case's real status (wired vs planned) from config/flags.

## UI (admin)
- Email OTP row: add a click affordance ("View formats ›") and make the row open the panel/modal.
- Panel: left = case list (name + a tag: OTP vs Notification, and a wired/not-wired status); right = selected case's
  **Subject**, a rendered **email body** (the actual template HTML with `{{variables}}` left visible/highlighted, NOT
  filled with real child data), and a **Template variables** list.
- Render the template HTML safely (sanitize; these are trusted in-repo templates, but don't inject unescaped user data).
- Optional, only if trivial and safe: a "Send test to myself" button — but it must be **disabled when EMAIL_PROVIDER_KEY
  is not configured** (current state shows "Not configured"), and when enabled must send ONLY to the logged-in admin's
  own address, never to a student/guardian. If in doubt, ship the viewer without send and leave a TODO.

## Constraints
- Read-only preview; no emails sent to guardians/children from this screen. This is a children's-PII product — the panel
  shows templates with placeholder `{{variables}}`, not real recipients' data.
- Keep it behind the same admin auth as the rest of Service Health.
- Minimal edits; obey FIXED_ISSUES. Prefer reading templates from one shared source over duplicating copy in the admin.
- No schema change expected. If one is truly needed, migration `.sql`, DON'T apply (give the path).

## Deliverables
- The clickable Email OTP row + the Formats & Cases panel, driven by the real template registry.
- List the email templates you found (ids/subjects) and which are wired vs planned; note where they live.
- State whether you added a template registry/refactor and whether "Send test" was included or deferred.
- Build check (no commit/push): `pnpm@10 --filter @ccat/gateway build` (or typecheck) and `--filter @ccat/admin build`.
- Update PROJECT_STATE.md (email-format viewer + template registry location). Then STOP for review.

FIRST: read PROJECT_STATE.md + ADMIN_WEB_OVERVIEW.md, locate the email service/templates, and report (a) which email
templates actually exist and where, (b) their subjects + variables, (c) whether they're a registry or inline strings,
(d) the Service Health file + the files you'll touch. Wait for my go before editing.
