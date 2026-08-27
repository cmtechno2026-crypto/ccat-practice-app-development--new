# Run CCAT locally on your computer (Windows)

This brings up the whole stack on your PC so you can click through the features before any
global deployment. Everything runs on **your machine** against a **local Postgres** — no cloud,
no Supabase, no cost.

What you'll have running:
- **Gateway API** at `http://localhost:8080`
- **Admin Web** at `http://localhost:8090`
- **Mobile app** via Expo (on your phone with Expo Go, or an Android emulator)

Verified working: a scripted smoke test exercises **35 features end-to-end** (registration,
login, single-device, practice with scoring/XP, achievements, avatars/themes, bookmarks,
announcements, book store adult-gate, PIN recovery, device replacement, and the full admin
RBAC). It runs automatically at the end of the bring-up script.

---

## 1. Prerequisites (install once)

| Tool | Why | Get it |
|------|-----|--------|
| **Node.js 20+** | runs the Gateway & app | https://nodejs.org (LTS) |
| **pnpm** | package manager | after Node: `npm install -g pnpm` |
| **Docker Desktop** | local Postgres in one command | https://www.docker.com/products/docker-desktop (start it before step 2) |

> No Docker? You can instead install PostgreSQL 17 for Windows, create a database named `ccat`,
> and run `packages/contracts/docker/init-roles.sql` once against it. Then skip `db:up` below and
> set `DATABASE_URL` to your instance. Docker is the easy path.

## 2. One-command bring-up

1. Unzip `ccat-platform-full.zip` (from the `Production` folder) somewhere, e.g. `D:\ccat-platform`.
2. Open **PowerShell** in that folder.
3. Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-local.ps1
```

This starts Postgres, installs dependencies, migrates + seeds the database, launches the Gateway
and Admin Web in their own windows, and runs the smoke test. When it finishes you'll see the
URLs and admin logins printed.

### Or do it step by step
```powershell
copy .env.example .env
pnpm install
pnpm db:up            # start Postgres (Docker)
pnpm migrate          # create the schema
pnpm seed             # load demo content (grades, sets, books, admins)
pnpm gateway          # start the API on :8080  (leave running)
# in a second terminal:
pnpm admin            # start the Web Admin Console on :8090 (leave running)
# in a third terminal (optional):
pnpm smoke            # 35-feature student check
pnpm smoke:admin      # admin-API check (dashboard, content, config, accounts, RBAC)
```

> **Important:** keep `PIN_PEPPER=dev-pepper` (it's in `.env.example`). The demo admin password
> was hashed with that pepper; changing it breaks the seeded admin logins.

## 3. Open the Web Admin Console

**http://localhost:8090** (the React admin app — Vite dev server)

Log in with any seeded account (switch between them to see the sidebar and actions change by role):
- **super@cm.ca** / **Passw0rd!** — Super-Admin (everything)
- **support@cm.ca** / **Passw0rd!** — Student support (directory, suspend/unsuspend, device
  revoke, reward adjust, announcements, health — but **not** ban/publish/config/accounts, which
  are correctly refused)
- **content@cm.ca** / **Passw0rd!** — Content editor (create → review → publish content)

The console has the full left sidebar and working pages: **Dashboard** (live KPIs), **Service
Health**, **Student Directory** + detail (age, guardian contact, devices, status history, reward
adjust), **Content** (Questions with the draft→review→publish lifecycle, Question Sets, Learning
Plans), **Rewards** (Achievements, Avatars & Themes), **Communications** (Announcements, Push,
Book Store), **Configuration** (Grades, Feature Flags), **Administration** (Admin Accounts with
one-time temp passwords, Audit Log). Everything is backed by real Gateway endpoints and Postgres —
no mock data.

> The console reads the Gateway URL from `?gateway=` or defaults to `http://localhost:8080`. If
> you run the Gateway elsewhere, open `http://localhost:8090/?gateway=http://HOST:8080`.

Students appear in the directory after you register some in the mobile app (step 4), or after
running `pnpm smoke` which registers a few.

## 4. Run the mobile app (Expo)

```powershell
cd apps\mobile
pnpm start
```

Then either:
- **On your phone**: install **Expo Go** (App Store / Play Store), make sure the phone is on the
  same Wi-Fi as your PC, and scan the QR code. You must point the app at your PC's LAN IP, not
  `localhost` — edit `apps/mobile/app.json` → `expo.extra.gatewayUrl` to
  `http://<your-PC-IP>:8080` (find it with `ipconfig` → IPv4 Address), then restart `pnpm start`.
- **On an Android emulator** (you have the Android SDK): press `a` in the Expo terminal. From the
  emulator, your PC is reachable at `http://10.0.2.2:8080` — set that as `gatewayUrl`.

In the app: tap **Get started**, register (the one-time code is shown on screen in local dev),
create a student, then explore Home → practice a set → earn XP → unlock an avatar → bookmark a
question → open the Book Store. The student you create will show up in the Admin Web directory.

## 5. Test the Admin Console together with the CCAT app

This is the end-to-end loop that proves the two halves work together:

1. **Register a student** in the mobile app (step 4): tap Get started → guardian email → the
   6-digit code is shown on screen (local dev) → create the child account.
2. In the **Admin Console** → **Student Directory**, click **Refresh** (or reopen the page). The
   new student appears with computed age and the guardian email you entered.
3. In the app, **play a practice set** and submit. Back in the console, open that **student's
   detail** — you'll see the session under *Recent sessions*, XP under *Rewards*, and the
   Dashboard's "Completed (24h)" tick up.
4. In the console, **Suspend** the student (Student Directory → Suspend, give a reason). In the
   app, the student's next action returns them to the login screen — suspension revoked their
   session server-side. **Unsuspend** to restore.
5. **Content flow:** as `content@cm.ca`, go to **Content → Questions**, create a draft, Approve
   it, then Publish. As a student in the app, that grade's catalog can now include it.
6. **Audit:** every admin action you took shows in **Administration → Audit Log** (Super-Admin can
   switch to global scope).

Automated equivalents run any time via `pnpm smoke` (student side) and `pnpm smoke:admin`
(admin side).

## 6. Stop / reset

```powershell
# stop the Gateway/Admin windows (close them), then:
pnpm db:down          # stop Postgres (keeps data)
pnpm db:reset         # wipe Postgres and start fresh (re-run migrate + seed after)
```

---

## Troubleshooting

- **`docker: command not found` / compose errors** — start Docker Desktop first; wait for it to say "running".
- **Sign-in shows "internal error" and the Gateway logs `no pg_hba.conf entry for host "172.18.0.x", user "postgres", database "ccat"` (SQLSTATE 28000)** — the Gateway can't authenticate to Postgres, so *every* DB call fails (login included). The Postgres data volume was initialized by an older or foreign run whose `pg_hba.conf` doesn't accept the Docker bridge network. `pg_hba.conf` is written only on **first** container init, so restarting doesn't fix it. Recreate the volume:

  ```powershell
  docker compose down -v      # -v deletes the stale Postgres volume (wipes local demo data)
  docker compose up -d        # re-initializes Postgres with a correct pg_hba.conf
  # wait until healthy, then:
  pnpm migrate
  pnpm seed
  pnpm gateway
  ```

  Confirm the rule is now present (should print `host all all all scram-sha-256`):

  ```powershell
  docker exec ccat-postgres cat /var/lib/postgresql/data/pg_hba.conf | findstr "host all"
  ```

  If it still fails, something else owns port 5432 (e.g. a natively-installed PostgreSQL). Check with `docker ps --filter name=ccat-postgres` and `netstat -ano | findstr :5432` — only the `ccat-postgres` container should be answering. Stop the native PostgreSQL service (or change the compose port mapping and the `.env` `DATABASE_URL` to match).
- **Gateway exits with `Missing required env var: DATABASE_URL`** — the Gateway now loads `.env`
  automatically, so make sure a `.env` exists at the repo root (`copy .env.example .env`). If you
  prefer, you can still set the vars in the shell before `pnpm gateway`. Shell vars win over `.env`.
- **`pnpm migrate` / `pnpm seed` print nothing and the database stays empty** — fixed. (Earlier
  builds had a direct-invocation check that silently skipped the actual work on Windows.) A working
  run prints `Applied migrations: 0000…0008` and `Demo seed applied.` If you upgraded mid-setup,
  run `pnpm migrate` then `pnpm seed` again — you should now see that output.
- **Admin login fails** — ensure `PIN_PEPPER=dev-pepper` in `.env`, and that you ran `pnpm seed`.
- **App can't reach the API** — you're likely using `localhost` from a phone/emulator. Use the
  PC's LAN IP (`ipconfig`) or `10.0.2.2` for the Android emulator, and restart Expo.
- **Port already in use** — change `PORT` in `.env` (Gateway) or the `-l 8090` in the `admin-web`
  script, and update the Admin Web URL's `?gateway=` accordingly.
- **`pnpm install` slow the first time** — that's normal; it caches after the first run.

## What this local build is (and isn't)

- It's the **real** Gateway + app + Admin Web running against real Postgres, with the same code
  that will deploy globally. Admin auth uses a **local password store** for convenience; the
  production build swaps that for Supabase Auth + MFA (nothing else changes).
- The seeded content (2 practice sets, books, achievements, avatars, admins) is **demo data**,
  not production content.
- Before global deployment you still need: a provisioned Supabase project (with a Canadian
  data-residency region chosen), a reviewed production seed, and the launch gates in the Phase-0
  blueprint (accessibility audit, independent penetration test, store/legal review).
