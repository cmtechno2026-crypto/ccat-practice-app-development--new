-- Pausable PRACTICE timer. When a student discontinues (leaves / backs out of) a TIMED PRACTICE session,
-- the gateway stores the remaining seconds here and clears deadline_at, so the away time does not count and
-- the overdue worker never auto-finalizes it. On resume, deadline_at is recomputed (= now + remaining) and
-- this is cleared. Exams are unaffected — their clock runs server-side and is never paused.
alter table ccat.sessions add column if not exists paused_remaining_seconds int;
