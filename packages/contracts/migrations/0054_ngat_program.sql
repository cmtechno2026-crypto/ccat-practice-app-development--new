-- ============================================================================
-- 0054_ngat_program.sql — NGAT workspace: program dimension (ADDITIVE, non-breaking)
--
-- Adds a `program` dimension so one student site can serve two workspaces:
--   'ccat' (existing) and 'ngat' (new). The flag lives ONLY on ccat.categories;
--   everything downstream (question_sets, sessions, assignments, completions,
--   progress) inherits the program through its category, so NO busy table changes.
--
-- Also seeds the NGAT **taxonomy scaffold** — the Verbal battery and its three
-- subcategories Part A / Part B / Part C. This is STRUCTURE only: no question
-- sets and no questions are created here (content is authored later via admin).
-- With zero sets, the student web NGAT Practice correctly shows the empty state.
--
-- Safe to run before any gateway/web change: every read defaults to program='ccat'.
-- Idempotent.
-- ============================================================================
set search_path = ccat, public;

-- 1) program column — existing rows backfill to 'ccat' via the default.
alter table ccat.categories add column if not exists program text not null default 'ccat';

-- 2) key was globally UNIQUE; make it unique PER PROGRAM so NGAT can reuse 'verbal' etc.
--    Drop the original inline unique (default name categories_key_key) if present, then
--    add the composite. Guarded so re-runs are safe.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'ccat.categories'::regclass and conname = 'categories_key_key'
  ) then
    alter table ccat.categories drop constraint categories_key_key;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'ccat.categories'::regclass and conname = 'categories_program_key_unique'
  ) then
    alter table ccat.categories add constraint categories_program_key_unique unique (program, key);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'ccat.categories'::regclass and conname = 'categories_program_chk'
  ) then
    alter table ccat.categories add constraint categories_program_chk check (program in ('ccat','ngat'));
  end if;
end $$;

create index if not exists categories_program_idx on ccat.categories(program);

-- 3) NGAT taxonomy scaffold — Verbal battery + Part A/B/C subcategories. STRUCTURE ONLY.
--    Categories/subcategories are NOT grade-scoped (grade scoping happens on question_sets),
--    so this one taxonomy serves NGAT content for every grade (2–6 at launch) once sets exist.
do $$
declare v_cat uuid;
begin
  insert into ccat.categories (key, name, program, display_order, active)
  values ('verbal', 'Verbal Reasoning', 'ngat', 10, true)
  on conflict (program, key) do update set name = excluded.name, active = true
  returning id into v_cat;

  if v_cat is null then
    select id into v_cat from ccat.categories where program = 'ngat' and key = 'verbal';
  end if;

  insert into ccat.subcategories (category_id, key, name, display_order, active) values
    (v_cat, 'part_a', 'Picture Classification', 10, true),
    (v_cat, 'part_b', 'Picture Analogies', 20, true),
    (v_cat, 'part_c', 'Picture Pairs', 30, true)
  on conflict (category_id, key) do update set name = excluded.name, active = true;
end $$;
