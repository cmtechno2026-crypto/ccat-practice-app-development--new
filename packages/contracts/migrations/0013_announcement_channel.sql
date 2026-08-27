-- 0013_announcement_channel.sql — unify announcements + push into one "communications" surface
-- (mockup Announcements screen). An announcement now has a CHANNEL (carousel, or carousel+push),
-- a live WINDOW (starts_at/ends_at), a 'stopped' lifecycle state, and an optional linked push
-- campaign. The student carousel still reads state='published'; it now also respects ends_at.
alter table ccat.announcements add column if not exists channel text not null default 'carousel';
alter table ccat.announcements add column if not exists starts_at timestamptz;
alter table ccat.announcements add column if not exists ends_at timestamptz;
alter table ccat.announcements add column if not exists stopped_at timestamptz;
alter table ccat.announcements add column if not exists push_campaign_id uuid references ccat.push_campaigns(id);

alter table ccat.announcements drop constraint if exists announcements_channel_check;
alter table ccat.announcements add constraint announcements_channel_check
  check (channel in ('carousel', 'carousel_push'));

-- Add 'stopped' to the lifecycle (0010 added 'scheduled').
alter table ccat.announcements drop constraint if exists announcements_state_check;
alter table ccat.announcements add constraint announcements_state_check
  check (state in ('draft','scheduled','published','stopped','archived'));

-- Backfill: existing rows go live when scheduled/published; no explicit end.
update ccat.announcements set starts_at = coalesce(starts_at, scheduled_at, published_at)
 where starts_at is null;
