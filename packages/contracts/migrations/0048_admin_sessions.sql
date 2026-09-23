-- 0048_admin_sessions.sql
-- Admin refresh sessions. Mirrors ccat.auth_sessions (student side) so the admin console can renew its
-- short-lived access token instead of forcing a re-login every ~15 minutes. One row per admin login;
-- refresh_hash is HMAC-hashed (never the raw token), rotated on every /v1/admin/auth/refresh call.
create table if not exists ccat.admin_sessions (
  id            uuid primary key default gen_random_uuid(),
  admin_id      uuid not null references ccat.admin_profiles(id) on delete cascade,
  refresh_hash  text not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  revoked_reason text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

-- Lookup by presented refresh hash (the hot path on every refresh) and by admin (for revoke-all).
create index if not exists admin_sessions_refresh_hash on ccat.admin_sessions(refresh_hash);
create index if not exists admin_sessions_admin_id     on ccat.admin_sessions(admin_id);
