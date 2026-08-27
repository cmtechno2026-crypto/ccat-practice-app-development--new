-- ADMIN-1: admin account lockout. The dev credential store gains brute-force tracking so a run of
-- failed logins locks the account (mirroring student_credentials §4.4). A Super-Admin/admin.manage
-- holder unlocks it, which clears the counters and issues a fresh temporary password.
alter table ccat.admin_local_credentials add column if not exists failed_attempts int not null default 0;
alter table ccat.admin_local_credentials add column if not exists locked_until timestamptz;
