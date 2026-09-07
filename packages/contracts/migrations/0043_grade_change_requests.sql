-- 0043_grade_change_requests.sql
-- Student-initiated grade-change requests + a granular admin edit permission.
--
-- Mirrors the existing request/review shape (deletion_requests / student_break_glass_requests):
-- a learner files a request from the CCAT web Profile; an admin holding `student.update` (or a
-- Super-Admin, implicitly) approves or rejects it from Admin → Students. Approval updates the
-- student's grade and closes the request in one transaction; rejection leaves the grade unchanged.
-- Grade is a plain FK on students — changing it never touches sessions/results/answers/achievements,
-- so progress and history are preserved.
--
-- Numbered 0043: prod already carries 0040/0041/0042 (payments branch, applied out-of-band). Apply out-of-band
-- on prod (Supabase MCP / `supabase db push`) and via the local/CI runner. NOT applied by the build.

set search_path = ccat, public;

-- Granular authority to edit student profile fields and review grade-change requests. Grantable
-- (not super-admin-only); Super-Admin passes implicitly via role. Appears in Create-Admin's
-- "Individual permissions" list (GET /v1/admin/permissions reads this table).
insert into ccat.permissions(key, description, super_admin_only)
values ('student.update', 'Edit student profile (name, grade) and review grade-change requests', false)
on conflict do nothing;

create table if not exists ccat.grade_change_requests (
  id                 uuid primary key default gen_random_uuid(),
  student_id         uuid not null references ccat.students(id) on delete cascade,
  current_grade_id   uuid not null references ccat.grades(id),
  requested_grade_id uuid not null references ccat.grades(id),
  reason             text,
  status             text not null default 'pending'
                     check (status = any (array['pending'::text, 'approved'::text, 'rejected'::text])),
  reviewed_by        uuid references ccat.admin_profiles(id),
  created_at         timestamptz not null default now(),
  decided_at         timestamptz,
  constraint grade_change_requests_diff check (requested_grade_id <> current_grade_id)
);

-- At most ONE pending request per student (blocks duplicate pending requests).
create unique index if not exists grade_change_requests_one_pending
  on ccat.grade_change_requests (student_id) where status = 'pending';

-- Per-student history, newest first (admin detail + student status lookups).
create index if not exists grade_change_requests_by_student
  on ccat.grade_change_requests (student_id, created_at desc);

-- RLS parity (defense-in-depth): schema-wide default-deny + a permissive gateway policy, matching
-- every other app table (0006 / 0025 / 0032). The gateway authorizes in application code.
do $$
begin
  execute 'alter table ccat.grade_change_requests enable row level security';
  execute 'alter table ccat.grade_change_requests force row level security';
  if not exists (
    select 1 from pg_policies
     where schemaname = 'ccat' and tablename = 'grade_change_requests' and policyname = 'gateway_all'
  ) then
    execute 'create policy gateway_all on ccat.grade_change_requests for all using (true) with check (true)';
  end if;
end
$$;
