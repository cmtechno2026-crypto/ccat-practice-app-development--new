-- "Save & Leave" marker. When a student exits an IN_PROGRESS session via Save & Leave, the session stays
-- in progress and fully resumable (nothing is submitted or graded); we only stamp left_at so the ADMIN
-- assignment list can surface the set as Done (ungraded). Cleared automatically on the next answer
-- activity, so resuming flips the admin status back to In progress. Student-facing views are unaffected.
alter table ccat.sessions add column if not exists left_at timestamptz;
