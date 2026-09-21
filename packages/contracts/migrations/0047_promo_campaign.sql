-- 0047_promo_campaign.sql — site-wide promotional discount (DISPLAY-ONLY).
-- A single row (id = 1) drives the landing banner + countdown and the discounted prices shown on the
-- landing pricing section and the in-app My Plan page. When `active` is false, or `now` is outside
-- [starts_at, ends_at], the site shows normal prices with no banner. This is display-only: the gateway
-- PayPal amount is NOT changed by this table (a real discounted charge would be a separate change).
create table if not exists ccat.promo_campaign (
  id          smallint primary key default 1,
  active      boolean     not null default false,
  percent     int         not null default 50 check (percent between 1 and 90),
  starts_at   timestamptz,
  ends_at     timestamptz,
  headline    text        not null default '50% Off All Plans — Limited Time!',
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  constraint promo_campaign_singleton check (id = 1)
);

-- Seed the singleton row (inactive by default).
insert into ccat.promo_campaign (id) values (1) on conflict (id) do nothing;
