# New-domain device-enrollment cutover — runbook

One-time migration of active device enrollments to `ccat.conceptmastery.com`. Accounts, usernames,
PINs, progress and history are preserved; only device enrollments and live auth sessions are revoked so
each student re-enrolls the browser they use on the new domain (one active device, enforced).

## Order of operations

1. **Deploy the code** (gateway) at the approved SHA with `DEVICE_CUTOVER_DEADLINE` **unset** — pure code,
   no behavior change yet. Confirm Render deployed that exact commit.
2. **Configure + test SMTP** (`EMAIL_*` on Render). Send a real PIN-reset and confirm delivery.
3. **Set `DEVICE_CUTOVER_DEADLINE`** to a short future UTC instant (e.g. +48h) and redeploy.
4. **Maintenance window (do 5a + 5b together, short):**
   - 5a. Redirect the old student domain → `https://ccat.conceptmastery.com`, and set `WEB_APP_ORIGIN`
     to the new origin only (admin stays on `ADMIN_WEB_ORIGIN`; mobile/native unaffected — no Origin header).
   - 5b. Run `cutover.sql` (via Supabase apply_migration). It is atomic: backup → revoke devices → revoke
     live auth sessions → re-add the one-active index, all in one transaction, so no login can race in a
     second active device.
5. Run the verification queries at the bottom of `cutover.sql`.
6. **After migration completes:** clear `DEVICE_CUTOVER_DEADLINE` (redeploy), then — only once the backup
   retention guard in `rollback.sql` returns 0 (or the approved retention period ends) — drop the backup.

## Recovery for users who miss the 48h window

After the deadline passes, enroll-on-login is off (fails closed). A student with zero active devices
recovers the normal way: **device replacement OTP** (`/devices/replacement/start` → guardian email →
verify), which requires SMTP to be working — if it isn't, the endpoint returns `503 EMAIL_UNAVAILABLE`
(never a false "sent"). A Super-Admin can also **break-glass enroll** from the student's admin page when
guardian channels are unreachable. No account, PIN, or progress is affected either way; only a device
re-enroll is needed.

## Rollback

See `rollback.sql`: Variant A (stay one-active, restore one device per student), Variant B (revert to
multi-device — drop the index first), Variant C (full old-domain rollback — revoke new-domain devices and
restore one old device per cutover student). Cleanest before any re-enrollment; after that, per-student.
Do not drop the backup until the retention guard reads 0.
