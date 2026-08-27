-- ============================================================================
-- CCAT Practice App — Database Migration 0003
-- Sessions, answers, submissions, results, completions, bookmarks, progress
-- Blueprint §9, §10, §11, §12, §13, §14, §15, §16, §31.3
--
-- Core invariants enforced here:
--   * At most one IN_PROGRESS session per student (§9.1).
--   * Exactly one authoritative terminal submission per session (§13.1).
--   * Answers versioned; stale writes rejected (§12.2).
--   * Session is immutable w.r.t. set version/mode/timer/ruleset/seeds after start (§9.2).
-- ============================================================================
set search_path = ccat, public;

-- ----------------------------------------------------------------------------
-- Sessions — Gateway-created, immutable core (§9.2)
-- ----------------------------------------------------------------------------
create table ccat.sessions (
  id                       uuid primary key default gen_random_uuid(),
  student_id               uuid not null references ccat.students(id) on delete cascade,
  student_device_id        uuid not null references ccat.student_devices(id),
  set_version_id           uuid not null references ccat.question_set_versions(id),
  learning_plan_version_id uuid references ccat.learning_plan_versions(id),
  ruleset_version_id       uuid references ccat.config_versions(id),
  mode                     ccat.learning_mode not null,
  timer_type               ccat.timer_type not null,
  duration_seconds         int,                         -- null for untimed
  question_order_seed      bigint not null,             -- server-generated shuffle seed (§9.2)
  option_order_seed        bigint not null,
  state                    ccat.session_state not null default 'IN_PROGRESS',
  session_version          int not null default 1,      -- optimistic concurrency for submit (§13.1)
  started_at               timestamptz not null default now(),
  deadline_at              timestamptz,                 -- set when timed (§9.2, §14)
  last_activity_at         timestamptz not null default now(), -- for inactivity abandon (§10.1)
  terminal_at              timestamptz,
  created_at               timestamptz not null default now(),
  constraint sessions_timed_requires_duration
    check (timer_type = 'untimed' or duration_seconds is not null),
  constraint sessions_timed_requires_deadline
    check (timer_type = 'untimed' or deadline_at is not null)
);
-- One active learning session per student (§9.1). Second start -> ACTIVE_SESSION_EXISTS.
create unique index sessions_one_in_progress
  on ccat.sessions(student_id) where state = 'IN_PROGRESS';
create index sessions_student_idx on ccat.sessions(student_id, started_at desc);
create index sessions_deadline_idx on ccat.sessions(deadline_at)
  where state = 'IN_PROGRESS' and deadline_at is not null;

-- Guard: immutable session fields after creation; a terminal state never returns
-- to IN_PROGRESS (§9.3).
create or replace function ccat.tg_session_guard()
returns trigger language plpgsql set search_path = ccat, public as $$
begin
  if new.set_version_id is distinct from old.set_version_id
     or new.mode is distinct from old.mode
     or new.timer_type is distinct from old.timer_type
     or new.duration_seconds is distinct from old.duration_seconds
     or new.question_order_seed is distinct from old.question_order_seed
     or new.option_order_seed is distinct from old.option_order_seed
     or new.ruleset_version_id is distinct from old.ruleset_version_id
     or new.started_at is distinct from old.started_at then
    raise exception 'Session % core fields are immutable after start (§9.2)', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.state <> 'IN_PROGRESS' and new.state = 'IN_PROGRESS' then
    raise exception 'Terminal session % cannot return to IN_PROGRESS (§9.3)', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger session_guard before update on ccat.sessions
  for each row execute function ccat.tg_session_guard();

-- ----------------------------------------------------------------------------
-- Session answers — versioned autosave target (§12). Server rejects stale writes.
-- One row per (session, question_version); answer_version increments monotonically.
-- ----------------------------------------------------------------------------
create table ccat.session_answers (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references ccat.sessions(id) on delete cascade,
  question_version_id uuid not null references ccat.question_versions(id),
  selected_option_ids text[] not null default '{}',   -- stable option_ids (§17.3)
  answer_version     int not null default 1,           -- monotonic; stale writes rejected (§12.2)
  is_locked          boolean not null default false,   -- true once outcome commits (§12.3)
  updated_at         timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  constraint session_answers_unique unique (session_id, question_version_id)
);
create index session_answers_session_idx on ccat.session_answers(session_id);

-- Guard: no answer changes once locked (§12.3). answer_version must strictly increase.
create or replace function ccat.tg_session_answer_guard()
returns trigger language plpgsql set search_path = ccat, public as $$
begin
  if old.is_locked then
    raise exception 'Answer % is locked after submission (§12.3)', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.answer_version <= old.answer_version
     and (new.selected_option_ids is distinct from old.selected_option_ids) then
    raise exception 'Stale answer write for % (version % <= %) (§12.2)',
      old.id, new.answer_version, old.answer_version
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger session_answer_guard before update on ccat.session_answers
  for each row execute function ccat.tg_session_answer_guard();

-- ----------------------------------------------------------------------------
-- Session events — append-only lifecycle/telemetry breadcrumbs (§31.3)
-- ----------------------------------------------------------------------------
create table ccat.session_events (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references ccat.sessions(id) on delete cascade,
  event_type  text not null,   -- 'start'|'answer'|'navigate'|'background'|'resume'|'submit'|'auto_submit'|'abandon'|...
  payload     jsonb,
  created_at  timestamptz not null default now()
);
create trigger no_mutation before update or delete on ccat.session_events
  for each row execute function ccat.tg_forbid_mutation();
create index session_events_session_idx on ccat.session_events(session_id, created_at);

-- ----------------------------------------------------------------------------
-- Session submissions — EXACTLY ONE authoritative terminal submission (§13.1)
-- The unique(session_id) constraint is the exactly-once guarantee. The idempotency
-- key deduplicates client retries; a repeat submission_id returns the original.
-- ----------------------------------------------------------------------------
create table ccat.session_submissions (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references ccat.sessions(id),
  submission_id     text not null,        -- client idempotency key (§13.1)
  finalized_by      text not null check (finalized_by in ('manual','deadline','worker')),
  expected_session_version int not null,
  created_at        timestamptz not null default now(),
  constraint session_submissions_one_per_session unique (session_id),         -- exactly-once (§13.1)
  constraint session_submissions_idem_unique      unique (session_id, submission_id)
);
create trigger no_mutation before update or delete on ccat.session_submissions
  for each row execute function ccat.tg_forbid_mutation();

-- ----------------------------------------------------------------------------
-- Session results — immutable authoritative outcome (§13.2)
-- ----------------------------------------------------------------------------
create table ccat.session_results (
  session_id       uuid primary key references ccat.sessions(id),
  submission_pk    uuid not null references ccat.session_submissions(id),
  terminal_state   ccat.session_state not null,   -- SUBMITTED | AUTO_SUBMITTED | ...
  score_correct    int not null default 0,
  score_total      int not null default 0,
  xp_awarded       bigint not null default 0,
  coins_awarded    bigint not null default 0,
  detail           jsonb,                          -- per-question correctness snapshot
  created_at       timestamptz not null default now()
);
create trigger no_mutation before update or delete on ccat.session_results
  for each row execute function ccat.tg_forbid_mutation();

-- ----------------------------------------------------------------------------
-- Set completions — coverage credit for Progress (§15). Repeat completion of the
-- same logical set does not increase coverage: unique(student, question_set,
-- learning_plan_version).
-- ----------------------------------------------------------------------------
create table ccat.set_completions (
  id                       uuid primary key default gen_random_uuid(),
  student_id               uuid not null references ccat.students(id) on delete cascade,
  question_set_id          uuid not null references ccat.question_sets(id),
  learning_plan_version_id uuid not null references ccat.learning_plan_versions(id),
  first_session_id         uuid not null references ccat.sessions(id),
  mode                     ccat.learning_mode not null,
  created_at               timestamptz not null default now(),
  constraint set_completions_unique_coverage
    unique (student_id, question_set_id, learning_plan_version_id)  -- §15.2 no double-count
);
create index set_completions_student_idx on ccat.set_completions(student_id);

-- ----------------------------------------------------------------------------
-- Bookmarks (§10.1, §32.4)
-- ----------------------------------------------------------------------------
create table ccat.bookmarks (
  student_id          uuid not null references ccat.students(id) on delete cascade,
  logical_question_id uuid not null references ccat.logical_questions(id),
  note                text,
  created_at          timestamptz not null default now(),
  primary key (student_id, logical_question_id)
);

-- ----------------------------------------------------------------------------
-- Progress snapshots — versioned learning-plan coverage rollups (§15)
-- ----------------------------------------------------------------------------
create table ccat.student_progress_snapshots (
  id                       uuid primary key default gen_random_uuid(),
  student_id               uuid not null references ccat.students(id) on delete cascade,
  learning_plan_version_id uuid not null references ccat.learning_plan_versions(id),
  completed_count          int not null,
  eligible_count           int not null,
  progress_pct             numeric not null,          -- completed/eligible*100 (§15.1)
  category_breakdown       jsonb,                      -- {category_key: {completed, eligible}}
  computed_at              timestamptz not null default now()
);
create index progress_snapshots_student_idx
  on ccat.student_progress_snapshots(student_id, computed_at desc);

-- ----------------------------------------------------------------------------
-- Readiness snapshots — versioned, server-computed practice-performance model (§16)
-- Insufficient activity => insufficient_data = true (NOT 0%) (§16.3).
-- ----------------------------------------------------------------------------
create table ccat.readiness_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  student_id         uuid not null references ccat.students(id) on delete cascade,
  model_version_id   uuid references ccat.config_versions(id),  -- readiness config version
  readiness_pct      numeric,                    -- null when insufficient_data
  insufficient_data  boolean not null default false,
  window_questions   int,                        -- questions in the rolling window
  band               text,                       -- configured band label if any
  computed_at        timestamptz not null default now()
);
create index readiness_snapshots_student_idx
  on ccat.readiness_snapshots(student_id, computed_at desc);
