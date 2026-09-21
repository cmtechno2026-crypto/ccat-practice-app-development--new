-- 0048_sites_scoping.sql — multi-site admin foundation (ADDITIVE, non-breaking).
--
-- Introduces a `site` dimension so one admin console can manage several Concept Mastery
-- properties (today: CCAT Practice, Teacher Hub). This migration ONLY adds tables and backfills —
-- it changes no existing row, constraint, or behavior. The gateway/admin scoping that uses these
-- tables is layered on later and defaults to 'ccat', so applying this before that code is safe.

-- Catalogue of sites the console can manage. `id` is a stable machine key referenced everywhere;
-- never rename it once shipped (same rule as tier keys). `name` is display-only.
create table if not exists ccat.sites (
  id          text primary key,
  name        text        not null,
  is_active   boolean     not null default true,
  sort_order  int         not null default 100,
  created_at  timestamptz not null default now()
);

insert into ccat.sites (id, name, sort_order) values
  ('ccat',    'CCAT Practice', 10),
  ('teacher', 'Teacher Hub',   20)
on conflict (id) do nothing;

-- Which sites an admin may access. super_admin is NOT listed here — it implicitly reaches every
-- active site (enforced in code), exactly like it implicitly holds every permission.
create table if not exists ccat.admin_sites (
  admin_id   uuid        not null references ccat.admin_profiles(id) on delete cascade,
  site_id    text        not null references ccat.sites(id)         on delete cascade,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  primary key (admin_id, site_id)
);
create index if not exists admin_sites_site_idx on ccat.admin_sites (site_id);

-- Backfill: every existing admin gets CCAT access, so nothing they can do today changes.
insert into ccat.admin_sites (admin_id, site_id)
select id, 'ccat' from ccat.admin_profiles
on conflict do nothing;
