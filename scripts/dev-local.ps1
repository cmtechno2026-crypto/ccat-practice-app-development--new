# CCAT local bring-up for Windows (PowerShell).
# Prereqs: Docker Desktop running, Node 20+, pnpm (npm i -g pnpm).
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File scripts\dev-local.ps1
$ErrorActionPreference = "Stop"

# $ErrorActionPreference="Stop" does NOT stop on a failed EXTERNAL command (pnpm/node exiting non-zero);
# it only catches cmdlet errors. Without this guard a failed `pnpm migrate` would fall through into
# seed + server startup and present a misleading, partially-migrated app. Run must-succeed external
# steps through this helper so any non-zero exit aborts the whole bring-up loudly.
function Invoke-Step {
  param([Parameter(Mandatory = $true)][string]$Label, [Parameter(Mandatory = $true)][scriptblock]$Cmd)
  Write-Host "    $Label" -ForegroundColor DarkCyan
  & $Cmd
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ABORT: '$Label' failed (exit $LASTEXITCODE). Not seeding or starting the servers." -ForegroundColor Red
    Write-Host "Fix the error above, then re-run scripts\dev-local.ps1." -ForegroundColor Red
    exit 1
  }
}

Write-Host "==> Environment" -ForegroundColor Cyan
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env"; Write-Host "created .env from .env.example" }
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/ccat"
$env:GATEWAY_HMAC_SECRET = "local-secret"
$env:PIN_PEPPER = "dev-pepper"
$env:NODE_ENV = "local"
$env:PORT = "8080"

Write-Host "==> Starting Postgres (docker compose)" -ForegroundColor Cyan
docker compose up -d
Write-Host "    waiting for Postgres to be healthy..."
do { Start-Sleep -Seconds 2; $status = (docker inspect --format '{{.State.Health.Status}}' ccat-postgres 2>$null) } until ($status -eq "healthy")
Write-Host "    Postgres healthy."

Write-Host "==> Installing dependencies" -ForegroundColor Cyan
Invoke-Step "pnpm install" { pnpm install }

Write-Host "==> Migrating + seeding database (idempotent - safe to re-run)" -ForegroundColor Cyan
# Migration MUST succeed before anything else runs. A failed migration here aborts the whole script
# (see Invoke-Step) instead of silently continuing into seed/startup with a half-migrated schema.
Invoke-Step "pnpm migrate" { pnpm migrate }
Invoke-Step "pnpm seed" { pnpm seed }
Invoke-Step "pnpm seed:students" { pnpm seed:students }   # ~60 demo students for the admin directory
Invoke-Step "pnpm seed:content" { pnpm seed:content }     # mockup category tree + question sets so Content is populated
Invoke-Step "pnpm seed:preview" { pnpm seed:preview }     # preview logins admin_3/admin_4/admin_5/admin_6 (PIN 2026); device-waived so they work from any browser

# Website config: point the student web client at the local Gateway (idempotent).
if (-not (Test-Path "apps\web\.env.local")) { Copy-Item "apps\web\.env.example" "apps\web\.env.local"; Write-Host "created apps\web\.env.local" }

Write-Host "==> Starting Gateway (:8080), Admin Console (:8090) and CCAT Practice website (:5173)" -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit","-Command","`$env:DATABASE_URL='$($env:DATABASE_URL)';`$env:GATEWAY_HMAC_SECRET='$($env:GATEWAY_HMAC_SECRET)';`$env:PIN_PEPPER='dev-pepper';`$env:NODE_ENV='local';`$env:PORT='8080'; pnpm gateway"
Start-Process powershell -ArgumentList "-NoExit","-Command","pnpm admin"
Start-Process powershell -ArgumentList "-NoExit","-Command","`$env:VITE_GATEWAY_URL='http://localhost:8080'; pnpm web"

Write-Host "==> Waiting for the Gateway to accept connections..." -ForegroundColor Cyan
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  try { $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8080/health/ready" -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch { }
  Start-Sleep -Seconds 1
}
if ($ready) {
  Write-Host "==> Smoke test" -ForegroundColor Cyan
  $env:GATEWAY = "http://localhost:8080"
  node scripts\smoke.mjs
} else {
  Write-Host "    Gateway not ready yet - skipping smoke test. Check the Gateway window." -ForegroundColor Yellow
}

# Give the Vite dev servers a moment to boot, then open both pages in the default browser.
Write-Host "==> Waiting for the web servers, then opening both pages..." -ForegroundColor Cyan
foreach ($u in @("http://localhost:8090/","http://localhost:5173/")) {
  for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Seconds 1 }
  }
}
Start-Process "http://localhost:8090/"
Start-Process "http://localhost:5173/"

Write-Host ""
Write-Host "Ready:" -ForegroundColor Green
Write-Host "  Gateway            : http://localhost:8080/health/ready"
Write-Host "  Web Admin Console  : http://localhost:8090/            (opened in your browser)"
Write-Host "  CCAT Practice site : http://localhost:5173/            (opened in your browser)"
Write-Host "  Admin logins       : super@cm.ca / Passw0rd!  |  support@cm.ca / Passw0rd!  |  content@cm.ca / Passw0rd!"
Write-Host "  Preview students   : admin_3 / admin_4 / admin_5 / admin_6  (PIN 2026)  - device-waived: log in from any browser."
Write-Host "  Tip                : real registered students are single-device (bound to the browser they signed up in);"
Write-Host "                       use a preview student above to test across browsers/machines."
Write-Host "  Mobile app         : see DEPLOY-LOCAL.md (Expo)"
