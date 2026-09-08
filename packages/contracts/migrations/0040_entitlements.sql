-- 0040_entitlements.sql
-- CCAT Payments — Phase 2 (entitlements + $50 gating). Membership entitlement per guardian.
--
-- ONE entitlement row per guardian email (lower-cased match key). The GATEWAY is the only DB client;
-- it resolves the guardian from the authenticated session (student -> primary guardian contact), never
-- from a client-supplied id or tier. Stripe (Phase 1) and the CM website webhook (Phase 4) will WRITE
-- to THIS SAME table later (source='webhook'); the gating built on it does not change again.
--
-- NOT APPLIED by the build. Supabase migrations are run by the operator. This file only defines schema.

set search_path = ccat, public;

create table if not exists ccat.entitlements (
  id                  uuid primary key default gen_random_uuid(),
  guardian_email      text not null,                 -- match key; always store & compare lower-cased
  guardian_id         uuid null,                     -- link to the guardian_contacts row when known
  tier                text not null default 'free'
                        check (tier in ('free','t50','t250','t500')),
  status              text not null default 'active'
                        check (status in ('active','canceled','expired','pending')),
  current_period_end  timestamptz null,              -- expiry; NULL = no expiry
  seats               int not null default 1,
  source              text not null default 'manual'
                        check (source in ('manual','code','webhook','reconcile')),
  external_ref        text null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One entitlement per guardian email (case-insensitive). Upserts key on this index.
create unique index if not exists entitlements_guardian_email_key
  on ccat.entitlements (lower(guardian_email));

-- Optional linkage lookup by guardian_contacts id (nullable; not unique).
create index if not exists entitlements_guardian_id_idx
  on ccat.entitlements (guardian_id) where guardian_id is not null;

-- Keep updated_at fresh on every UPDATE, matching the rest of the schema (tg_set_updated_at from 0000).
drop trigger if exists set_updated_at on ccat.entitlements;
create trigger set_updated_at before update on ccat.entitlements
  for each row execute function ccat.tg_set_updated_at();
