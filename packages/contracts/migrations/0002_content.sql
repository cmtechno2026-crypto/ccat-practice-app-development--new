-- ============================================================================
-- CCAT Practice App — Database Migration 0002
-- Content hierarchy, versioning, review workflow, learning plans
-- Blueprint §8, §17, §18, §31.2
--
-- Hierarchy (§8.1): Grade -> Category -> Subcategory -> Logical Set ->
--                   Set Version -> Question Version
-- Published set/question versions are IMMUTABLE (§8.1, §17.5, §18.2).
-- ============================================================================
set search_path = ccat, public;

-- ----------------------------------------------------------------------------
-- Categories / subcategories (verbal, quantitative, non-verbal reasoning; §2.1)
-- Data-driven, not enums.
-- ----------------------------------------------------------------------------
create table ccat.categories (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,     -- 'verbal' | 'quantitative' | 'non_verbal'
  name          text not null,
  display_order int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger set_updated_at before update on ccat.categories
  for each row execute function ccat.tg_set_updated_at();

create table ccat.subcategories (
  id            uuid primary key default gen_random_uuid(),
  category_id   uuid not null references ccat.categories(id),
  key           text not null,
  name          text not null,
  display_order int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint subcategories_key_unique unique (category_id, key)
);
create trigger set_updated_at before update on ccat.subcategories
  for each row execute function ccat.tg_set_updated_at();

-- Difficulty is data-driven (labels + weight). Launch labels: easy/medium/hard (§19.1).
create table ccat.difficulties (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,     -- 'easy'|'medium'|'hard'
  name          text not null,
  weight        numeric not null default 1.0,  -- used by Readiness difficulty-weighting (§16.2)
  display_order int not null default 0
);

-- ----------------------------------------------------------------------------
-- Managed content assets (§17.5, §34). Immutable; corrections create new assets.
-- Client never receives arbitrary URLs; media served via Gateway-authorized URLs.
-- ----------------------------------------------------------------------------
create table ccat.content_assets (
  id             uuid primary key default gen_random_uuid(),
  storage_key    text not null,           -- object key in Supabase Storage (private bucket)
  mime_type      text not null,
  byte_size      bigint,
  checksum_sha256 text not null,
  width          int,
  height         int,
  alt_text       text,                    -- accessibility metadata (§17.4)
  safe_description text,                   -- assessment-safe description (does not reveal answer)
  created_by     uuid references ccat.admin_profiles(id),
  created_at     timestamptz not null default now()
);
-- Assets are immutable once referenced; no updated_at.

-- ----------------------------------------------------------------------------
-- Logical questions + immutable question versions (§17.1)
-- ----------------------------------------------------------------------------
create table ccat.logical_questions (
  id            uuid primary key default gen_random_uuid(),
  category_id   uuid not null references ccat.categories(id),
  subcategory_id uuid not null references ccat.subcategories(id),
  created_by    uuid references ccat.admin_profiles(id),
  created_at    timestamptz not null default now()
);

create table ccat.question_versions (
  id                 uuid primary key default gen_random_uuid(),
  logical_question_id uuid not null references ccat.logical_questions(id),
  version_number     int not null,
  grade_id           uuid not null references ccat.grades(id),
  difficulty_id      uuid not null references ccat.difficulties(id),
  question_type      text not null,       -- e.g. 'analogy'|'series'|'odd_one_out'|... (data-driven label)
  -- Structured typed content (§17.2). Validated against question-schema.json before publish.
  prompt_blocks      jsonb not null,      -- array of typed blocks
  option_blocks      jsonb not null,      -- array of options, each with stable option_id (§17.3)
  correct_option_ids text[] not null,     -- references stable option_id(s), never positions
  explanation_blocks jsonb,               -- shown in Practice review only
  accessibility      jsonb,               -- per-block a11y metadata (§17.4)
  provenance         jsonb,               -- draft origin + editor feedback (§18.1)
  state              ccat.content_state not null default 'draft',
  published_at       timestamptz,
  retired_at         timestamptz,
  created_by         uuid references ccat.admin_profiles(id),
  created_at         timestamptz not null default now(),
  constraint question_versions_number_unique unique (logical_question_id, version_number),
  constraint question_versions_correct_not_empty check (array_length(correct_option_ids,1) >= 1)
);
create index question_versions_lq_idx on ccat.question_versions(logical_question_id);
create index question_versions_state_idx on ccat.question_versions(state);
create index question_versions_grade_diff_idx on ccat.question_versions(grade_id, difficulty_id);

-- Guard: a PUBLISHED question version's content is immutable. Only state->retired and
-- retired_at may change after publication (§17.5, §18.2). Enforced by trigger.
create or replace function ccat.tg_question_version_immutable()
returns trigger language plpgsql set search_path = ccat, public as $$
begin
  if old.state = 'published' then
    if new.prompt_blocks is distinct from old.prompt_blocks
       or new.option_blocks is distinct from old.option_blocks
       or new.correct_option_ids is distinct from old.correct_option_ids
       or new.explanation_blocks is distinct from old.explanation_blocks
       or new.grade_id is distinct from old.grade_id
       or new.difficulty_id is distinct from old.difficulty_id
       or new.question_type is distinct from old.question_type then
      raise exception 'Published question_version % is immutable; create a new version (§18.2)', old.id
        using errcode = 'restrict_violation';
    end if;
    if new.state not in ('published','retired') then
      raise exception 'Published question_version % may only transition to retired', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger question_version_immutable before update on ccat.question_versions
  for each row execute function ccat.tg_question_version_immutable();

-- ----------------------------------------------------------------------------
-- Question sets and immutable set versions (§8.1, §8.2)
-- ----------------------------------------------------------------------------
create table ccat.question_sets (
  id            uuid primary key default gen_random_uuid(),
  grade_id      uuid not null references ccat.grades(id),
  category_id   uuid not null references ccat.categories(id),
  subcategory_id uuid not null references ccat.subcategories(id),
  name          text not null,
  created_by    uuid references ccat.admin_profiles(id),
  created_at    timestamptz not null default now()
);

create table ccat.question_set_versions (
  id              uuid primary key default gen_random_uuid(),
  question_set_id uuid not null references ccat.question_sets(id),
  version_number  int not null,
  difficulty_id   uuid references ccat.difficulties(id),  -- set-level difficulty label (§8.4)
  allowed_practice boolean not null default true,          -- §8.3 a set may enable one or both
  allowed_exam     boolean not null default false,
  allowed_timers   jsonb not null default '[]'::jsonb,     -- e.g. [{"type":"untimed"},{"type":"timed","seconds":600}]
  question_count   int not null,                            -- must satisfy active set-size policy 5..20 (§8.2)
  state            ccat.content_state not null default 'draft',
  ruleset_version_id uuid references ccat.config_versions(id), -- ruleset pinned at publish (§30)
  published_at     timestamptz,
  retired_at       timestamptz,
  created_by       uuid references ccat.admin_profiles(id),
  created_at       timestamptz not null default now(),
  constraint set_versions_number_unique unique (question_set_id, version_number),
  constraint set_versions_size_hard_bounds check (question_count between 5 and 20), -- §8.2 hard platform bounds
  constraint set_versions_mode_enabled check (allowed_practice or allowed_exam)
);
create index set_versions_set_idx on ccat.question_set_versions(question_set_id);
create index set_versions_state_idx on ccat.question_set_versions(state);

-- Ordered membership of question versions in a set version (immutable once published).
create table ccat.set_version_questions (
  set_version_id     uuid not null references ccat.question_set_versions(id),
  question_version_id uuid not null references ccat.question_versions(id),
  position           int not null,   -- authoring order; runtime order derives from question_order_seed
  primary key (set_version_id, question_version_id),
  constraint set_version_questions_position_unique unique (set_version_id, position)
);

-- Same immutability guard pattern for published set versions.
create or replace function ccat.tg_set_version_immutable()
returns trigger language plpgsql set search_path = ccat, public as $$
begin
  if old.state = 'published' then
    if new.question_count is distinct from old.question_count
       or new.allowed_practice is distinct from old.allowed_practice
       or new.allowed_exam is distinct from old.allowed_exam
       or new.allowed_timers is distinct from old.allowed_timers
       or new.ruleset_version_id is distinct from old.ruleset_version_id then
      raise exception 'Published set_version % is immutable; create a new version (§8.1)', old.id
        using errcode = 'restrict_violation';
    end if;
    if new.state not in ('published','retired') then
      raise exception 'Published set_version % may only transition to retired', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger set_version_immutable before update on ccat.question_set_versions
  for each row execute function ccat.tg_set_version_immutable();

-- ----------------------------------------------------------------------------
-- Content review workflow (§18). Two-stage: question-level review + independent
-- whole-set expert review. The whole-set approver MUST differ from the question
-- reviewer (§18.1) — enforced in the service layer; recorded here for audit.
-- ----------------------------------------------------------------------------
create table ccat.content_reviews (
  id             uuid primary key default gen_random_uuid(),
  target_kind    text not null check (target_kind in ('question_version','set_version')),
  target_id      uuid not null,
  review_stage   text not null check (review_stage in
                    ('automated_checks','question_review','set_expert_review')),
  reviewer_id    uuid references ccat.admin_profiles(id),
  decision       text not null check (decision in ('approved','rejected','changes_requested')),
  feedback       text,                    -- retained review rejection/edit feedback (§18.1)
  created_at     timestamptz not null default now()
);
create index content_reviews_target_idx on ccat.content_reviews(target_kind, target_id);

-- ----------------------------------------------------------------------------
-- Learning plans & versions (§15, §31.2). Progress references a plan version.
-- ----------------------------------------------------------------------------
create table ccat.learning_plans (
  id          uuid primary key default gen_random_uuid(),
  grade_id    uuid not null references ccat.grades(id),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table ccat.learning_plan_versions (
  id               uuid primary key default gen_random_uuid(),
  learning_plan_id uuid not null references ccat.learning_plans(id),
  version_number   int not null,
  is_active        boolean not null default false,
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  constraint lpv_number_unique unique (learning_plan_id, version_number)
);
create unique index lpv_one_active_per_grade
  on ccat.learning_plan_versions(learning_plan_id) where is_active;

-- Eligible logical sets that count toward Progress coverage for a plan version (§15.1).
create table ccat.learning_plan_sets (
  learning_plan_version_id uuid not null references ccat.learning_plan_versions(id),
  question_set_id          uuid not null references ccat.question_sets(id),
  primary key (learning_plan_version_id, question_set_id)
);
