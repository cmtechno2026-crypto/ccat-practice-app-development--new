-- 0045_email_verifications.sql
-- Pre-registration email OTP verification: the guardian email is confirmed BEFORE the account is created.
-- NOT auto-applied. Apply with your migration runner BEFORE turning on EMAIL_VERIFY_REQUIRED /
-- VITE_EMAIL_VERIFY_ENABLED. No existing code path touches this table until that flag is on.
create extension if not exists citext;
create table if not exists ccat.email_verifications (
  id           uuid primary key default gen_random_uuid(),
  email        citext not null,
  code_hash    text not null,
  attempts     int not null default 0,
  max_attempts int not null default 5,
  consumed_at  timestamptz,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
create index if not exists email_verifications_email_created_idx on ccat.email_verifications (email, created_at desc);
create index if not exists email_verifications_active_idx on ccat.email_verifications (email) where consumed_at is null;
