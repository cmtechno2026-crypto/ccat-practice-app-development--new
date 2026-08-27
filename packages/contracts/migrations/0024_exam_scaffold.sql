-- 0024_exam_scaffold.sql — Exam Papers cleanup + starter scaffold (Content FIX 2).
-- (1) Remove DEMO/SEED exam papers from the Exam tab: seed content has question_sets.created_by IS NULL.
--     We only clear the exam flag (they remain as demo practice content); real authored papers
--     (created_by set) are untouched. Idempotent — re-running clears already-cleared rows to the same
--     state. PORTABILITY (Supabase): the trigger bypass uses `alter table ... disable/enable trigger`
--     (owner-privileged; works on Supabase's non-superuser postgres role) instead of
--     `set session_replication_role = replica` (superuser-only, rejected on Supabase). Same effect,
--     narrower scope (only the one immutability trigger), for this data cleanup only.
-- (2) Give every active grade a starting set of 3 EMPTY DRAFT exam papers (only grades that have none
--     after the clear). Admins edit/delete these and add more freely. Scaffolds are attributed to a
--     Super-Admin (created_by set), so they read as real starter papers, not demo.
-- Guard allowed_practice=true so clearing the exam flag never violates set_versions_mode_enabled
-- (a set must be practice OR exam). Seed demo sets are practice+exam, so they stay as practice.
alter table ccat.question_set_versions disable trigger set_version_immutable;
update ccat.question_set_versions sv set allowed_exam = false
  from ccat.question_sets qs
 where qs.id = sv.question_set_id and qs.created_by is null and sv.allowed_exam = true and sv.allowed_practice = true;
alter table ccat.question_set_versions enable trigger set_version_immutable;

do $$
declare
  g record; i int; qsid uuid; nom_cat uuid; nom_sub uuid; sysadmin uuid;
begin
  select id into nom_cat from ccat.categories where key = 'verbal' limit 1;
  if nom_cat is null then select id into nom_cat from ccat.categories order by display_order limit 1; end if;
  select id into nom_sub from ccat.subcategories where category_id = nom_cat order by display_order limit 1;
  select id into sysadmin from ccat.admin_profiles where security_role = 'super_admin' and status = 'active' order by created_at limit 1;
  if nom_cat is null or nom_sub is null then return; end if; -- no taxonomy yet; nothing to scaffold

  for g in select id, grade_number from ccat.grades where active and retired_at is null loop
    if (select count(*) from ccat.question_set_versions sv
          join ccat.question_sets qs on qs.id = sv.question_set_id
         where qs.grade_id = g.id and sv.allowed_exam = true) = 0 then
      for i in 1..3 loop
        insert into ccat.question_sets(grade_id, category_id, subcategory_id, name, created_by)
          values (g.id, nom_cat, nom_sub, 'Exam Paper ' || chr(64 + i), sysadmin)
          returning id into qsid;
        insert into ccat.question_set_versions(question_set_id, version_number, difficulty_id, question_count,
                    allowed_practice, allowed_exam, allowed_timers, duration_minutes, state, created_by)
          values (qsid, 1, null, 0, false, true, '["timed"]'::jsonb, 30, 'draft', sysadmin);
      end loop;
    end if;
  end loop;
end $$;
