-- 0038: Allow a student to be logged in on MULTIPLE devices at once (no device limit).
--
-- The request middleware requires the auth session's device row to be status='active'. The partial
-- unique index below allowed only ONE active device per student, so logging in from a second device
-- (insert/activate another 'active' row) raised a unique violation. Dropping it lets several devices be
-- active concurrently. Login itself no longer rejects on device mismatch (see routes/auth.ts); until
-- this index is dropped the gateway falls back to rotating the single active device, so login still
-- works — dropping it just enables true concurrent multi-device.
--
-- Apply manually (same as 0036 / 0037).

drop index if exists ccat.student_devices_one_active;
