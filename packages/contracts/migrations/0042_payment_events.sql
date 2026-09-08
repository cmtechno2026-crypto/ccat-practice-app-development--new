-- 0042_payment_events.sql
-- CCAT Payments — Phase 1 (Stripe Checkout). Webhook idempotency ledger.
--
-- One row per Stripe event id the gateway has processed. The webhook checks this before granting an
-- entitlement and records the id after, so a redelivered (or stale) event is never processed twice and
-- can never re-grant or downgrade. Independent of PAYMENTS_ENABLED — the flag governs enforcement, not
-- the presence of this table.
--
-- NOT APPLIED by the build. Supabase migrations are run by the operator. This file only defines schema.

set search_path = ccat, public;

create table if not exists ccat.payment_events (
  stripe_event_id  text primary key,          -- Stripe Event.id (evt_...) — globally unique
  type             text not null,             -- Event.type, e.g. 'checkout.session.completed'
  received_at      timestamptz not null default now()
);
