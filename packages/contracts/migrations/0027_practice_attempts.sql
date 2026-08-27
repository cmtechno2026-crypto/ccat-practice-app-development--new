-- 0023: per-question attempt counter for the PRACTICE feedback loop (instant correct/incorrect,
-- hint on wrong-1, 2nd attempt, reveal on exhaust/correct). Server-authoritative (max 2). Exam mode
-- never uses this — exam answers stay silent until the exam ends.
alter table ccat.session_answers
  add column if not exists attempts int not null default 0;

comment on column ccat.session_answers.attempts is
  'Practice feedback: number of graded attempts committed for this question (max 2). Exam sessions leave this 0.';
