-- ============================================================================
-- CCAT Practice App — Database Migration 0005
-- Announcements, push, book store, incidents, analytics
-- Blueprint §21, §26, §27, §28, §35, §31.5
-- ============================================================================
set search_path = ccat, public;

-- ----------------------------------------------------------------------------
-- Announcements + in-app carousel (§26.1). Admin creates; publish is a state.
-- ----------------------------------------------------------------------------
create table ccat.announcements (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  body_blocks   jsonb not null,          -- typed content blocks (no executable HTML)
  image_asset_id uuid references ccat.content_assets(id),
  state         text not null default 'draft' check (state in ('draft','published','archived')),
  carousel_order int,
  target_grades uuid[],                   -- null/empty = all grades
  created_by    uuid references ccat.admin_profiles(id),
  published_at  timestamptz,
  version       int not null default 1,   -- ETag concurrency (§22.4)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger set_updated_at before update on ccat.announcements
  for each row execute function ccat.tg_set_updated_at();

-- ----------------------------------------------------------------------------
-- Push campaigns (§26). Admin requests; Super-Admin approves (§23, §26.1).
-- ----------------------------------------------------------------------------
create table ccat.push_campaigns (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  payload       jsonb not null,          -- MUST NOT contain child/guardian PII or perf details (§26.4)
  target_query  jsonb,                    -- audience selector (pseudonymous)
  quiet_hours   jsonb,                    -- server-enforced quiet-hours/timezone (§26.4)
  state         text not null default 'requested'
                  check (state in ('requested','approved','rejected','scheduled','sending','completed','cancelled')),
  requested_by  uuid references ccat.admin_profiles(id),
  approved_by   uuid references ccat.admin_profiles(id),   -- Super-Admin (§26.1)
  scheduled_at  timestamptz,
  version       int not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger set_updated_at before update on ccat.push_campaigns
  for each row execute function ccat.tg_set_updated_at();

-- Push tokens per device (invalid token does NOT revoke the enrolled device §26.3).
create table ccat.push_tokens (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references ccat.student_devices(id) on delete cascade,
  provider    text not null,             -- 'apns'|'fcm'
  token       text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint push_tokens_unique unique (provider, token)
);
create trigger set_updated_at before update on ccat.push_tokens
  for each row execute function ccat.tg_set_updated_at();

-- Delivery ledger — durable per-target identity/state (§26.2). Append-only state
-- transitions recorded via new rows in push_delivery_events; the current state is
-- kept on the delivery row for querying. Retries reuse stable logical delivery IDs.
create table ccat.push_deliveries (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references ccat.push_campaigns(id),
  logical_delivery_id text not null,     -- stable across retries (§26.2)
  device_id         uuid references ccat.student_devices(id),
  state             ccat.delivery_state not null default 'QUEUED',
  attempts          int not null default 0,
  last_error        text,
  next_retry_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint push_deliveries_logical_unique unique (campaign_id, logical_delivery_id)
);
create trigger set_updated_at before update on ccat.push_deliveries
  for each row execute function ccat.tg_set_updated_at();
create index push_deliveries_campaign_idx on ccat.push_deliveries(campaign_id, state);

create table ccat.push_delivery_events (
  id           uuid primary key default gen_random_uuid(),
  delivery_id  uuid not null references ccat.push_deliveries(id),
  from_state   ccat.delivery_state,
  to_state     ccat.delivery_state not null,
  detail       text,
  created_at   timestamptz not null default now()
);
create trigger no_mutation before update or delete on ccat.push_delivery_events
  for each row execute function ccat.tg_forbid_mutation();

-- Notification preferences (per student).
create table ccat.notification_preferences (
  student_id  uuid primary key references ccat.students(id) on delete cascade,
  push_enabled boolean not null default true,
  updated_at  timestamptz not null default now()
);
create trigger set_updated_at before update on ccat.notification_preferences
  for each row execute function ccat.tg_set_updated_at();

-- ----------------------------------------------------------------------------
-- Book Store (§21). External retailer links only; backend-controlled, allowlisted
-- HTTPS destinations. Client cannot submit arbitrary URLs.
-- ----------------------------------------------------------------------------
create table ccat.books (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  author       text,
  description  text,
  cover_asset_id uuid references ccat.content_assets(id),
  grade_ids    uuid[],
  active       boolean not null default true,
  created_by   uuid references ccat.admin_profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger set_updated_at before update on ccat.books
  for each row execute function ccat.tg_set_updated_at();

create table ccat.book_retailer_links (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references ccat.books(id) on delete cascade,
  retailer     text not null,
  destination_url text not null,          -- MUST be HTTPS + allowlisted (validated on write §21)
  display_order int not null default 0,
  active       boolean not null default true,
  constraint book_link_https_ck check (destination_url like 'https://%')
);

-- ----------------------------------------------------------------------------
-- Incident records + product-health rollups (§27, §28)
-- ----------------------------------------------------------------------------
create table ccat.incident_records (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  severity     text not null check (severity in ('minor','major','critical')),
  state        text not null default 'open' check (state in ('open','monitoring','resolved')),
  opened_by    uuid references ccat.admin_profiles(id),
  summary      text,
  reference    text,
  opened_at    timestamptz not null default now(),
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger set_updated_at before update on ccat.incident_records
  for each row execute function ccat.tg_set_updated_at();

-- Aggregated product-health snapshots surfaced in Admin Web (§27.1). No raw logs.
create table ccat.health_snapshots (
  id           uuid primary key default gen_random_uuid(),
  indicator    text not null,             -- 'gateway'|'database'|'auth'|'storage'|'login_success'|...
  state        ccat.health_state not null default 'Unknown',  -- no telemetry => Unknown (§27.1)
  value        numeric,                   -- e.g. success rate, p95 latency ms
  detail       jsonb,
  observed_at  timestamptz not null default now()
);
create index health_snapshots_indicator_idx on ccat.health_snapshots(indicator, observed_at desc);

-- Global control flags (Super-Admin) — §28. Availability/security flags apply
-- immediately (§30). Current value here; every change audited in audit_log.
create table ccat.global_flags (
  key          text primary key,          -- 'registration_enabled'|'student_login_enabled'|'session_start_enabled'|...
  value        boolean not null,
  updated_by   uuid references ccat.admin_profiles(id),
  updated_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Analytics — pseudonymous first-party events (§35). MUST NOT contain PII.
-- The pseudonymous <-> student mapping is backend-only and permission-controlled.
-- ----------------------------------------------------------------------------
create table ccat.analytics_identities (
  pseudonymous_id uuid primary key default gen_random_uuid(),
  student_id      uuid not null unique references ccat.students(id) on delete cascade,
  created_at      timestamptz not null default now()
);

create table ccat.product_events (
  id              uuid primary key default gen_random_uuid(),
  pseudonymous_id uuid not null references ccat.analytics_identities(pseudonymous_id),
  session_id      uuid,                   -- opaque; not FK-enforced to avoid PII coupling
  grade_number    int,
  set_version_id  uuid,
  event_type      text not null,
  attributes      jsonb,                  -- MUST exclude display name/username/guardian PII/tokens (§35)
  occurred_at     timestamptz not null default now()
);
create trigger no_mutation before update or delete on ccat.product_events
  for each row execute function ccat.tg_forbid_mutation();
create index product_events_pseudo_idx on ccat.product_events(pseudonymous_id, occurred_at desc);
create index product_events_type_idx on ccat.product_events(event_type, occurred_at desc);

-- Metric rollups (data dictionary defines each metric — see data-dictionary.md §35.1).
create table ccat.analytics_rollups (
  id           uuid primary key default gen_random_uuid(),
  metric_key   text not null,
  dimensions   jsonb,                     -- e.g. {"grade":3}
  numerator    numeric,
  denominator  numeric,
  value        numeric,
  window_start timestamptz,
  window_end   timestamptz,
  computed_at  timestamptz not null default now()
);
create index analytics_rollups_metric_idx on ccat.analytics_rollups(metric_key, window_end desc);
