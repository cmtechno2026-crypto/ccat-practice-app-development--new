-- GAM-2: theme editor palette. Themes gain a palette (a small map of named colors) so the theme
-- editor can define the swatches; empty default keeps existing themes unchanged.
alter table ccat.themes add column if not exists palette jsonb not null default '{}'::jsonb;
