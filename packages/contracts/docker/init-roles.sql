-- Runs once at Postgres container init (docker-entrypoint-initdb.d). Creates the Supabase-style
-- roles that migration 0006 references, so the same migrations run on plain Postgres locally.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
