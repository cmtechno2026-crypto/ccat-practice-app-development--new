-- GAM-3: a single "brand default" theme, used whenever a child has no theme equipped.
alter table ccat.themes add column if not exists is_default boolean not null default false;
-- At most one default theme (partial unique index over the truthy rows).
create unique index if not exists themes_one_default on ccat.themes(is_default) where is_default;
