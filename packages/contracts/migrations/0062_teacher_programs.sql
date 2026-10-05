-- 0062_teacher_programs.sql
-- DECISION D3: first-class teacher <-> program membership (one teacher, many programs).
-- A teacher is an admin_profiles row with is_teacher=true. This table tags which
-- programs they belong to (CCAT / NGAT / Math) WITHOUT duplicating the teacher.
-- Backfills every existing teacher to {ccat} so current behaviour is unchanged.
-- Secured to match the live ccat pattern: RLS enabled + forced, no policy (gateway
-- connects as a BYPASSRLS role; anon/authenticated have no grants).
begin;

create table if not exists ccat.teacher_programs (
  teacher_admin_id uuid not null references ccat.admin_profiles(id) on delete cascade,
  program          text not null check (program in ('ccat','ngat','math')),
  created_at       timestamptz not null default now(),
  primary key (teacher_admin_id, program)
);
create index if not exists teacher_programs_program_idx on ccat.teacher_programs (program);

-- Backfill: every current teacher gets the CCAT program by default (status quo).
insert into ccat.teacher_programs (teacher_admin_id, program)
select id, 'ccat' from ccat.admin_profiles where is_teacher = true
on conflict do nothing;

alter table ccat.teacher_programs enable row level security;
alter table ccat.teacher_programs force row level security;
revoke all on ccat.teacher_programs from anon, authenticated;

commit;

-- ROLLBACK: drop table ccat.teacher_programs.
