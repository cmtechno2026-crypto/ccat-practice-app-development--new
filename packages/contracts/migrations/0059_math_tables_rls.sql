-- 0059_math_tables_rls.sql
-- Secure the five Math feature tables that shipped to prod with RLS DISABLED
-- (student_notes, support_messages, math_contests, math_contest_entries, math_levels).
--
-- Mirrors the LIVE CCAT security pattern EXACTLY (verified against ccat.students,
-- ccat.bookmarks, ccat.support_cases, 2026-10-05): RLS enabled + FORCED, NO policies,
-- table privileges held only by the owner. The gateway connects as a BYPASSRLS role
-- and is unaffected; anon/authenticated are denied by BOTH the revoked grants and
-- RLS-with-no-policy.
--
-- NOTE: there is NO `ccat_gateway` role in this project (the DRAFT_math_site_scoping.sql
-- §5 assumed one). Creating a policy `to ccat_gateway` would ERROR. We therefore create
-- NO policy, matching every other locked ccat table. Additive + idempotent.
begin;
do $$
declare t text;
begin
  foreach t in array array[
    'student_notes','support_messages','math_contests','math_contest_entries','math_levels'
  ] loop
    execute format('alter table ccat.%I enable row level security', t);
    execute format('alter table ccat.%I force row level security', t);
    execute format('revoke all on ccat.%I from anon, authenticated', t);
  end loop;
end $$;
commit;
