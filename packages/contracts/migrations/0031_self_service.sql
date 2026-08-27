-- Gate 3B: account self-service. Learners can act on their own account directly (no guardian OTP,
-- per the product decision). Two additive CHECK relaxations let us record that provenance HONESTLY
-- instead of mislabelling self-initiated actions as guardian/admin ones:
--   * deletion_requests.requested_by_kind gains 'self' — a learner-initiated (recoverable) deletion.
--   * audit_log.actor_kind gains 'student'    — a learner-initiated audited action.
-- Both are pure widenings: existing rows and existing writers only ever use the prior values, so
-- nothing is invalidated. Deletions still flow through the SAME recoverable deletion_requests model
-- (30-day restore window, admin restore/purge) — this adds no new deletion mechanism.

alter table ccat.deletion_requests drop constraint if exists deletion_requests_requested_by_kind_check;
alter table ccat.deletion_requests add constraint deletion_requests_requested_by_kind_check
  check (requested_by_kind = any (array['guardian'::text, 'admin_override'::text, 'self'::text]));

alter table ccat.audit_log drop constraint if exists audit_log_actor_kind_check;
alter table ccat.audit_log add constraint audit_log_actor_kind_check
  check (actor_kind = any (array['admin'::text, 'system'::text, 'student'::text]));
