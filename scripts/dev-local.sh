#!/usr/bin/env bash
# CCAT local bring-up for macOS/Linux (or Git Bash on Windows).
# Prereqs: Docker running, Node 20+, pnpm. Run from repo root: bash scripts/dev-local.sh
set -euo pipefail
[ -f .env ] || cp .env.example .env
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ccat"
export GATEWAY_HMAC_SECRET="local-secret" PIN_PEPPER="dev-pepper" NODE_ENV="local" PORT="8080"

echo "==> Starting Postgres"
docker compose up -d
echo -n "    waiting for healthy"
until [ "$(docker inspect --format '{{.State.Health.Status}}' ccat-postgres 2>/dev/null || echo none)" = "healthy" ]; do echo -n "."; sleep 2; done; echo " ok"

echo "==> Install deps"; pnpm install
echo "==> Migrate + seed (idempotent — safe to re-run)"; pnpm migrate; pnpm seed; pnpm seed:students
pnpm seed:content    # mockup category tree + question sets
echo "==> Start Gateway (:8080) and Admin Console (:8090) in background"
( pnpm gateway >/tmp/ccat-gw.log 2>&1 & echo $! > /tmp/ccat-gw.pid )
( pnpm admin >/tmp/ccat-admin.log 2>&1 & echo $! > /tmp/ccat-admin.pid )
sleep 8
echo "==> Smoke tests"
GATEWAY=http://localhost:8080 node scripts/smoke.mjs || true
GATEWAY=http://localhost:8080 node scripts/admin-smoke.mjs || true
echo
echo "Gateway       : http://localhost:8080/health/ready"
echo "Admin Console : http://localhost:8090"
echo "Admin logins  : super@cm.ca / Passw0rd!  ·  support@cm.ca / Passw0rd!  ·  content@cm.ca / Passw0rd!"
echo "Stop: kill \$(cat /tmp/ccat-gw.pid) \$(cat /tmp/ccat-admin.pid); docker compose down"
