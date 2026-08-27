-- Exam paper (DEV): a real 3-battery mock exam for Grade 5 so the website's exam batteries work.
-- Per migration 0014, an exam paper is a question_set_version with allowed_exam=true + a timed
-- duration, whose member questions SPAN the three categories (Verbal / Non-verbal / Quantitative) —
-- the batteries are derived from each question's category. Grade 5 already has real Verbal +
-- Quantitative questions (from seed.sql) but no Non-verbal ones, so we add two, then assemble a
-- 6-question paper (2 per battery). Idempotent: skips if the paper already exists.
do $$
declare
  gid uuid := 'a0000000-0000-0000-0000-000000000005';   -- Grade 5
  diff_easy uuid := 'c0000000-0000-0000-0000-000000000001';
  cat_nv uuid := 'b0000000-0000-0000-0000-000000000003'; -- non_verbal
  sub_nv uuid := 'a837df40-4dfd-4ecd-84c3-f76689984a22'; -- figure_analogy (falls back below if absent)
  nv1_lq uuid; nv1_qv uuid; nv2_lq uuid; nv2_qv uuid;
  exam_set uuid; exam_ver uuid;
  pos int := 0; r record;
begin
  if exists (select 1 from ccat.question_sets where name = 'CCAT Mock Exam · Grade 5') then
    raise notice 'Exam paper already present — skipped.';
    return;
  end if;
  -- pick any non_verbal subcategory for this grade if the figure_analogy id is not present
  if not exists (select 1 from ccat.subcategories where id = sub_nv) then
    select id into sub_nv from ccat.subcategories where category_id = cat_nv limit 1;
  end if;

  -- Two Non-verbal questions (single-answer). Figures rendered as text glyphs (assessment-safe).
  insert into ccat.logical_questions(id, category_id, subcategory_id) values (gen_random_uuid(), cat_nv, sub_nv) returning id into nv1_lq;
  insert into ccat.question_versions(id, logical_question_id, version_number, grade_id, difficulty_id, question_type, prompt_blocks, option_blocks, correct_option_ids, explanation_blocks, state, published_at)
    values (gen_random_uuid(), nv1_lq, 1, gid, diff_easy, 'figure_analogy',
      '[{"type":"text","value":"Which figure completes the pattern:  ▲ ● ▲ ● ▲ ?"}]'::jsonb,
      '[{"option_id":"o1","content":[{"type":"text","value":"●"}]},{"option_id":"o2","content":[{"type":"text","value":"▲"}]},{"option_id":"o3","content":[{"type":"text","value":"■"}]},{"option_id":"o4","content":[{"type":"text","value":"★"}]}]'::jsonb,
      '{o1}', '[{"type":"text","value":"The pattern alternates triangle, circle — the next is a circle."}]'::jsonb, 'published', now())
    returning id into nv1_qv;
  insert into ccat.logical_questions(id, category_id, subcategory_id) values (gen_random_uuid(), cat_nv, sub_nv) returning id into nv2_lq;
  insert into ccat.question_versions(id, logical_question_id, version_number, grade_id, difficulty_id, question_type, prompt_blocks, option_blocks, correct_option_ids, explanation_blocks, state, published_at)
    values (gen_random_uuid(), nv2_lq, 1, gid, diff_easy, 'figure_classification',
      '[{"type":"text","value":"Which figure is the odd one out:  ■  ■  ●  ■ ?"}]'::jsonb,
      '[{"option_id":"o1","content":[{"type":"text","value":"the circle ●"}]},{"option_id":"o2","content":[{"type":"text","value":"a square ■"}]},{"option_id":"o3","content":[{"type":"text","value":"none"}]},{"option_id":"o4","content":[{"type":"text","value":"all"}]}]'::jsonb,
      '{o1}', '[{"type":"text","value":"Three are squares; the circle is the odd one out."}]'::jsonb, 'published', now())
    returning id into nv2_qv;

  -- The exam paper set + published set-version (timed, exam-only, spans batteries).
  insert into ccat.question_sets(grade_id, category_id, subcategory_id, name)
    values (gid, 'b0000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'CCAT Mock Exam · Grade 5')
    returning id into exam_set;
  insert into ccat.question_set_versions(question_set_id, version_number, difficulty_id, question_count, allowed_practice, allowed_exam, duration_minutes, state, published_at)
    values (exam_set, 1, diff_easy, 6, false, true, 15, 'published', now())
    returning id into exam_ver;

  -- Members: 2 Verbal + 2 Quantitative (existing) + the 2 new Non-verbal.
  for r in
    (select qv.id from ccat.question_versions qv join ccat.logical_questions lq on lq.id=qv.logical_question_id
      where qv.state='published' and qv.grade_id=gid and lq.category_id='b0000000-0000-0000-0000-000000000001' limit 2)
    union all
    (select qv.id from ccat.question_versions qv join ccat.logical_questions lq on lq.id=qv.logical_question_id
      where qv.state='published' and qv.grade_id=gid and lq.category_id='b0000000-0000-0000-0000-000000000002' limit 2)
    union all
    (select nv1_qv) union all (select nv2_qv)
  loop
    pos := pos + 1;
    insert into ccat.set_version_questions(set_version_id, question_version_id, position, active)
      values (exam_ver, r.id, pos, true) on conflict do nothing;
  end loop;

  raise notice 'Exam paper seeded (% questions).', pos;
end $$;
