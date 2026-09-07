-- 0043_app_settings_grant_reason.sql
-- CCAT Payments — Admin membership control: a single default-plan lever + a grant provenance flag.
--
-- WHY:
--  * ccat.app_settings — one row holding the site-wide DEFAULT plan (a promo/"everyone gets t50 until X").
--    Setting default_tier back to 'free' is the single lever that instantly returns every NON-paying user
--    (default riders + comp/sale/discount/trial grants) to demo, while PAID users are untouched.
--  * ccat.entitlements.grant_reason — 'paid' means a Stripe-confirmed payment (ONLY the webhook may write it);
--    everything else is non-paying access. Default is 'comp' (NOT 'paid'): a row created without an explicit
--    reason is treated as comped, never as a real payment. Existing rows (manual/test grants) backfill to 'comp'.
--
-- NOT APPLIED by the build. Supabase migrations are run by the operator. This file only defines schema.
-- Apply this migration BEFORE deploying the gateway build that reads app_settings / grant_reason.

set search_path = ccat, public;

-- Single-row settings table. id is pinned to 1 (check) so there is always exactly one row.
create table if not exists ccat.app_settings (
  id            int primary key default 1 check (id = 1),
  default_tier  text not null default 'free' check (default_tier in ('free','t50','t250','t500')),
  default_until timestamptz null,                 -- NULL = no expiry; promo runs indefinitely
  updated_at    timestamptz not null default now()
);

-- Seed the singleton row (default = free = no promo). Idempotent.
insert into ccat.app_settings (id, default_tier, default_until)
values (1, 'free', null)
on conflict (id) do nothing;

-- Keep updated_at fresh (matches the rest of the schema's tg_set_updated_at from 0000).
drop trigger if exists set_updated_at on ccat.app_settings;
create trigger set_updated_at before update on ccat.app_settings
  for each row execute function ccat.tg_set_updated_at();

-- Grant provenance. Default 'comp' so an omitted reason is NEVER treated as a real payment. Existing rows
-- (manual/test grants that predate Stripe) are filled with 'comp' by this NOT NULL DEFAULT add-column.
alter table ccat.entitlements
  add column if not exists grant_reason text not null default 'comp'
    check (grant_reason in ('paid','sale','discount','comp','trial','other'));

-- Explicit backfill for safety/idempotency (if the column pre-existed with a different default, normalize
-- any pre-Stripe rows to 'comp'; a real payment is only ever set by the webhook to 'paid').
update ccat.entitlements set grant_reason = 'comp' where grant_reason is null;
