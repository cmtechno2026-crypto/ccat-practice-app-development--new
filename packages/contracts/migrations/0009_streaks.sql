-- 0009_streaks.sql — Daily practice streaks (Option A: strict daily, student-local timezone,
-- no grace; milestone coins via the exactly-once coin ledger). Blueprint §19 economy.
--
-- A streak = consecutive calendar days (in the student's own timezone) with >= 1 completed,
-- scored session. Stored current_streak is "as of last_active_day"; effective current for
-- display is 0 when last_active_day < today-1 (broken). longest_streak is the all-time best.
-- Milestone coin bonuses (3/7/14/30 days -> 10/25/60/150 coins) are granted exactly once via
-- ccat.coin_transactions(source_kind='streak_milestone', source_id=<milestone days>), protected
-- by the existing coin_tx_source_unique constraint.

create table if not exists ccat.student_streaks (
  student_id       uuid primary key references ccat.students(id) on delete cascade,
  current_streak   integer not null default 0 check (current_streak >= 0),
  longest_streak   integer not null default 0 check (longest_streak >= 0),
  last_active_day  date,
  updated_at       timestamptz not null default now()
);

comment on table ccat.student_streaks is
  'Daily practice streak per student (student-local day). current_streak is as-of last_active_day; effective current is 0 when last_active_day < today-1.';

-- Production scheduling note (§27): the reconcile step (zeroing stale streaks) is also runnable
-- via pg_cron where available, e.g.:
--   select cron.schedule('ccat-streak-reconcile', '7 * * * *', $$
--     update ccat.student_streaks ss set current_streak = 0, updated_at = now()
--       from ccat.students s
--      where ss.student_id = s.id and ss.current_streak > 0
--        and ss.last_active_day < (now() at time zone s.timezone)::date - 1 $$);
-- The Gateway also runs this on an interval, and reads compute the effective value at query time,
-- so correctness does not depend on the job.
