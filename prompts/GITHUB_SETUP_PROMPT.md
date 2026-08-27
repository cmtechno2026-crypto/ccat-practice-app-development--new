# CCAT — Push Production/Deployment Code to GitHub + Work From the Repo (secret-safe)

Paste the block below into your build Claude to put the CCAT monorepo (gateway + web admin + student
website + mobile app + packages + deploy config) into the GitHub repo and work from it — WITHOUT ever
committing secrets. Secret-safety first; then remote + push; then work-from-repo.

Run from the repo root: `…\Production\CCAT platform full`.
Target repo: https://github.com/shreyam274001/CCAT-Practice-App-Development

---

## THE PROMPT (copy from here down)

```
GOAL: get the production/deployment code for CCAT (gateway, web admin, student website, mobile app,
shared packages, deploy configs) into the GitHub repo
https://github.com/shreyam274001/CCAT-Practice-App-Development , and continue working from that repo.
DO THIS SECRET-SAFELY: real secrets (.env, keys) must NEVER be committed or pushed.

=== STEP 0 — SECRET SAFETY (do this BEFORE any push; hard gate) ===
- Ensure .gitignore excludes: .env, .env.*, !.env.example, node_modules/, dist/, build/, *.zip,
  coverage/, .DS_Store, *.log, any local secret files. Verify apps/*/.env, apps/*/.env.local are ignored too.
- SCAN the working tree AND git history for secrets: grep tracked files for DATABASE_URL, SERVICE_ROLE,
  SUPABASE, PIN_PEPPER, passwords, API keys; run `git log --stat` / `git ls-files` to see if .env or any
  key was EVER committed.
- If a secret was ever committed (in history, not just the working tree): STOP and tell me. Do NOT push —
  pushing publishes that history. We must scrub it first (git filter-repo / BFG) and rotate the leaked
  secret. Ask me before scrubbing.
- Confirm .env stays on disk (app still runs) but is untracked/ignored. Provide/refresh .env.example with
  placeholder keys only (no real values) so others know what to set.

=== STEP 1 — WHAT GOES IN (confirm scope with me if unsure) ===
- INCLUDE (the monorepo): apps/ (gateway, admin, web, mobile, admin-web if used), packages/ (contracts,
  api-client), package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig*, docker-compose.yml,
  Dockerfiles/.dockerignore/nginx, scripts/, .env.example, README.md, deploy runbook, CI workflow.
- EXCLUDE: .env + real secrets (never), node_modules (ignored), *.zip archives, large screenshots, and the
  `unnecessary/` archive folder if it exists.
- ASK me whether to also include: the UI mockups (the ..\..\UI folder, OUTSIDE this repo) and the blueprint
  PDF. Default = NO (they're not needed to build/deploy). Do not add files from outside this repo without asking.

=== STEP 2 — REMOTE + PUSH ===
- If this folder isn't already a git repo, `git init`. Ensure the default branch is `main`.
- Add the remote: `git remote add origin https://github.com/shreyam274001/CCAT-Practice-App-Development.git`
  (or set-url if origin exists).
- AUTH: pushing needs my GitHub credential — you cannot log in as me. REQUEST it:
    REQUEST: GitHub push credential
    What I need: a GitHub Personal Access Token (repo scope) for shreyam274001, or confirm an SSH key/GitHub
      CLI (`gh auth login`) is already configured on this machine.
    Why: to push to the private repo.
    How: GitHub → Settings → Developer settings → Personal access tokens → generate (repo scope); paste it,
      or run `gh auth login`.
    What I'll do next: configure the remote auth, commit the clean tree, and push to main.
- If the remote already has commits (e.g. a README), `git pull --rebase origin main` first, resolve, then push.
- Commit the clean, secret-free tree with a clear message; push to `origin main`.

=== STEP 3 — VERIFY THE PUSH IS CLEAN ===
- Confirm the pushed tree contains the code but NOT .env/secrets/node_modules/zips (check `git ls-files` +,
  if I give access, the GitHub file list).
- Confirm the repo builds from a fresh clone: clone to a temp dir, `pnpm install`, typecheck + build the
  gateway/web/admin. Report result. (Report exactly; don't claim it if you didn't run it.)

=== STEP 4 — WORK FROM THE REPO (going forward) ===
- This folder IS the git repo now; continue working here and push. Standard flow: pull latest, make changes,
  commit per task, push. Keep the device repo and GitHub in sync (commit + push after each task).
- Document in README how to clone + run: `git clone … ; pnpm install ; set .env from .env.example ; dev script`.

=== HARD RULES ===
- NEVER commit or push .env or any real secret. If any secret is in history, STOP + tell me before pushing;
  scrub + rotate before it ever reaches GitHub.
- Only push files from THIS repo; don't pull in outside folders (UI mockups/blueprint) without asking.
- Pushing needs my GitHub token/SSH — REQUEST it; don't fabricate credentials or claim a push you didn't make.
- Verify the clean push + a fresh-clone build; report real results, not "should".
- Commit + push after each task so the device repo and GitHub stay in sync.
```

---

## The two things that need you
1. **A GitHub credential.** Claude can't log into your GitHub. It needs a **Personal Access Token** (repo scope) or a configured SSH key / `gh auth login` on the machine. The prompt makes it request this precisely and continue the moment you provide it.
2. **Scope confirmations:** whether to include the UI mockups (they live *outside* this repo, in `..\..\UI`) and the blueprint PDF. Default is no — they aren't needed to build or deploy. Say if you want them in.

## The non-negotiable: secrets
The prompt refuses to push until it has confirmed `.env` and any key are **not** tracked — and if a secret was **ever committed to the local history**, it stops, because pushing would publish that history to GitHub permanently. Fixing that after the fact means scrubbing history *and rotating the leaked key*. Far cheaper to catch it before the first push, which is what STEP 0 does. For a product handling children's data, this is the difference between a private repo and a breach.

## One clarification on "run from Git repo"
Your device folder is already the working copy; pushing just gives it a GitHub remote. "Claude runs from the repo" means it keeps working in that folder and pushes/pulls — not that it executes code *on* GitHub. Actual running/deploying still happens on your machine or a host (per the deploy prompt); GitHub is the source-of-truth store and the thing a host's CI/CD deploys *from*.
