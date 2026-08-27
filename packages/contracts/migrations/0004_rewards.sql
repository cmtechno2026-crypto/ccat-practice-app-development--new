-- ============================================================================
-- CCAT Practice App — Database Migration 0004
-- XP/coin ledgers, achievements, avatars, themes
-- Blueprint §19, §20, §31.4
--
-- Ledgers are APPEND-ONLY (§19.1, §19.2, §36.3). Corrections are compensating
-- entries (§19.3), never overwrites. A unique source reference makes duplicate
-- reward inserts fail even on upstream retry (§13.3).
-- ============================================================================
set search_path = ccat, public;

-- ----------------------------------------------------------------------------
-- XP ledger (§19.1). Signed deltas; balance = sum(delta).
-- source_ref is unique per (student, source_kind, source_id) so a retried submit
-- or achievement grant can never double-award (§13.3).
-- ----------------------------------------------------------------------------
create table ccat.xp_transactions (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references ccat.students(id) on delete cascade,
  delta         bigint not null,          -- may be negative for admin corrections
  source_kind   text not null,            -- 'session_submit'|'achievement'|'admin_adjustment'
  source_id     text not null,            -- session_id / achievement grant id / adjustment id
  reason        text,
  actor_admin_id uuid references ccat.admin_profiles(id),  -- set for admin adjustments (§19.3)
  config_version_id uuid references ccat.config_versions(id), -- xp ruleset used
  created_at    timestamptz not null default now(),
  constraint xp_tx_source_unique unique (student_id, source_kind, source_id)
);
create trigger no_mutation before update or delete on ccat.xp_transactions
  for each row execute function ccat.tg_forbid_mutation();
create index xp_tx_student_idx on ccat.xp_transactions(student_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Coin ledger (§19.2). Same append-only + idempotent source semantics.
-- ----------------------------------------------------------------------------
create table ccat.coin_transactions (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references ccat.students(id) on delete cascade,
  delta         bigint not null,
  source_kind   text not null,            -- 'achievement'|'admin_adjustment'|'reward_rule'
  source_id     text not null,
  reason        text,
  actor_admin_id uuid references ccat.admin_profiles(id),
  created_at    timestamptz not null default now(),
  constraint coin_tx_source_unique unique (student_id, source_kind, source_id)
);
create trigger no_mutation before update or delete on ccat.coin_transactions
  for each row execute function ccat.tg_forbid_mutation();
create index coin_tx_student_idx on ccat.coin_transactions(student_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Avatars: configurable families x stages (§20.1). No hard-coded 5 or 7.
-- ----------------------------------------------------------------------------
create table ccat.avatar_families (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,
  name          text not null,
  display_order int not null default 0,
  active        boolean not null default true,       -- soft-retire; existing owners keep grants
  created_at    timestamptz not null default now()
);
create table ccat.avatar_stages (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references ccat.avatar_families(id),
  stage_number  int not null,
  name          text not null,
  asset_id      uuid references ccat.content_assets(id),
  required_xp   bigint,                                -- server-confirmed XP threshold (§20.1)
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint avatar_stage_unique unique (family_id, stage_number)
);

-- ----------------------------------------------------------------------------
-- Themes: versioned unlock rule expressions; no premium/payment references (§20.2)
-- ----------------------------------------------------------------------------
create table ccat.themes (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,
  name          text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create table ccat.theme_unlock_rules (
  id            uuid primary key default gen_random_uuid(),
  theme_id      uuid not null references ccat.themes(id),
  version_number int not null,
  rule_expr     jsonb not null,                        -- versioned rule (no payment refs)
  active        boolean not null default false,
  created_at    timestamptz not null default now(),
  constraint theme_rule_version_unique unique (theme_id, version_number)
);

-- Close deferred FKs on students (active avatar stage / theme).
alter table ccat.students
  add constraint students_active_avatar_fk
  foreign key (active_avatar_stage_id) references ccat.avatar_stages(id);
alter table ccat.students
  add constraint students_active_theme_fk
  foreign key (active_theme_id) references ccat.themes(id);

-- ----------------------------------------------------------------------------
-- Achievements + versions + rewards (§19.4). Reward grants + ledger writes atomic.
-- ----------------------------------------------------------------------------
create table ccat.achievements (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,
  name          text not null,
  created_at    timestamptz not null default now()
);
create table ccat.achievement_versions (
  id             uuid primary key default gen_random_uuid(),
  achievement_id uuid not null references ccat.achievements(id),
  version_number int not null,
  criteria       jsonb not null,          -- evaluation rule
  active         boolean not null default false,
  created_at     timestamptz not null default now(),
  constraint achievement_version_unique unique (achievement_id, version_number)
);
create table ccat.achievement_rewards (
  id                     uuid primary key default gen_random_uuid(),
  achievement_version_id uuid not null references ccat.achievement_versions(id),
  reward_kind            text not null check (reward_kind in ('xp','coins','avatar','theme','badge')),
  xp_amount              bigint,
  coin_amount            bigint,
  avatar_stage_id        uuid references ccat.avatar_stages(id),
  theme_id               uuid references ccat.themes(id)
);

-- Student grants (append-only; a student earns an achievement version once).
create table ccat.student_achievements (
  id                     uuid primary key default gen_random_uuid(),
  student_id             uuid not null references ccat.students(id) on delete cascade,
  achievement_version_id uuid not null references ccat.achievement_versions(id),
  granted_from_session_id uuid references ccat.sessions(id),
  created_at             timestamptz not null default now(),
  constraint student_achievement_unique unique (student_id, achievement_version_id)
);
create trigger no_mutation before update or delete on ccat.student_achievements
  for each row execute function ccat.tg_forbid_mutation();

create table ccat.student_avatar_grants (
  student_id      uuid not null references ccat.students(id) on delete cascade,
  avatar_stage_id uuid not null references ccat.avatar_stages(id),
  source_kind     text not null default 'xp' check (source_kind in ('xp','achievement','admin')),
  created_at      timestamptz not null default now(),
  primary key (student_id, avatar_stage_id)
);

create table ccat.student_theme_grants (
  student_id  uuid not null references ccat.students(id) on delete cascade,
  theme_id    uuid not null references ccat.themes(id),
  source_kind text not null default 'achievement' check (source_kind in ('achievement','admin','rule')),
  created_at  timestamptz not null default now(),
  primary key (student_id, theme_id)
);
