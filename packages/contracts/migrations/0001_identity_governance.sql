-- ============================================================================
-- CCAT Practice App — Database Migration 0001
-- Identity, governance, guardians, devices, consent, admin, audit
-- Blueprint §3, §4, §5, §6, §7, §22, §25, §29, §30, §31.1
-- ============================================================================
set search_path = ccat, public;

-- ----------------------------------------------------------------------------
-- Grade catalog (data-driven; clients MUST NOT hard-code [3,4,5,6]) — §29
-- ----------------------------------------------------------------------------
create table ccat.grades (
  id                   uuid primary key default gen_random_uuid(),
  grade_number         int  not null,                 -- e.g. 3,4,5,6 at launch
  name                 text not null,                 -- e.g. "Grade 3"
  display_order        int  not null default 0,
  active               boolean not null default true,
  registration_enabled boolean not null default true, -- §29: independent of active students
  practice_enabled     boolean not null default true, -- §29: separate explicit control
  age_min_years        int,                           -- configured age bounds (§4.3)
  age_max_years        int,
  promotion_target_id  uuid references ccat.grades(id),
  retired_at           timestamptz,                   -- referenced grades are retired, not deleted
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint grades_number_unique unique (grade_number),
  constraint grades_age_bounds_ck check (age_min_years is null or age_max_years is null
                                          or age_min_years <= age_max_years)
);
create trigger set_updated_at before update on ccat.grades
  for each row execute function ccat.tg_set_updated_at();

-- ----------------------------------------------------------------------------
-- Versioned configuration (immutable publications) — §30
-- A single table capturing config_versions; policy-scoped payload in JSONB.
-- Grade policy above is a convenience projection; authoritative economic/content
-- rulesets are versioned here and referenced by sessions (ruleset_version).
-- ----------------------------------------------------------------------------
create table ccat.config_versions (
  id             uuid primary key default gen_random_uuid(),
  domain         text not null,          -- 'grade_config'|'xp'|'readiness'|'set_size'|'availability'|...
  version_label  text not null,          -- human label, e.g. "xp-v1"
  payload        jsonb not null,         -- immutable config document
  effective_at   timestamptz not null default now(),
  is_active      boolean not null default false,
  published_by   uuid,                   -- admin_profiles.id (FK added after that table)
  published_at   timestamptz not null default now(),
  superseded_by  uuid references ccat.config_versions(id),
  created_at     timestamptz not null default now(),
  constraint config_versions_domain_label_unique unique (domain, version_label)
);
-- Only one active version per domain at a time.
create unique index config_versions_one_active_per_domain
  on ccat.config_versions(domain) where is_active;
-- Immutable payload: forbid UPDATE of payload; activation is via is_active/superseded_by
-- (handled by a narrower policy in the service; publications themselves never rewrite payload).

-- ----------------------------------------------------------------------------
-- Admin profiles, permissions, bundles — §22, §23
-- Admin identity itself lives in Supabase Auth (auth.users). admin_profiles is
-- the business projection keyed by the auth user id.
-- ----------------------------------------------------------------------------
create table ccat.admin_profiles (
  id                 uuid primary key,               -- == auth.users.id (Supabase Auth)
  email              citext not null,
  display_name       text not null,
  security_role      ccat.admin_security_role not null default 'admin',
  status             text not null default 'active'  -- active | disabled
                     check (status in ('active','disabled')),
  mfa_enrolled       boolean not null default false, -- §22.2 mandatory before normal access
  must_change_password boolean not null default true,-- §22.2 temp password first login
  password_set_at    timestamptz,
  created_by         uuid references ccat.admin_profiles(id),
  disabled_at        timestamptz,
  disabled_reason    text,
  version            int not null default 1,         -- optimistic concurrency / ETag (§22.4)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint admin_email_unique unique (email)
);
create trigger set_updated_at before update on ccat.admin_profiles
  for each row execute function ccat.tg_set_updated_at();

-- Close the config_versions.published_by FK now that admin_profiles exists.
alter table ccat.config_versions
  add constraint config_versions_published_by_fk
  foreign key (published_by) references ccat.admin_profiles(id);

-- Permission catalog: the authoritative list of permission keys (see permission-catalog.md).
create table ccat.permissions (
  key          text primary key,           -- e.g. 'student.suspend', 'content.publish'
  description  text not null,
  super_admin_only boolean not null default false, -- §23: some caps are Super-Admin exclusive
  created_at   timestamptz not null default now()
);

-- Grant of a permission to an admin. Super-Admin implicitly holds all permissions;
-- explicit grants apply to normal admins (§22.1 "load from DB, UI flags not boundaries").
create table ccat.admin_permissions (
  admin_id     uuid not null references ccat.admin_profiles(id) on delete cascade,
  permission_key text not null references ccat.permissions(key),
  granted_by   uuid not null references ccat.admin_profiles(id),
  granted_at   timestamptz not null default now(),
  primary key (admin_id, permission_key)
);

-- Optional display/access bundles (convenience only; NOT authorization) — §3.2, §22.3
create table ccat.admin_permission_bundles (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique,       -- 'content'|'student_support'|'communications'|'operations'
  name         text not null,
  description  text
);
create table ccat.admin_bundle_permissions (
  bundle_id      uuid not null references ccat.admin_permission_bundles(id) on delete cascade,
  permission_key text not null references ccat.permissions(key),
  primary key (bundle_id, permission_key)
);
create table ccat.admin_profile_bundles (
  admin_id   uuid not null references ccat.admin_profiles(id) on delete cascade,
  bundle_id  uuid not null references ccat.admin_permission_bundles(id) on delete cascade,
  primary key (admin_id, bundle_id)
);

-- ----------------------------------------------------------------------------
-- Students (§31.1). Age is DERIVED, never stored as an authoritative field.
-- ----------------------------------------------------------------------------
create table ccat.students (
  id                     uuid primary key default gen_random_uuid(),
  username_normalized    citext not null,             -- unique login handle
  display_name           text not null,
  grade_id               uuid not null references ccat.grades(id),
  birth_month            int  not null check (birth_month between 1 and 12),
  birth_year             int  not null check (birth_year between 1990 and 2100),
  timezone               text not null default 'America/Toronto',
  status                 ccat.student_status not null default 'active',
  active_avatar_stage_id uuid,                         -- FK added in 0004 (rewards)
  active_theme_id        uuid,                         -- FK added in 0004 (rewards)
  -- Cached reward values are DENORMALIZED CONVENIENCE ONLY; ledgers are authoritative (§19).
  cached_xp_total        bigint not null default 0,
  cached_coin_balance    bigint not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint students_username_unique unique (username_normalized)
  -- NOTE: no birth_date, no age column. Age = f(now(), birth_month, birth_year) at the Gateway (§4.2).
);
create trigger set_updated_at before update on ccat.students
  for each row execute function ccat.tg_set_updated_at();
create index students_grade_idx on ccat.students(grade_id);
create index students_status_idx on ccat.students(status);

-- PIN verifier stored separately, never returned, never logged (§4.4).
create table ccat.student_credentials (
  student_id     uuid primary key references ccat.students(id) on delete cascade,
  pin_hash       text not null,          -- e.g. argon2id verifier; NEVER the raw PIN
  pin_algo       text not null default 'argon2id',
  failed_attempts int not null default 0, -- server-side brute-force tracking (§4.4, §36.1)
  locked_until   timestamptz,
  updated_at     timestamptz not null default now()
);
create trigger set_updated_at before update on ccat.student_credentials
  for each row execute function ccat.tg_set_updated_at();

-- ----------------------------------------------------------------------------
-- Guardian model (§3.3): contacts + linkage. No separate guardian login.
-- Admin Web may display/search raw guardian email/phone for authorized users (§24).
-- ----------------------------------------------------------------------------
create table ccat.guardian_contacts (
  id               uuid primary key default gen_random_uuid(),
  email            citext,
  phone            text,                 -- E.164 normalized
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint guardian_contact_has_channel check (email is not null or phone is not null)
);
create trigger set_updated_at before update on ccat.guardian_contacts
  for each row execute function ccat.tg_set_updated_at();

create table ccat.student_guardians (
  student_id   uuid not null references ccat.students(id) on delete cascade,
  guardian_id  uuid not null references ccat.guardian_contacts(id),
  relationship text,                     -- configured consent authority/relationship (§4.1)
  is_primary   boolean not null default true,
  created_at   timestamptz not null default now(),
  primary key (student_id, guardian_id)
);

-- ----------------------------------------------------------------------------
-- Consent records: immutable, versioned (§4.5). Append-only.
-- ----------------------------------------------------------------------------
create table ccat.consents (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references ccat.students(id) on delete cascade,
  guardian_id    uuid not null references ccat.guardian_contacts(id),
  policy_version text not null,          -- terms/policy version
  consent_hash   text not null,          -- hash of consent text presented
  evidence       jsonb,                  -- minimized evidence per privacy policy
  created_at     timestamptz not null default now()
);
create trigger no_mutation before update or delete on ccat.consents
  for each row execute function ccat.tg_forbid_mutation();
create index consents_student_idx on ccat.consents(student_id);

-- ----------------------------------------------------------------------------
-- Devices — single active device invariant (§5.1, §31.1)
-- ----------------------------------------------------------------------------
create table ccat.student_devices (
  id                uuid primary key default gen_random_uuid(),
  student_id        uuid not null references ccat.students(id) on delete cascade,
  device_hash       text not null,        -- opaque device identifier/hash
  installation_pubkey text,               -- installation public key for request proof (§36.1)
  platform          text,                 -- 'ios' | 'android'
  attestation_state text,                 -- pass | fail | unknown / provider-specific
  status            ccat.device_status not null default 'pending',
  enrolled_at       timestamptz,
  last_seen_at      timestamptz,
  revoked_at        timestamptz,
  revoked_reason    text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger set_updated_at before update on ccat.student_devices
  for each row execute function ccat.tg_set_updated_at();
-- THE invariant: at most one ACTIVE device per student (§5.1). Partial unique index.
create unique index student_devices_one_active
  on ccat.student_devices(student_id) where status = 'active';
create index student_devices_student_idx on ccat.student_devices(student_id);

-- ----------------------------------------------------------------------------
-- Application auth sessions (student token families) — §5.4, §31.1
-- ----------------------------------------------------------------------------
create table ccat.auth_sessions (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references ccat.students(id) on delete cascade,
  device_id      uuid not null references ccat.student_devices(id) on delete cascade,
  token_family   uuid not null default gen_random_uuid(),
  refresh_hash   text not null,          -- rotating refresh token verifier
  issued_at      timestamptz not null default now(),
  last_used_at   timestamptz,
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text,
  created_at     timestamptz not null default now()
);
create index auth_sessions_student_idx on ccat.auth_sessions(student_id) where revoked_at is null;
create index auth_sessions_family_idx  on ccat.auth_sessions(token_family);

-- ----------------------------------------------------------------------------
-- Student status history — append-only (§6.3)
-- ----------------------------------------------------------------------------
create table ccat.student_status_events (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references ccat.students(id) on delete cascade,
  from_status    ccat.student_status,
  to_status      ccat.student_status not null,
  reason_code    text not null,
  reason_text    text,
  actor_admin_id uuid references ccat.admin_profiles(id),  -- null = system/guardian-initiated
  actor_kind     text not null default 'admin' check (actor_kind in ('admin','system','guardian')),
  effective_at   timestamptz not null default now(),
  expires_at     timestamptz,             -- suspensions may auto-expire (§6.2)
  reference      text,                    -- support/incident/request reference
  created_at     timestamptz not null default now()
);
create trigger no_mutation before update or delete on ccat.student_status_events
  for each row execute function ccat.tg_forbid_mutation();
create index student_status_events_student_idx on ccat.student_status_events(student_id);

-- ----------------------------------------------------------------------------
-- Deletion & export requests (§7, §32.3)
-- ----------------------------------------------------------------------------
create table ccat.deletion_requests (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references ccat.students(id) on delete cascade,
  requested_by_kind text not null default 'guardian'
                    check (requested_by_kind in ('guardian','admin_override')),
  actor_admin_id uuid references ccat.admin_profiles(id),
  reason         text,
  reference      text,                    -- legal/support reference (override path §7.2)
  restore_deadline timestamptz not null,  -- default now()+30d (§7.1)
  state          text not null default 'pending_deletion'
                    check (state in ('pending_deletion','restored','purged')),
  restored_at    timestamptz,
  purged_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger set_updated_at before update on ccat.deletion_requests
  for each row execute function ccat.tg_set_updated_at();

create table ccat.data_export_requests (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references ccat.students(id) on delete cascade,
  state        text not null default 'requested'
                  check (state in ('requested','preparing','ready','delivered','failed','expired')),
  artifact_ref text,                      -- storage reference to generated export
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger set_updated_at before update on ccat.data_export_requests
  for each row execute function ccat.tg_set_updated_at();

-- ----------------------------------------------------------------------------
-- Support cases (referenced by break-glass and status changes) — §5.3, §31.1
-- ----------------------------------------------------------------------------
create table ccat.support_cases (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid references ccat.students(id) on delete set null,
  opened_by    uuid references ccat.admin_profiles(id),
  reference    text not null unique,      -- external support reference
  summary      text,
  state        text not null default 'open' check (state in ('open','closed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger set_updated_at before update on ccat.support_cases
  for each row execute function ccat.tg_set_updated_at();

-- ----------------------------------------------------------------------------
-- OTP / verification challenges (guardian workflows, device replacement, PIN reset)
-- §4.4, §5.2, §36.4. Codes are stored hashed; rate limiting enforced at Gateway.
-- ----------------------------------------------------------------------------
create table ccat.verification_challenges (
  id            uuid primary key default gen_random_uuid(),
  purpose       text not null check (purpose in
                  ('guardian_registration','pin_reset','device_replacement','contact_change')),
  student_id    uuid references ccat.students(id) on delete cascade,
  guardian_id   uuid references ccat.guardian_contacts(id),
  channel       ccat.contact_channel not null,
  code_hash     text not null,
  attempts      int not null default 0,
  max_attempts  int not null default 5,
  consumed_at   timestamptz,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index verification_challenges_lookup_idx
  on ccat.verification_challenges(student_id, purpose) where consumed_at is null;

-- ----------------------------------------------------------------------------
-- Admin audit log — append-only, global (§25). Normal Admin reads own scope only
-- (enforced by service/RLS, not by omission). Super-Admin reads global.
-- ----------------------------------------------------------------------------
create table ccat.audit_log (
  id            uuid primary key default gen_random_uuid(),
  actor_admin_id uuid references ccat.admin_profiles(id),  -- null for system events
  actor_kind    text not null default 'admin' check (actor_kind in ('admin','system')),
  event_type    text not null,           -- see audit-event-catalog.md
  target_kind   text,                    -- 'student'|'device'|'content'|'config'|'admin'|...
  target_id     uuid,
  old_value     jsonb,                   -- for emergency/config actions (§28.3)
  new_value     jsonb,
  reason        text,
  reference     text,                    -- incident/support/request reference
  request_id    text,                    -- Gateway request id
  ip_hash       text,                    -- never raw PII in audit beyond policy
  created_at    timestamptz not null default now()
);
create trigger no_mutation before update or delete on ccat.audit_log
  for each row execute function ccat.tg_forbid_mutation();
create index audit_log_actor_idx  on ccat.audit_log(actor_admin_id, created_at desc);
create index audit_log_target_idx on ccat.audit_log(target_kind, target_id, created_at desc);
create index audit_log_type_idx   on ccat.audit_log(event_type, created_at desc);
