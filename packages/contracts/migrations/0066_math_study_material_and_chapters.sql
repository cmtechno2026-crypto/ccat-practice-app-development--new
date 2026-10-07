-- 0066_math_study_material_and_chapters.sql
-- Math Olympiad content restructure (Phase 1, backend foundation).
--
-- New model: a CURRICULUM chapter (an existing ccat.categories row with track='curriculum',
-- program/site 'math') can own three content kinds — Tests, Quiz Arena, and the NEW Study Material.
-- A test/quiz set and a study material may belong to ONE chapter or to NONE ("— No folder —").
-- Flat Tests/Quiz/Study admin tabs list everything across chapters; opening a chapter lists just
-- that chapter's items. Student Test Prep / Quiz Arena / Study Material show all published items
-- for the grade (across chapters). Additive + idempotent; CCAT/NGAT untouched.
begin;

-- 1) Optional chapter link for test/quiz sets. Null = unassigned. The set's KIND stays its
--    category's track (test|quiz); chapter_id only groups it under a curriculum chapter.
alter table ccat.question_sets add column if not exists chapter_id uuid references ccat.categories(id);
create index if not exists question_sets_chapter_idx on ccat.question_sets(chapter_id);

-- 2) Study Material — view-only uploaded files (PDF/PPT/DOC/image), reusing ccat.content_assets
--    for storage. One row per material; optional chapter; draft/published/retired lifecycle.
create table if not exists ccat.study_materials (
  id            uuid primary key default gen_random_uuid(),
  program       text not null default 'math',
  site_id       text not null default 'math',
  grade_id      uuid not null references ccat.grades(id),
  chapter_id    uuid references ccat.categories(id),      -- curriculum chapter; null = unassigned
  title         text not null,
  description   text,
  asset_id      uuid references ccat.content_assets(id),  -- the uploaded file (view-only for students)
  file_name     text,
  mime_type     text,
  byte_size     bigint,
  public_url    text,
  state         text not null default 'draft',            -- draft | published | retired
  display_order int  not null default 0,
  active        boolean not null default true,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists study_materials_grade_idx   on ccat.study_materials(program, site_id, grade_id) where active;
create index if not exists study_materials_chapter_idx on ccat.study_materials(chapter_id);
create index if not exists study_materials_state_idx    on ccat.study_materials(state);

-- 3) Lock the new table down to match every other ccat table (RLS enabled+forced, no policy,
--    grants revoked from anon/authenticated; the gateway connects as a BYPASSRLS role). See 0059.
alter table ccat.study_materials enable row level security;
alter table ccat.study_materials force  row level security;
revoke all on ccat.study_materials from anon, authenticated;

commit;
