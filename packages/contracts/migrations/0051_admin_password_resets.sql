-- 0051_admin_password_resets.sql — self-service admin password reset via email OTP. ADDITIVE. After 0050.
-- One-time, hashed, short-TTL codes emailed to an admin's own login email. Mirrors the student PIN-reset
-- challenge model. Requires EMAIL_* to be configured for delivery; the routes fail closed otherwise.

create table if not exists ccat.admin_password_resets (
  id           uuid primary key default gen_random_uuid(),
  admin_id     uuid not null references ccat.admin_profiles(id) on delete cascade,
  code_hash    text not null,
  attempts     int  not null default 0,
  max_attempts int  not null default 5,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists admin_password_resets_active on ccat.admin_password_resets(admin_id) where consumed_at is null;
