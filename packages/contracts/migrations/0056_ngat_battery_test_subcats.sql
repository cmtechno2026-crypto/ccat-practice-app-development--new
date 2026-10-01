-- ============================================================================
-- 0056_ngat_battery_test_subcats.sql — add a "<Battery> Battery Test" subcategory
-- to every NGAT battery (Verbal / Quantitative / Non-verbal).
--
-- Gives each NGAT battery a named full-battery subcategory alongside its existing
-- subcategories (Verbal already has Part A/B/C; Quant & Non-verbal have General).
-- NGAT-only — CCAT categories are untouched. Structure only (no sets/questions).
-- Additive, idempotent.
-- ============================================================================
set search_path = ccat, public;

do $$
declare r record;
begin
  for r in select id, key from ccat.categories where program = 'ngat' loop
    insert into ccat.subcategories (category_id, key, name, display_order, active)
    values (
      r.id,
      'battery_test',
      case r.key
        when 'verbal' then 'Verbal Battery Test'
        when 'quantitative' then 'Quantitative Battery Test'
        when 'non_verbal' then 'Non-verbal Battery Test'
        else initcap(replace(r.key, '_', ' ')) || ' Battery Test'
      end,
      90, true)
    on conflict (category_id, key) do update set name = excluded.name, active = true, display_order = excluded.display_order;
  end loop;
end $$;
