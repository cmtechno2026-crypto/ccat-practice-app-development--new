-- ============================================================================
-- CCAT Negative-Access & Invariant Test Suite (database layer)
-- Blueprint §38.2 (CI gate #5 permission/direct-access negative tests, #6 session/idempotency)
--
-- Each test performs a FORBIDDEN operation inside a savepoint and asserts the DB
-- REJECTS it. A test that does NOT get an error is a FAILURE. Run against a fresh
-- database with migrations 0000-0006 applied.
--
-- Usage:
--   psql -d ccat_test -v ON_ERROR_STOP=1 -f negative-access-tests.sql
-- Prints "ALL NEGATIVE-ACCESS TESTS PASSED" on success; aborts on the first failure.
--
-- NOTE: This covers the DATABASE-enforced controls (invariants, append-only,
-- immutability, RLS/grants). Application-layer RBAC/permission negative tests
-- (e.g. admin without permission blocked by the Gateway) live in the service test
-- suite and are enumerated in negative-access-tests.md §3.
-- ============================================================================
set search_path = ccat, public;

-- Helper: assert that running `sql` raises an error. Fails loudly if it succeeds.
create or replace function ccat._assert_raises(p_label text, p_sql text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'PASS: % (rejected: %)', p_label, replace(sqlerrm, chr(10), ' ');
    return;
  end;
  raise exception 'FAIL: % -- forbidden operation SUCCEEDED but should have been rejected', p_label;
end;
$$;

-- ---- Seed a minimal graph ---------------------------------------------------
insert into grades(id,grade_number,name) values ('11111111-1111-1111-1111-111111111111',3,'Grade 3')
  on conflict do nothing;
insert into students(id,username_normalized,display_name,grade_id,birth_month,birth_year)
  values ('22222222-2222-2222-2222-222222222222','tkid','Test Kid','11111111-1111-1111-1111-111111111111',5,2017)
  on conflict do nothing;
insert into student_devices(id,student_id,device_hash,status)
  values ('d0000001-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','h1','active')
  on conflict do nothing;
insert into categories(id,key,name) values ('c1000000-0000-0000-0000-000000000001','verbal','Verbal') on conflict do nothing;
insert into subcategories(id,category_id,key,name) values
  ('c1100000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','an','Analogies') on conflict do nothing;
insert into question_sets(id,grade_id,category_id,subcategory_id,name) values
  ('50000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','c1000000-0000-0000-0000-000000000001','c1100000-0000-0000-0000-000000000001','Set A') on conflict do nothing;
insert into question_set_versions(id,question_set_id,version_number,question_count,allowed_practice,state,published_at) values
  ('5a000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',1,10,true,'published',now()) on conflict do nothing;
insert into sessions(id,student_id,student_device_id,set_version_id,mode,timer_type,question_order_seed,option_order_seed) values
  ('e0000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','d0000001-0000-0000-0000-000000000001','5a000000-0000-0000-0000-000000000001','practice','untimed',1,2) on conflict do nothing;
insert into session_submissions(id,session_id,submission_id,finalized_by,expected_session_version) values
  ('55000000-0000-0000-0000-0000000000a1','e0000000-0000-0000-0000-000000000001','idem-1','manual',1) on conflict do nothing;
insert into xp_transactions(student_id,delta,source_kind,source_id) values
  ('22222222-2222-2222-2222-222222222222',30,'session_submit','e0000000-0000-0000-0000-000000000001') on conflict do nothing;
-- Seed one row into each append-only table so UPDATE/DELETE actually touch a row
-- (a row-level trigger never fires on a zero-row statement).
insert into audit_log(event_type,actor_kind) values ('test.seed','system');
insert into session_events(session_id,event_type) values ('e0000000-0000-0000-0000-000000000001','start');

-- ---- INVARIANT TESTS --------------------------------------------------------
select ccat._assert_raises('one-active-device',
  $q$insert into ccat.student_devices(student_id,device_hash,status)
     values ('22222222-2222-2222-2222-222222222222','h2','active')$q$);

select ccat._assert_raises('one-in-progress-session',
  $q$insert into ccat.sessions(student_id,student_device_id,set_version_id,mode,timer_type,question_order_seed,option_order_seed)
     values ('22222222-2222-2222-2222-222222222222','d0000001-0000-0000-0000-000000000001','5a000000-0000-0000-0000-000000000001','practice','untimed',9,9)$q$);

select ccat._assert_raises('exactly-once-submission',
  $q$insert into ccat.session_submissions(session_id,submission_id,finalized_by,expected_session_version)
     values ('e0000000-0000-0000-0000-000000000001','idem-2','deadline',1)$q$);

select ccat._assert_raises('idempotent-xp-source',
  $q$insert into ccat.xp_transactions(student_id,delta,source_kind,source_id)
     values ('22222222-2222-2222-2222-222222222222',30,'session_submit','e0000000-0000-0000-0000-000000000001')$q$);

-- ---- APPEND-ONLY TESTS ------------------------------------------------------
select ccat._assert_raises('xp-ledger-no-update',
  $q$update ccat.xp_transactions set delta=999 where source_id='e0000000-0000-0000-0000-000000000001'$q$);
select ccat._assert_raises('xp-ledger-no-delete',
  $q$delete from ccat.xp_transactions where source_id='e0000000-0000-0000-0000-000000000001'$q$);
select ccat._assert_raises('audit-no-update',
  $q$update ccat.audit_log set reason='x' where true$q$);
select ccat._assert_raises('submission-no-delete',
  $q$delete from ccat.session_submissions where session_id='e0000000-0000-0000-0000-000000000001'$q$);
select ccat._assert_raises('session-events-no-update',
  $q$update ccat.session_events set event_type='x' where true$q$);

-- ---- IMMUTABILITY TESTS -----------------------------------------------------
select ccat._assert_raises('published-set-immutable-count',
  $q$update ccat.question_set_versions set question_count=15 where id='5a000000-0000-0000-0000-000000000001'$q$);
select ccat._assert_raises('published-set-no-mode-flip',
  $q$update ccat.question_set_versions set allowed_exam=true where id='5a000000-0000-0000-0000-000000000001'$q$);

-- ---- SESSION CORE IMMUTABILITY / STATE ------------------------------------
select ccat._assert_raises('session-core-immutable-seed',
  $q$update ccat.sessions set question_order_seed=42 where id='e0000000-0000-0000-0000-000000000001'$q$);

-- terminal-cannot-return: first move to terminal, then try to revert
update ccat.sessions set state='SUBMITTED', terminal_at=now() where id='e0000000-0000-0000-0000-000000000001';
select ccat._assert_raises('terminal-no-return-to-in-progress',
  $q$update ccat.sessions set state='IN_PROGRESS' where id='e0000000-0000-0000-0000-000000000001'$q$);

-- ---- CONSTRAINT / DOMAIN TESTS ---------------------------------------------
select ccat._assert_raises('set-size-hard-bounds',
  $q$insert into ccat.question_set_versions(question_set_id,version_number,question_count,allowed_practice,state)
     values ('50000000-0000-0000-0000-000000000001',2,25,true,'draft')$q$);
select ccat._assert_raises('birth-month-domain',
  $q$insert into ccat.students(username_normalized,display_name,grade_id,birth_month,birth_year)
     values ('bad','Bad','11111111-1111-1111-1111-111111111111',13,2017)$q$);
select ccat._assert_raises('book-link-https-only',
  $q$insert into ccat.books(id,title) values ('b0000000-0000-0000-0000-000000000001','B');
     insert into ccat.book_retailer_links(book_id,retailer,destination_url)
     values ('b0000000-0000-0000-0000-000000000001','R','http://insecure.example')$q$);

-- ---- DIRECT-ACCESS TESTS (RLS / grants; §41) -------------------------------
-- The anon/authenticated PostgREST roles must have NO access to ccat data.
select ccat._assert_raises('anon-cannot-select-students',
  $q$set local role anon; select * from ccat.students limit 1$q$);
reset role;
select ccat._assert_raises('authenticated-cannot-select-sessions',
  $q$set local role authenticated; select * from ccat.sessions limit 1$q$);
reset role;

\echo '======================================================'
\echo 'ALL NEGATIVE-ACCESS TESTS PASSED'
\echo '======================================================'
