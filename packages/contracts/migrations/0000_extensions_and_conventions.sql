-- ============================================================================
-- CCAT Practice App — Database Migration 0000
-- Extensions, schemas, and shared conventions
-- ----------------------------------------------------------------------------
-- Authority: CCAT Final Definitive Architecture Blueprint v10.0
-- Target: Supabase PostgreSQL 17
--
-- Conventions used across all migrations (0000–0005):
--   * Primary keys are UUID (gen_random_uuid()); no client-supplied IDs are trusted.
--   * All timestamps are timestamptz, stored in UTC.
--   * created_at / updated_at present on mutable rows; append-only tables carry
--     only created_at (they are never updated in place).
--   * "Versioned/immutable" tables (published content, config, consents) MUST NOT
--     be UPDATEd after publication — correction creates a new version row.
--   * "Ledger" tables (xp_transactions, coin_transactions, *_deliveries, audit_log,
--     *_status_events) are APPEND-ONLY. No UPDATE/DELETE in application paths.
--   * Row Level Security is ENABLED on every table. The student app NEVER connects
--     to Postgres directly (Blueprint §1.1, §33): all access is via the Gateway
--     using a dedicated service role. RLS here is defense-in-depth, not the primary
--     control. Policies are defined in 0006_rls_and_grants.sql.
--
-- Migration strategy: expand/contract. Additive first; destructive changes are
-- separate, reviewed steps (Blueprint §38.3).
-- ============================================================================

-- gen_random_uuid() is in core on PG13+, but ensure pgcrypto for digest()/gen_salt()
create extension if not exists "pgcrypto";
create extension if not exists "citext";      -- case-insensitive username/email handling

-- Dedicated schema keeps application tables off the public PostgREST surface.
-- (Student app has no PostgREST access at all; this also helps Admin-service scoping.)
create schema if not exists ccat;

comment on schema ccat is
  'CCAT application data. All access via secured Gateway service role only. '
  'Direct student database access is prohibited (Blueprint §41).';

set search_path = ccat, public;

-- ----------------------------------------------------------------------------
-- Shared enumerated domains
-- Kept as Postgres enums where the domain is closed and architecture-normative.
-- Data-driven catalogs (grades, categories, difficulty labels) are TABLES, not
-- enums, because the blueprint requires them to expand without redeployment.
-- ----------------------------------------------------------------------------

-- Student account lifecycle (Blueprint §6.1)
create type ccat.student_status as enum (
  'active',
  'suspended',
  'banned',
  'pending_deletion',
  'purged'
);

-- Device enrollment lifecycle (Blueprint §5, §31.1)
create type ccat.device_status as enum (
  'pending',      -- replacement/enrollment started, not yet the sole active device
  'active',       -- the one and only enrolled device
  'revoked'       -- superseded by replacement, break-glass, or security action
);

-- Session lifecycle (Blueprint §9.3). Non-terminal + terminal states.
create type ccat.session_state as enum (
  'IN_PROGRESS',
  'SUBMITTED',
  'AUTO_SUBMITTED',
  'ABANDONED',
  'ABANDONED_BY_INACTIVITY',
  'INVALIDATED',
  'CANCELLED'
);

-- Learning modes (Blueprint §8.3)
create type ccat.learning_mode as enum ('practice', 'exam');

-- Timer type on a session (Blueprint §9.2)
create type ccat.timer_type as enum ('untimed', 'timed');

-- Content lifecycle state machine (Blueprint §18)
create type ccat.content_state as enum (
  'draft',
  'automated_checks',
  'expert_review',
  'approved',
  'published',
  'retired'
);

-- Question typed block kinds (Blueprint §17.2)
create type ccat.block_type as enum ('text', 'rich_text', 'math', 'image');

-- Guardian verification channel (Blueprint §3.3, §4)
create type ccat.contact_channel as enum ('email', 'sms');

-- Reward ledger direction is expressed by signed integer deltas, not an enum.

-- Admin security roles — EXACTLY two (Blueprint §3.2, §22). Display bundles are
-- a separate table and are NOT authorization boundaries.
create type ccat.admin_security_role as enum ('admin', 'super_admin');

-- Push/announcement delivery lifecycle (Blueprint §26.2)
create type ccat.delivery_state as enum (
  'APPROVED',
  'QUEUED',
  'SENDING',
  'DELIVERED',
  'TEMPORARY_FAILURE',
  'RETRY_SCHEDULED',
  'PERMANENT_FAILURE',
  'CANCELLED'
);

-- Product-health rollup states (Blueprint §27.1)
create type ccat.health_state as enum (
  'Healthy', 'Degraded', 'Major Incident', 'Maintenance', 'Unknown'
);

-- ----------------------------------------------------------------------------
-- Shared trigger: maintain updated_at on mutable rows.
-- ----------------------------------------------------------------------------
create or replace function ccat.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = ccat, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Shared trigger: block UPDATE/DELETE on append-only tables.
-- Attached to ledgers, audit, and *_events tables. Belt-and-suspenders in
-- addition to RLS/grants (Blueprint §36.3 "append-only audit and reward ledgers").
-- ----------------------------------------------------------------------------
create or replace function ccat.tg_forbid_mutation()
returns trigger
language plpgsql
set search_path = ccat, public
as $$
begin
  raise exception 'Table %.% is append-only; % is not permitted',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;
