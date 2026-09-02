-- 0039_set_size_battery_combine.sql
-- Raise the hard set-size bound so "Battery Combine" subcategories (max 45 questions) can be authored.
--
-- Background: 0014_exam_paper set `set_versions_size_hard_bounds` to CHECK (question_count between 0 and 20).
-- Battery Combine subcategories carry max_questions_per_set = 45, so authoring a 45-question set wrote
-- question_count = 45 and violated the CHECK — the /v1/admin/content/sets/:id/author transaction threw and
-- the request returned 500 ("Create draft sets" did nothing). 15-question sets (<= 20) were unaffected.
--
-- New upper bound is 60, which matches the author API's zod ceiling (questions array max 60) so the DB never
-- rejects a payload the API accepts. This is only a hard safety guardrail; the real per-subcategory product
-- maximum (45 for Battery Combine, 15 otherwise) is enforced client-side from subcategory.max_questions_per_set.
-- Lower bound stays 0 (drafts may be empty). Existing rows are all <= 20, so the new constraint validates.

alter table ccat.question_set_versions drop constraint if exists set_versions_size_hard_bounds;
alter table ccat.question_set_versions add constraint set_versions_size_hard_bounds
  check (question_count between 0 and 60);
