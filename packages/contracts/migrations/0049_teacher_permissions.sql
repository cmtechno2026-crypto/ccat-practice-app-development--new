-- 0049_teacher_permissions.sql — permission keys for the Teacher Hub site (ADDITIVE).
-- These are grantable on the Admin accounts page and evaluated within site='teacher'. super_admin
-- holds them implicitly. No existing permission or grant is touched.
insert into ccat.permissions(key, description, super_admin_only) values
  ('teacher.directory',    'View Teacher Hub teachers',                 false),
  ('teacher.manage',       'Create and edit Teacher Hub teachers',      false),
  ('teacher.slots.manage', 'Manage teacher availability slots',         false),
  ('teacher.leave.manage', 'Review and approve teacher leave requests', false)
on conflict (key) do nothing;
