-- 0064_math_category_tracks.sql
-- Math taxonomy is ADMIN-MANAGED (no fixed seed). The admin creates folders
-- (categories/subcategories) and sets per grade, within three tracks:
-- Curriculum, Quiz, Test. Two nullable columns on ccat.categories carry this,
-- used ONLY by Math rows (program='math'); every CCAT/NGAT category leaves them
-- NULL, so existing behaviour is untouched. Additive.
begin;
alter table ccat.categories add column if not exists track text;
alter table ccat.categories add column if not exists grade_id uuid references ccat.grades(id);
alter table ccat.categories drop constraint if exists categories_track_chk;
alter table ccat.categories add constraint categories_track_chk
  check (track is null or track in ('curriculum','quiz','test'));
create index if not exists categories_math_tree_idx
  on ccat.categories (program, site_id, track, grade_id);
commit;
-- ROLLBACK: drop the two columns + the track check + the index.
