-- 0014_exam_paper.sql — exam papers as first-class forms (CONTENT-2, owner decision 1-a:
-- extend the set model rather than add new tables). An exam paper is a question_set_version with
-- allowed_exam=true, a timed duration, and questions spanning the three sections (= the three
-- categories: Verbal / Non-verbal / Quantitative, per the mockup EXAM_SECTIONS). Sections are
-- derived from each member question's category — no separate section column needed.
alter table ccat.question_set_versions add column if not exists duration_minutes int;

alter table ccat.question_set_versions drop constraint if exists set_versions_duration_ck;
alter table ccat.question_set_versions add constraint set_versions_duration_ck
  check (duration_minutes is null or (duration_minutes between 1 and 180));

-- Allow a DRAFT set/paper to be built up from empty (0 questions); the publish route still enforces
-- the ≥5 minimum (§18). Previously the hard bound was 5..20, which blocked empty-then-fill authoring.
alter table ccat.question_set_versions drop constraint if exists set_versions_size_hard_bounds;
alter table ccat.question_set_versions add constraint set_versions_size_hard_bounds
  check (question_count between 0 and 20);
