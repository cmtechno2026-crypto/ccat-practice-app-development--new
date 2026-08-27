-- ============================================================================
-- CCAT Migration 0008 — Admin local dev auth + student optimistic-concurrency version
--
-- PRODUCTION uses Supabase Auth for Admin identity + MFA (Blueprint §22). This table exists
-- ONLY for local/dev/staging where Supabase Auth is not wired, so the Admin Web + RBAC can be
-- built and tested. It MUST NOT be used in production (no password business table, §22.2).
--
-- Also adds students.version to give the student directory an ETag for the conflict-comparison
-- UI on status changes (§22.4).
-- ============================================================================
set search_path = ccat, public;

create table if not exists ccat.admin_local_credentials (
  admin_id      uuid primary key references ccat.admin_profiles(id) on delete cascade,
  password_hash text not null,          -- scrypt verifier; DEV ONLY
  updated_at    timestamptz not null default now()
);
grant select, insert, update, delete on ccat.admin_local_credentials to ccat_gateway;
alter table ccat.admin_local_credentials enable row level security;
alter table ccat.admin_local_credentials force row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='ccat' and tablename='admin_local_credentials' and policyname='gateway_all') then
    create policy gateway_all on ccat.admin_local_credentials for all to ccat_gateway using (true) with check (true);
  end if;
end $$;

-- Optimistic-concurrency version for the student directory (§22.4).
alter table ccat.students add column if not exists version int not null default 1;
