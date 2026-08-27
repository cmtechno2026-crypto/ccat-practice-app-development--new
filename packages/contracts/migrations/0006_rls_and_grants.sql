-- ============================================================================
-- CCAT Practice App — Database Migration 0006
-- Row Level Security, roles, and grants
-- Blueprint §33, §36.3, §41 (direct student Supabase/PostgREST access PROHIBITED)
--
-- Access model:
--   * The student MOBILE APP has NO database access of any kind. All student data
--     flows through the Gateway (§1.1.1, §33).
--   * The Gateway authenticates to Postgres as a single least-privilege role
--     `ccat_gateway`. It performs per-request authorization in application code
--     using DB-backed permissions (§22.1); it is NOT relying on RLS for tenant
--     isolation. RLS here is defense-in-depth: it denies the Supabase-default
--     `anon` / `authenticated` PostgREST roles entirely.
--   * The Admin Web talks to the Gateway too (§32.7 "browser direct database
--     access is prohibited"), so it also has no direct Postgres role.
--
-- This migration REVOKES the Supabase PostgREST surface from the ccat schema and
-- enables RLS (default-deny) on every table.
-- ============================================================================
set search_path = ccat, public;

-- ----------------------------------------------------------------------------
-- 1. Remove the PostgREST/anon surface from the ccat schema.
--    Supabase exposes `anon` and `authenticated` via PostgREST. Neither may see
--    application data directly.
-- ----------------------------------------------------------------------------
revoke all on schema ccat from anon, authenticated;
revoke all on all tables    in schema ccat from anon, authenticated;
revoke all on all sequences in schema ccat from anon, authenticated;
revoke all on all functions in schema ccat from anon, authenticated;

-- Ensure future objects also stay off-limits to anon/authenticated.
alter default privileges in schema ccat revoke all on tables    from anon, authenticated;
alter default privileges in schema ccat revoke all on sequences from anon, authenticated;
alter default privileges in schema ccat revoke all on functions from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. Dedicated least-privilege Gateway role.
--    Create the role idempotently; the actual login password/secret is managed
--    in the secret store and set outside migrations (never in VCS).
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ccat_gateway') then
    create role ccat_gateway nologin;   -- NOLOGIN here; grant LOGIN + password out-of-band
  end if;
end
$$;

grant usage on schema ccat to ccat_gateway;
grant select, insert, update, delete on all tables in schema ccat to ccat_gateway;
grant usage, select on all sequences in schema ccat to ccat_gateway;
grant execute on all functions in schema ccat to ccat_gateway;

alter default privileges in schema ccat
  grant select, insert, update, delete on tables to ccat_gateway;
alter default privileges in schema ccat
  grant usage, select on sequences to ccat_gateway;

-- Append-only enforcement: the tg_forbid_mutation triggers already block
-- UPDATE/DELETE on ledgers/audit even for ccat_gateway. To also block them at the
-- privilege layer, revoke update/delete on those specific tables:
revoke update, delete on
  ccat.consents,
  ccat.student_status_events,
  ccat.audit_log,
  ccat.session_events,
  ccat.session_submissions,
  ccat.session_results,
  ccat.xp_transactions,
  ccat.coin_transactions,
  ccat.student_achievements,
  ccat.push_delivery_events,
  ccat.product_events
from ccat_gateway;

-- ----------------------------------------------------------------------------
-- 3. Enable RLS (default-deny) on every table in the schema.
--    With no permissive policy for anon/authenticated, those roles get nothing.
--    ccat_gateway is granted BYPASSRLS-equivalent behavior via an explicit
--    permissive policy so the Gateway (which authorizes in app code) is not
--    second-guessed by row policies.
-- ----------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in
    select tablename from pg_tables where schemaname = 'ccat'
  loop
    execute format('alter table ccat.%I enable row level security;', t.tablename);
    execute format('alter table ccat.%I force row level security;', t.tablename);
    -- Permissive policy allowing the Gateway role full access.
    execute format($p$
      create policy gateway_all on ccat.%I
        for all to ccat_gateway using (true) with check (true);
    $p$, t.tablename);
  end loop;
end
$$;

-- Note: no policies are created for anon/authenticated => default deny for them.
-- The Gateway is the sole data path (§33).
