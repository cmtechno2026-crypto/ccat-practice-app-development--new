-- 0044_paypal_payment_events.sql
-- CCAT Payments — PayPal. Webhook/capture idempotency ledger (mirrors ccat.payment_events for Stripe).
--
-- One row per PayPal CAPTURE id the gateway has granted on. Both the return-time capture endpoint and
-- the PAYMENT.CAPTURE.COMPLETED webhook key on the SAME capture id, so a grant is applied exactly once
-- no matter which path arrives first (or if both do). Independent of PAYMENTS_ENABLED — the flag governs
-- enforcement, not the presence of this table.
--
-- NOT APPLIED by the build. Supabase migrations are run by the operator. This file only defines schema.

set search_path = ccat, public;

create table if not exists ccat.paypal_payment_events (
  capture_id    text primary key,          -- PayPal capture id (globally unique) — the idempotency key
  event_type    text not null,             -- 'capture' (return-time) or the webhook event_type
  order_id      text,                       -- PayPal order id (for audit/trace)
  received_at   timestamptz not null default now()
);
