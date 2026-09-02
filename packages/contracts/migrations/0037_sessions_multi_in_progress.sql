-- 0037: Allow multiple concurrent IN_PROGRESS ("paused") sessions per student.
--
-- Removes the single-active-session restriction. A set exited via Save & Leave / Back stays IN_PROGRESS
-- (resumable + redoable) and no longer blocks starting another set — a student may have several paused
-- sets at once. The gateway's GET /v1/sessions/active returns the most recently started IN_PROGRESS
-- session for the "continue" card. Redo still starts a fresh attempt from Q1 and does not delete
-- completion history.
--
-- Root cause of the "You already have a session in progress" block: this partial unique index. Dropping
-- it is the whole fix on the DB side; the gateway already tolerates >1 IN_PROGRESS row.
--
-- Apply manually (same as 0036).

drop index if exists ccat.sessions_one_in_progress;
