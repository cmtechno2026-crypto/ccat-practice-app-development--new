-- 0011_ops_jobs.sql — background-job run tracking for the Service Health console (Blueprint §27).
-- The Gateway runs durable interval workers (overdue-session finalizer, streak reconcile,
-- scheduled-announcement publisher). Each worker upserts its real last-run here so the admin
-- console shows *truthful* job status (last run, result, cumulative runs) instead of a mock.
-- In production these same jobs run via pg_cron; a pg_cron job can write the same row.
create table if not exists ccat.job_runs (
  job_key       text primary key,
  last_run_at   timestamptz,
  last_status   text,                     -- 'ok' | 'error'
  last_detail   text,
  runs_total    bigint not null default 0,
  errors_total  bigint not null default 0,
  updated_at    timestamptz not null default now()
);
