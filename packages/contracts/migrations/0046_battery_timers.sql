-- 0046_battery_timers.sql
-- Per-battery exam timers. Each exam paper (question_set_versions with allowed_exam) gets a
-- duration PER battery (verbal / non_verbal / quantitative), stored as minutes in a jsonb map.
-- Each running battery is timed independently: its clock starts when the student starts that
-- battery and is enforced by a per-(session,battery) deadline in ccat.session_batteries.

-- 1) Per-battery durations on the exam paper (minutes). null = fall back to duration_minutes/3.
alter table ccat.question_set_versions
  add column if not exists battery_durations jsonb;

-- Backfill existing exam papers: split the single duration evenly across the three batteries
-- (e.g. 30 -> 10/10/10; the remainder lands on quantitative so the parts sum to the total).
update ccat.question_set_versions sv
set battery_durations = jsonb_build_object(
      'verbal',       floor(coalesce(sv.duration_minutes, 30) / 3.0)::int,
      'non_verbal',   floor(coalesce(sv.duration_minutes, 30) / 3.0)::int,
      'quantitative', (coalesce(sv.duration_minutes, 30) - 2 * floor(coalesce(sv.duration_minutes, 30) / 3.0)::int)::int
    )
where sv.allowed_exam = true
  and sv.battery_durations is null;

-- 2) Per-(session, battery) timing. Row is created when the student STARTS that battery;
-- deadline_at is fixed at start (wall-clock). completed_at is set when the battery is ended
-- (manually or when its timer expires). A battery with a passed deadline is locked.
create table if not exists ccat.session_batteries (
  session_id    uuid not null references ccat.sessions(id) on delete cascade,
  category_key  text not null,
  started_at    timestamptz not null default now(),
  deadline_at   timestamptz not null,
  completed_at  timestamptz,
  primary key (session_id, category_key)
);

create index if not exists session_batteries_deadline_idx
  on ccat.session_batteries(deadline_at)
  where completed_at is null;
