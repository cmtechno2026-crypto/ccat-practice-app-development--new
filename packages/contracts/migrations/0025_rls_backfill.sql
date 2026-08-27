-- 0025_rls_backfill.sql — defense-in-depth RLS parity. A few tables added after 0006
-- (student_streaks 0009, job_runs 0011, student_break_glass_requests 0016) were created without
-- enabling Row Level Security, so they lacked the schema-wide default-deny + gateway_all policy.
-- The ccat schema is never exposed via PostgREST and anon/authenticated are already revoked at the
-- schema + default-privilege level, so this is belt-and-suspenders, not a live exposure — but the
-- architecture rule is "RLS ON on every app table," so enable it everywhere it is missing.
-- Idempotent: only touches ccat tables that don't yet have RLS, and only creates the policy if absent.
set search_path = ccat, public;
do $$
declare t record;
begin
  for t in
    select tablename from pg_tables where schemaname = 'ccat' and rowsecurity = false
  loop
    execute format('alter table ccat.%I enable row level security;', t.tablename);
    execute format('alter table ccat.%I force row level security;', t.tablename);
    if not exists (
      select 1 from pg_policies
       where schemaname = 'ccat' and tablename = t.tablename and policyname = 'gateway_all'
    ) then
      execute format($p$ create policy gateway_all on ccat.%I for all to ccat_gateway using (true) with check (true); $p$, t.tablename);
    end if;
  end loop;
end
$$;
