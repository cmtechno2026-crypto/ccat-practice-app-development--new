-- Demo content for the admin Content browser (DEV ONLY). Idempotent: builds the mockup's category
-- tree (Verbal / Non-verbal / Quantitative → subcategories) and populates question sets across
-- grades 3-6 and all difficulties so the Content page looks like the mockup instead of near-empty.
-- These set VERSIONS carry a question_count for display; they do not attach real questions (dev demo).
-- Run:  psql ... -f packages/contracts/seed/demo-content.sql   (or `pnpm seed:content`)
do $$
declare
  cat_verbal uuid; cat_nonverbal uuid; cat_quant uuid;
  subrec record; grec record; drec record;
  qs uuid; i int; cnt int; st ccat.content_state; ver int; pexam boolean;
  -- (category_key, subcategory_key, subcategory_name)
  subs text[][] := array[
    ['verbal','sentence_completion','Sentence completion'],
    ['verbal','verbal_classification','Verbal classification'],
    ['verbal','verbal_analogy','Verbal analogy'],
    ['non_verbal','figure_analogy','Figure analogy'],
    ['non_verbal','figure_classification','Figure classification'],
    ['non_verbal','paper_folding','Paper folding'],
    ['quantitative','number_analogy','Number analogy'],
    ['quantitative','number_puzzle','Number puzzle'],
    ['quantitative','equation_building','Equation building'],
    ['quantitative','quantitative_relation','Quantitative relation']
  ];
  s text[];
begin
  -- Idempotent: skip if the demo tree is already present.
  if exists (select 1 from ccat.subcategories where key='sentence_completion') then
    raise notice 'Demo content already present — content seed skipped.';
    return;
  end if;

  select id into cat_verbal from ccat.categories where key='verbal';
  select id into cat_nonverbal from ccat.categories where key='non_verbal';
  select id into cat_quant from ccat.categories where key='quantitative';

  -- Subcategories (mockup tree).
  foreach s slice 1 in array subs loop
    insert into ccat.subcategories(category_id, key, name)
      values (case s[1] when 'verbal' then cat_verbal when 'non_verbal' then cat_nonverbal else cat_quant end, s[2], s[3])
      on conflict (category_id, key) do nothing;
  end loop;

  -- For each grade × subcategory × difficulty, create 4 sets (3 published + 1 draft) — ~12 per
  -- subcategory, matching the mockup's "12 sets" counts and its per-difficulty table.
  for grec in select id gid, grade_number gn from ccat.grades where grade_number between 3 and 6 loop
    foreach s slice 1 in array subs loop
      for drec in select id did, key dk from ccat.difficulties loop
        for i in 1..4 loop
          cnt := (array[15,15,12,8])[i];  -- within the set-size bounds (5..20)
          st := case when i < 4 then 'published'::ccat.content_state else 'draft'::ccat.content_state end;
          ver := 10 + i;
          pexam := (i <= 2);
          insert into ccat.question_sets(grade_id, category_id, subcategory_id, name)
            select grec.gid,
                   (select category_id from ccat.subcategories where key=s[2] limit 1),
                   (select id from ccat.subcategories where key=s[2] limit 1),
                   'Set '||i||' · '||s[3]
            returning id into qs;
          insert into ccat.question_set_versions(question_set_id, version_number, difficulty_id, question_count, allowed_practice, allowed_exam, state, published_at)
            values (qs, ver, drec.did, cnt, true, pexam, st, case when st='published' then now() - (i||' days')::interval else null end);
        end loop;
      end loop;
    end loop;
  end loop;
  raise notice 'Demo content seeded.';
end $$;
