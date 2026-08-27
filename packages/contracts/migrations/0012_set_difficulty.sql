-- 0012_set_difficulty.sql — populate per-set difficulty for the Content set browser.
-- question_set_versions.difficulty_id already exists (used by set creation) but older/seeded sets
-- left it null. The admin console (mockup) groups sets under Easy/Medium/Hard tabs, so every set
-- version needs a difficulty. Backfill from each version's dominant question difficulty (truthful);
-- default to 'medium' when a version has no questions yet.
update ccat.question_set_versions sv set difficulty_id = sub.did
from (
  select sv2.id, (
    select d.id
      from ccat.set_version_questions svq
      join ccat.question_versions qv on qv.id = svq.question_version_id
      join ccat.difficulties d on d.id = qv.difficulty_id
     where svq.set_version_id = sv2.id
     group by d.id
     order by count(*) desc
     limit 1
  ) did
  from ccat.question_set_versions sv2
) sub
where sub.id = sv.id and sv.difficulty_id is null;

update ccat.question_set_versions
   set difficulty_id = (select id from ccat.difficulties where key = 'medium')
 where difficulty_id is null;
