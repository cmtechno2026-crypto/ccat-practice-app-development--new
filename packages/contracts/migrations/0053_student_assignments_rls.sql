-- 0053_student_assignments_rls.sql
-- Bring ccat.student_assignments in line with every other ccat table: RLS ON with a single
-- gateway_all policy that grants the app's DB role (ccat_gateway) full access and denies all
-- other roles. The gateway connects as ccat_gateway, so this is a no-op for the app while
-- closing direct access from the anon/authenticated Supabase roles.
alter table ccat.student_assignments enable row level security;

drop policy if exists gateway_all on ccat.student_assignments;
create policy gateway_all on ccat.student_assignments
  for all to ccat_gateway
  using (true) with check (true);
