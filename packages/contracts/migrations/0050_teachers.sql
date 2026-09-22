-- 0050_teachers.sql — Teacher (restricted admin) accounts + teacher→student assignments. ADDITIVE.
-- Apply after 0049. A "teacher" is an admin account with is_teacher = true, security_role = 'admin',
-- and only the `student.directory` permission. The gateway restricts such accounts to their ASSIGNED
-- students on every student read (directory list, detail, progress, exams). All edit / membership /
-- PIN-reset / deletion / ban endpoints remain permission-gated, and teachers are not granted those
-- permissions, so they cannot mutate anything. super_admin bypasses the teacher scope.

alter table ccat.admin_profiles add column if not exists is_teacher boolean not null default false;

create table if not exists ccat.teacher_students (
  teacher_admin_id uuid not null references ccat.admin_profiles(id) on delete cascade,
  student_id       uuid not null references ccat.students(id)       on delete cascade,
  assigned_by      uuid references ccat.admin_profiles(id),
  assigned_at      timestamptz not null default now(),
  primary key (teacher_admin_id, student_id)
);
create index if not exists teacher_students_by_student on ccat.teacher_students(student_id);

-- Permission to manage teacher accounts + their assignments (super_admin bypasses this anyway).
insert into ccat.permissions(key, description, dangerous) values
  ('teacher.students.manage', 'Manage teacher accounts and their assigned students', false)
on conflict (key) do nothing;
