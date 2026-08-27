-- 0010_announcement_schedule.sql — scheduled announcements (Blueprint §26.1).
-- state 'scheduled' + scheduled_at; a Gateway worker (and optionally pg_cron) flips
-- 'scheduled' -> 'published' when scheduled_at <= now(), assigning the next carousel_order.
alter table ccat.announcements add column if not exists scheduled_at timestamptz;

-- Widen the state check to admit 'scheduled' (0005 allowed only draft/published/archived).
alter table ccat.announcements drop constraint if exists announcements_state_check;
alter table ccat.announcements add constraint announcements_state_check
  check (state in ('draft','scheduled','published','archived'));

-- pg_cron equivalent for production:
--   select cron.schedule('ccat-announce-publish','* * * * *', $$
--     update ccat.announcements set state='published', published_at=now(),
--            carousel_order=(select coalesce(max(carousel_order),-1)+1 from ccat.announcements where state='published')
--      where state='scheduled' and scheduled_at <= now() $$);
