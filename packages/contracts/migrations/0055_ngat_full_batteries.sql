-- ============================================================================
-- 0055_ngat_full_batteries.sql — NGAT: add Quantitative + Non-verbal batteries
--
-- 0054 seeded the NGAT 'verbal' battery (Part A/B/C). This migration completes
-- the NGAT taxonomy scaffold so admins can author ALL THREE batteries from Web
-- Admin (decision: full 3-battery authoring).
--
-- STRUCTURE ONLY: adds the two NGAT categories and ONE default subcategory each
-- ("General") so practice-set authoring (which requires a subcategory) works.
-- The real subcategory names are deferred — refine later by renaming/adding rows.
-- No question sets, no questions are created here.
--
-- Additive, non-breaking, idempotent. All reads default to program='ccat'.
-- ============================================================================
set search_path = ccat, public;

do $$
declare v_cat uuid;
begin
  -- Quantitative Reasoning (NGAT)
  insert into ccat.categories (key, name, program, display_order, active)
  values ('quantitative', 'Quantitative Reasoning', 'ngat', 20, true)
  on conflict (program, key) do update set name = excluded.name, active = true
  returning id into v_cat;
  if v_cat is null then
    select id into v_cat from ccat.categories where program = 'ngat' and key = 'quantitative';
  end if;
  insert into ccat.subcategories (category_id, key, name, display_order, active)
  values (v_cat, 'general', 'General', 10, true)
  on conflict (category_id, key) do update set name = excluded.name, active = true;

  -- Non-verbal Reasoning (NGAT)
  v_cat := null;
  insert into ccat.categories (key, name, program, display_order, active)
  values ('non_verbal', 'Non-verbal Reasoning', 'ngat', 30, true)
  on conflict (program, key) do update set name = excluded.name, active = true
  returning id into v_cat;
  if v_cat is null then
    select id into v_cat from ccat.categories where program = 'ngat' and key = 'non_verbal';
  end if;
  insert into ccat.subcategories (category_id, key, name, display_order, active)
  values (v_cat, 'general', 'General', 10, true)
  on conflict (category_id, key) do update set name = excluded.name, active = true;
end $$;
