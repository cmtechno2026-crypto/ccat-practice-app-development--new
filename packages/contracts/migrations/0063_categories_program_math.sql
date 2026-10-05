-- 0063_categories_program_math.sql
-- Allow program='math' so Math Olympiad content is a distinct program space.
-- Content scope is anchored on the CATEGORY (program + site_id); question_sets join
-- to categories, so every existing CCAT/NGAT query that filters program IN ('ccat','ngat')
-- EXCLUDES Math automatically — ZERO changes to existing student/admin CCAT queries.
-- This is the compatibility backstop that pairs with the site_id scope (D2=B): Math
-- content carries site_id='math' AND program='math'. Widening a CHECK is additive.
begin;
alter table ccat.categories drop constraint if exists categories_program_chk;
alter table ccat.categories add constraint categories_program_chk
  check (program in ('ccat','ngat','math'));
commit;
-- ROLLBACK: restore the two-value CHECK (only safe once no program='math' rows exist).
