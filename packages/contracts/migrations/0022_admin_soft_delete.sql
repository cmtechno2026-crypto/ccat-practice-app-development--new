-- 0022_admin_soft_delete.sql
-- ADMIN-2 (§7, §22, §28.2). A true hard-DELETE of an admin_profiles row is impossible without
-- breaking the append-only audit guarantee: audit_log.actor_admin_id references admin_profiles and
-- audit_log carries the shared tg_forbid_mutation trigger (before update or delete), so the
-- ON DELETE SET NULL sweep that a hard-delete would issue is rejected (restrict_violation). The same
-- append-only trigger guards student_status_events / xp_transactions / coin_transactions, which also
-- reference admin_profiles as actor. Admin erasure is therefore anonymize + tombstone, which needs a
-- third lifecycle state alongside active/disabled.
alter table ccat.admin_profiles drop constraint if exists admin_profiles_status_check;
alter table ccat.admin_profiles add constraint admin_profiles_status_check
  check (status in ('active', 'disabled', 'deleted'));
