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

-- After the window closes and rollback is no longer needed, remove the backup:
--   drop table if exists ccat.student_devices_cutover_bak_2026_09;
