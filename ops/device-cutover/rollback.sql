-- ROLLBACK for the device cutover. Cleanest BEFORE any student re-enrolls on the new domain.
-- Pick ONE variant.

-- ============================================================================
-- VARIANT A — stay ONE-ACTIVE (keep the index). Restore exactly ONE device per student
-- (most-recently-seen), and ONLY for students who have not already re-enrolled (0 active now),
-- so the restore can never violate the one-active index.
-- ============================================================================
begin;
with pick as (
  select distinct on (b.student_id) b.id, b.student_id
    from ccat.student_devices_cutover_bak_2026_09 b
   order by b.student_id, b.last_seen_at desc nulls last, b.enrolled_at desc nulls last
)
update ccat.student_devices sd
   set status = 'active', revoked_at = null, revoked_reason = null
  from pick
 where sd.id = pick.id
   and sd.revoked_reason = 'domain_cutover_2026_09'
   and not exists (select 1 from ccat.student_devices x
                    where x.student_id = pick.student_id and x.status = 'active');
commit;

-- ============================================================================
-- VARIANT B — revert to MULTI-DEVICE. Drop the unique index FIRST, then restore ALL revoked devices.
-- ============================================================================
-- begin;
-- drop index if exists ccat.student_devices_one_active;
-- update ccat.student_devices
--    set status = 'active', revoked_at = null, revoked_reason = null
--  where revoked_reason = 'domain_cutover_2026_09';
-- commit;

-- ============================================================================
-- VARIANT C — FULL OLD-DOMAIN ROLLBACK. Use when abandoning the new domain entirely and sending users
-- back to the old app. Scoped to cutover participants only (students with a backup row), so brand-new
-- post-snapshot registrations and the preview account are never touched. Two steps in one txn:
--   (1) revoke any device enrolled on the NEW domain (active + not in the backup),
--   (2) restore ONE old device per student from the backup (most-recent), where they now have 0 active.
-- ============================================================================
-- begin;
-- -- (1) revoke new-domain enrollments for cutover participants
-- update ccat.student_devices sd
--    set status='revoked', revoked_at=now(), revoked_reason='cutover_rollback'
--  where sd.status='active'
--    and not exists (select 1 from ccat.student_devices_cutover_bak_2026_09 b where b.id = sd.id)
--    and exists     (select 1 from ccat.student_devices_cutover_bak_2026_09 b2 where b2.student_id = sd.student_id);
-- -- (2) restore one old device per cutover student that now has zero active
-- with pick as (
--   select distinct on (b.student_id) b.id, b.student_id
--     from ccat.student_devices_cutover_bak_2026_09 b
--    order by b.student_id, b.last_seen_at desc nulls last, b.enrolled_at desc nulls last)
-- update ccat.student_devices sd
--    set status='active', revoked_at=null, revoked_reason=null
--   from pick
--  where sd.id = pick.id
--    and not exists (select 1 from ccat.student_devices x where x.student_id = pick.student_id and x.status='active');
-- commit;
-- (If also reverting to multi-device on the old domain: drop index student_devices_one_active first.)

-- ============================================================================
-- BACKUP RETENTION GUARD (do NOT drop the backup early).
-- Only drop the backup once this returns 0 — every cutover student has re-enrolled somewhere — OR the
-- approved retention period has elapsed. While > 0, some students can still only be recovered from it.
-- ============================================================================
--   select count(*) as cutover_students_still_zero_active
--     from (select distinct student_id from ccat.student_devices_cutover_bak_2026_09) b
--    where not exists (select 1 from ccat.student_devices x where x.student_id = b.student_id and x.status='active');
--
--   -- when the count is 0 (or retention elapsed):
--   drop table if exists ccat.student_devices_cutover_bak_2026_09;
