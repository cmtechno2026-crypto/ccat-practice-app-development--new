-- seed-supabase.sql — seed a freshly-migrated CCAT database on Supabase.
--
-- WHY THIS WRAPPER: migration 0006 sets FORCE ROW LEVEL SECURITY on every ccat table with a policy only
-- for ccat_gateway. FORCE applies RLS even to the table OWNER, and Supabase's `postgres` role is NOT a
-- superuser, so — unlike a local superuser migrator — it cannot bypass RLS to run the seed INSERTs.
-- We therefore temporarily lift FORCE, seed, then restore it. RLS stays ENABLED the whole time
-- (anon/authenticated remain fully denied); only the owner-exemption is restored for the insert window,
-- and the original posture is put back before commit.
--
-- RUN AS THE OWNER (postgres), FROM THE REPO ROOT:
--   psql "postgresql://postgres.wazutprwrhnabjfggghp:<DB_PASSWORD>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres" \
--        -f packages/contracts/seed/seed-supabase.sql
-- (Do this AFTER `pnpm --filter @ccat/gateway migrate` has applied 0000..0027.)

\set ON_ERROR_STOP on
begin;

-- 1. Lift FORCE (keeps RLS enabled; restores owner-exemption for the insert window)
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='ccat' loop
    execute format('alter table ccat.%I no force row level security', t.tablename);
  end loop;
end $$;

-- 2. Seed. Core seed (permissions, grades, taxonomy, admin accounts) is required.
\i packages/contracts/seed/seed.sql
-- Optional demo data (synthetic, no real PII) — uncomment if you want a populated dev environment:
-- \i packages/contracts/seed/demo-content.sql
-- \i packages/contracts/seed/demo-students.sql

-- 3. Restore FORCE on every ccat table (back to the migration 0006 posture)
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='ccat' loop
    execute format('alter table ccat.%I force row level security', t.tablename);
  end loop;
end $$;

commit;

-- 4. (Optional) Clear the INFO advisor on the migrate tracking table. It holds only filenames and is
--    already default-deny under RLS; add an explicit ccat_gateway policy only if you want a named rule:
-- alter table public.ccat_schema_migrations enable row level security;
-- do $$ begin
--   if not exists (select 1 from pg_policies where schemaname='public'
--                  and tablename='ccat_schema_migrations' and policyname='gateway_all') then
--     create policy gateway_all on public.ccat_schema_migrations for all to ccat_gateway using (true) with check (true);
--   end if;
-- end $$;

-- NOTE: seeded admin password verifiers were computed with PIN_PEPPER=dev-pepper. Keep that pepper on
-- the gateway or the seeded logins (super@cm.ca / Passw0rd!, etc.) will not authenticate.
