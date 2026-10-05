-- 0060_math_content_site_scoping.sql
-- DECISION D2 = B: scope CONTENT by site_id (NOT by a new program value).
-- Adds site_id to the content tables so Math content (site_id='math') is separable
-- from CCAT/NGAT content (site_id='ccat'). ADDITIVE + BACKWARD-COMPATIBLE: every
-- column defaults to 'ccat' and is backfilled to 'ccat', so existing CCAT/NGAT
-- queries behave IDENTICALLY until the gateway is updated to also filter site_id.
--
-- IMPORTANT (paired code change): after this migration, the gateway content/
-- authoring/assignment/bookmark/progress queries must add `and <tbl>.site_id = $site`
-- (default 'ccat') — otherwise Math content authored as site_id='math' would remain
-- invisible to Math AND CCAT queries would still see only site_id='ccat'. Apply this
-- migration together with the gateway change, never ahead of it in isolation.
begin;
do $$
declare t text;
begin
  foreach t in array array[
    'categories','subcategories','question_sets','question_set_versions',
    'announcements','books','learning_plans'
  ] loop
    execute format('alter table ccat.%I add column if not exists site_id text references ccat.sites(id)', t);
    execute format('update ccat.%I set site_id = ''ccat'' where site_id is null', t);
    execute format('alter table ccat.%I alter column site_id set default ''ccat''', t);
    execute format('alter table ccat.%I alter column site_id set not null', t);
    execute format('create index if not exists %I on ccat.%I (site_id)', t || '_site_id_idx', t);
  end loop;
end $$;
commit;

-- ROLLBACK: drop the site_id columns + their indexes. No existing data changed
-- beyond setting site_id='ccat' (harmless to leave).
