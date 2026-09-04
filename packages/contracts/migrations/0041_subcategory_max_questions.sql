-- 0041_subcategory_max_questions.sql
-- Backfill a committed definition for ccat.subcategories.max_questions_per_set.
--
-- Background: the gateway (catalog + admin content routes) reads sub.max_questions_per_set, and 0039
-- references it, but NO committed migration ever created the column — it exists only on the production
-- Supabase, applied out-of-band (per the note in apps/gateway/src/lib/migrate.ts, prod uses
-- `supabase db push` / MCP apply_migration). As a result a fresh DB built from these migration files
-- (local dev, CI/vitest) lacks the column, so /v1/catalog and the admin content-write endpoints 500.
--
-- This migration makes the files match prod reality. `add column if not exists` is a NO-OP on the
-- production database (the column is already there) and simply creates it everywhere else.
--
-- Default 15 is the standard per-subcategory set-size cap; "Battery Combine" subcategories carry 45 and
-- are set per-row (data, seeded separately). NOT APPLIED by the build — the operator runs migrations.

set search_path = ccat, public;

alter table ccat.subcategories
  add column if not exists max_questions_per_set int not null default 15;
