-- 0061_support_cases_site_scoping.sql
-- Scope support cases by site so the admin Support console can filter to Math.
-- ADDITIVE + BACKWARD-COMPATIBLE: default 'ccat', backfill existing rows to 'ccat'.
-- ccat.support_messages (already live) is reached via its case, so it inherits the
-- case's site — no column needed there.
begin;
alter table ccat.support_cases add column if not exists site_id text references ccat.sites(id);
update ccat.support_cases set site_id = 'ccat' where site_id is null;
alter table ccat.support_cases alter column site_id set default 'ccat';
alter table ccat.support_cases alter column site_id set not null;
create index if not exists support_cases_site_id_idx on ccat.support_cases (site_id, state, created_at desc);
commit;

-- ROLLBACK: drop column + index. No existing data changed beyond site_id='ccat'.
