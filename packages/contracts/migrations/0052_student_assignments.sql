-- Teacher → student SET ASSIGNMENTS.
-- A teacher (or any admin holding student.directory) assigns a specific published set/paper
-- (question_set_version) to a student. Status is DERIVED from the student's real session on that
-- set (Assigned → In progress → Done); we store only the assignment record. Newest-first by assigned_at.
create table if not exists ccat.student_assignments (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references ccat.students(id) on delete cascade,
  set_version_id uuid not null references ccat.question_set_versions(id) on delete cascade,
  assigned_by    uuid references ccat.admin_profiles(id),
  assigned_at    timestamptz not null default now(),
  unique (student_id, set_version_id)
);
create index if not exists idx_student_assignments_student
  on ccat.student_assignments(student_id, assigned_at desc);
