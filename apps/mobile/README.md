# CCAT Practice — Mobile App (Expo / React Native)

The child-facing student app (Blueprint §1, §40 UX spec). TypeScript, Expo SDK 52,
React Native 0.76. Talks to the Gateway **only** through the shared `@ccat/api-client`.

## What's here (verified: `tsc` strict passes)
- **Design system** (`src/theme.ts`) from the approved prototypes: Baloo 2 (display) + Nunito
  (body); primary `#3e7bee`, ink `#2a2e43`, soft tinted backgrounds, kid-friendly rounding.
- **Screens** (`src/screens/`):
  - `Welcome` → get started / log in
  - `Register` — 3 steps: guardian email → OTP (dev code shown in local) + consent → child
    details (name, username, grade from `/v1/grades`, birth month/year, 4-digit PIN) → creates
    the account and logs in.
  - `Login` — username + 4-digit PIN; friendly copy for `DEVICE_NOT_ENROLLED` / lockout.
  - `Home` — Readiness (insufficient-data state, never 0%), Progress, XP/coins tiles, quick
    links to Bookmarks & Achievements, and the practice-set catalog from `/v1/catalog`.
  - `Session` — renders questions + options, per-question bookmark star, autosaves each answer
    (versioned), submits.
  - `Result` — score ring, XP earned, and any newly-unlocked achievements.
  - `Bookmarks` — saved questions with preview; remove inline.
  - `Achievements` — earned vs locked, description, reward (XP/coins).
  - `Customize` — avatars (owned/locked by XP, equip) and themes (free / XP-gated, equip).
  - `Recovery` (Forgot PIN) and `DeviceReplace` (Use a new device) — off the Login screen,
    guardian-OTP flows over the existing endpoints.
- **API wiring** (`src/lib/api.ts`) — `@ccat/api-client` with an `expo-secure-store` token store
  and a persisted device id (single-device model, §5).
- **State/router** (`src/lib/store.tsx`) — auth gate + lightweight screen router (kept
  dependency-light; swap for expo-router/react-navigation as the app grows).

## Run
```bash
pnpm install
# Gateway must be running and reachable. On a device, set your machine's LAN IP:
#   app.json → expo.extra.gatewayUrl, e.g. "http://192.168.1.20:8080"
pnpm --filter @ccat/mobile start      # then press i / a, or scan with Expo Go
pnpm --filter @ccat/mobile typecheck  # tsc strict — passes
```

## Verified vs not
- **Verified in CI-here:** full TypeScript strict typecheck; and the entire data layer
  (`@ccat/api-client`) is integration-tested against a live Gateway over HTTP
  (`apps/gateway/test/client-integration.test.ts`) — registration → login → catalog → session →
  autosave → submit → idempotent replay, all green.
- **NOT executed here:** native UI rendering. React Native needs an iOS/Android
  simulator or device (or Expo Go), which this cloud sandbox doesn't have. Run the commands
  above locally to see it.
- **Web note:** `expo start --web` will not work as-is — `expo-secure-store` is native-only.
  A web target needs a storage shim (localStorage) behind the `TokenStore` interface; the
  client already abstracts this, so it's a small addition when web is wanted.

## Not yet built
Server-side question/option shuffle (currently stored order), bookmarks, achievements/avatars/
themes screens, book store, announcements, offline-resilience checkpoint UI, accessibility pass
(accessibility-checklist.md), device-replacement & PIN-recovery screens (the client methods
exist; screens are TODO).
