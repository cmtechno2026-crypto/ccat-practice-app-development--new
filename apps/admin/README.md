# CCAT Web Admin Console (React + Vite)

The full operations console for Admin / Super-Admin users (Blueprint §22–§29). A real SPA that
talks to the Gateway — no mocks. TypeScript, React 18, Vite 6, react-router.

## Features (left sidebar)
- **Overview** — Dashboard (live KPIs: students by status, sessions, content, incidents, XP,
  recent activity) · Service Health (indicator console, overall state, incidents).
- **Students** — directory (computed age, guardian PII, search, suspend/ban/unban with reason +
  ETag conflict handling) · **Student detail** (guardians, devices + revoke, status history,
  readiness/progress, recent sessions, reward adjustment).
- **Content** — Questions (filter by state, create draft, review→approve, publish, retire) ·
  Question Sets (publish) · Learning Plans.
- **Rewards** — Achievements (list + create) · Avatars & Themes.
- **Communications** — Announcements (create + publish/archive) · Push Campaigns (request +
  Super-Admin approve/reject) · Book Store (add books + HTTPS retailer links).
- **Configuration** — Grades (toggle registration/practice, Super-Admin) · Feature Flags
  (emergency global controls, Super-Admin).
- **Administration** — Admin Accounts (list, create with one-time temp password, enable/disable,
  last-Super-Admin protection) · Audit Log (self / global scope).

RBAC is enforced by the Gateway on every request; the UI additionally hides controls the signed-in
admin lacks permission for. Light/dark theme aware.

## Run
```bash
pnpm install
# Gateway must be running on :8080 (see apps/gateway/README.md)
pnpm --filter @ccat/admin dev        # Vite dev server on http://localhost:8090
# The app reads the Gateway URL from ?gateway=... or window.__CCAT_GATEWAY__, default :8080.
```
Production build: `pnpm --filter @ccat/admin build` → static files in `dist/` (serve behind any
static host; set the Gateway origin via `ADMIN_WEB_ORIGIN` CORS on the Gateway).

Seed logins (local): `super@cm.ca` / `Passw0rd!` (Super-Admin), `support@cm.ca` (student support),
`content@cm.ca` (content editor). Switch accounts to see the sidebar and actions change by role.

## Verified
TypeScript strict typecheck passes; `vite build` succeeds; the full console was rendered with
Playwright against a live Gateway (login → dashboard → students → content → health → admins →
flags → audit) and every page loaded real data. The Gateway's 15 admin-domain integration tests
(`apps/gateway/test/admin-full.test.ts`) back the endpoints this UI calls.

> The older `apps/admin-web` (single-file vanilla console) is superseded by this app.
