-- One-time NEW-DOMAIN device-enrollment cutover (run ONCE, via Supabase apply_migration, after:
--   (1) the gateway build with DEVICE_CUTOVER_DEADLINE deployed, and (2) SMTP configured + test-delivered).
-- Atomic: revoke + one-active index in a single txn. Until COMMIT, other sessions still see the old
-- devices (normal login, no enroll), so no login can race in a second active device; after COMMIT the
-- unique index caps every student at one active device. Preserves accounts/creds/progress/history.
begin;

-- 1) Restricted backup of the active NON-preview device rows (device_hash retained) for rollback.
drop table if exists ccat.student_devices_cutover_bak_2026_09;
create table ccat.student_devices_cutover_bak_2026_09 as
  select sd.* from ccat.student_devices sd
   join ccat.students s on s.id = sd.student_id
  where sd.status = 'active' and s.is_preview = false;
revoke all on ccat.student_devices_cutover_bak_2026_09 from anon, authenticated, service_role;

-- 2) Revoke active non-preview devices (rows kept, history kept), one audit row each.
with revoked as (
  update ccat.student_devices sd
     set status = 'revoked', revoked_at = now(), revoked_reason = 'domain_cutover_2026_09'
    from ccat.students s
   where sd.student_id = s.id and sd.status = 'active' and s.is_preview = false
  returning sd.id
)
insert into ccat.audit_log(actor_kind, event_type, target_kind, target_id, old_value, new_value, reason)
select 'admin', 'device.revoked.cutover', 'device', id,
       '{"status":"active"}'::jsonb, '{"status":"revoked"}'::jsonb, 'domain_cutover_2026_09'
from revoked;

-- 3) Revoke ONLY live auth sessions for non-preview students. ccat.sessions / session_results (practice
--    history, incl. in-progress) are deliberately untouched.
update ccat.auth_sessions a
   set revoked_at = now(), revoked_reason = 'domain_cutover_2026_09'
  from ccat.students s
 where a.student_id = s.id and s.is_preview = false and a.revoked_at is null;

-- 4) Re-add one-active-device enforcement (reverses 0038's multi-device). Safe now: each student <=1 active.
create unique index if not exists student_devices_one_active
  on ccat.student_devices(student_id) where status = 'active';

commit;

-- Post-run verification (expect: 0 active non-preview, N audit rows == pre-run active count, 0 live
-- non-preview sessions, index present). Run these AFTER commit:
--   select count(*) from ccat.student_devices sd join ccat.students s on s.id=sd.student_id
--     where sd.status='active' and s.is_preview=false;                             -- expect 0
--   select count(*) from ccat.audit_log where reason='domain_cutover_2026_09'
--     and event_type='device.revoked.cutover';                                     -- expect pre-run active count
--   select count(*) from ccat.auth_sessions a join ccat.students s on s.id=a.student_id
--     where s.is_preview=false and a.revoked_at is null;                           -- expect 0
--   select count(*) from pg_indexes where schemaname='ccat' and indexname='student_devices_one_active'; -- expect 1
