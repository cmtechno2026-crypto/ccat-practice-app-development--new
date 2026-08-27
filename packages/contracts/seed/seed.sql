-- ============================================================================
-- CCAT DEMO SEED — local development / demo content only. NOT production data.
-- Run after migrations 0000–0008 on a fresh database.
-- Provides: grades 3–6, categories, difficulties, two published Grade-5 sets with real
-- questions, a learning plan, avatars/themes/achievements, announcements, books, admins.
-- Admin logins:  super@cm.ca / Passw0rd!   support@cm.ca / Passw0rd!
-- Students register through the app (single-device model); none are pre-seeded.
-- ============================================================================
set search_path = ccat, public;

-- Grades (launch 3–6) ---------------------------------------------------------
insert into grades(id,grade_number,name,display_order,age_min_years,age_max_years) values
 ('a0000000-0000-0000-0000-000000000003',3,'Grade 3',0,7,10),
 ('a0000000-0000-0000-0000-000000000004',4,'Grade 4',1,8,11),
 ('a0000000-0000-0000-0000-000000000005',5,'Grade 5',2,9,13),
 ('a0000000-0000-0000-0000-000000000006',6,'Grade 6',3,10,14)
on conflict do nothing;

-- Categories / subcategories --------------------------------------------------
insert into categories(id,key,name,display_order) values
 ('b0000000-0000-0000-0000-000000000001','verbal','Verbal Reasoning',0),
 ('b0000000-0000-0000-0000-000000000002','quantitative','Quantitative Reasoning',1),
 ('b0000000-0000-0000-0000-000000000003','non_verbal','Non-Verbal Reasoning',2)
on conflict do nothing;
insert into subcategories(id,category_id,key,name,display_order) values
 ('b1000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','analogies','Analogies',0),
 ('b1000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000002','number_series','Number Series',0),
 ('b1000000-0000-0000-0000-000000000003','b0000000-0000-0000-0000-000000000003','odd_one_out','Odd One Out',0)
on conflict do nothing;

-- Difficulties ----------------------------------------------------------------
insert into difficulties(id,key,name,weight,display_order) values
 ('c0000000-0000-0000-0000-000000000001','easy','Easy',1.0,0),
 ('c0000000-0000-0000-0000-000000000002','medium','Medium',1.5,1),
 ('c0000000-0000-0000-0000-000000000003','hard','Hard',2.0,2)
on conflict do nothing;

-- Helper to make a 4-option question in one statement -------------------------
-- (Inlined below; verbal analogies set.)

-- VERBAL set: 5 analogy questions (Grade 5, easy/medium) -----------------------
do $$
declare
  qs uuid := 'd0000000-0000-0000-0000-0000000000a1';
  qv uuid;
  lq uuid;
  rows text[][] := array[
    array['Cat is to Kitten as Dog is to ?','Puppy','Cub','Foal','Chick','o1','easy'],
    array['Hand is to Glove as Foot is to ?','Sock','Hat','Scarf','Ring','o1','easy'],
    array['Author is to Book as Composer is to ?','Symphony','Painting','Statue','Poem','o1','medium'],
    array['Thermometer is to Temperature as Clock is to ?','Time','Weather','Speed','Weight','o1','easy'],
    array['Library is to Books as Gallery is to ?','Paintings','Animals','Plants','Cars','o1','medium']
  ];
  i int;
begin
  for i in 1..array_length(rows,1) loop
    lq := gen_random_uuid(); qv := gen_random_uuid();
    insert into logical_questions(id,category_id,subcategory_id) values
      (lq,'b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001');
    insert into question_versions(id,logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state,published_at)
    values (qv,lq,1,'a0000000-0000-0000-0000-000000000005',
      (select id from difficulties where key=rows[i][7]),'analogy',
      json_build_array(json_build_object('type','text','value',rows[i][1]))::jsonb,
      json_build_array(
        json_build_object('option_id','o1','content',json_build_array(json_build_object('type','text','value',rows[i][2]))),
        json_build_object('option_id','o2','content',json_build_array(json_build_object('type','text','value',rows[i][3]))),
        json_build_object('option_id','o3','content',json_build_array(json_build_object('type','text','value',rows[i][4]))),
        json_build_object('option_id','o4','content',json_build_array(json_build_object('type','text','value',rows[i][5])))
      )::jsonb,
      array[rows[i][6]],'published',now());
    if i=1 then
      insert into question_sets(id,grade_id,category_id,subcategory_id,name) values
        (qs,'a0000000-0000-0000-0000-000000000005','b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','Analogies · Level 1');
      insert into question_set_versions(id,question_set_id,version_number,difficulty_id,question_count,allowed_practice,allowed_exam,allowed_timers,state,published_at)
        values ('d5000000-0000-0000-0000-0000000000a1',qs,1,'c0000000-0000-0000-0000-000000000001',5,true,true,
          '[{"type":"untimed"},{"type":"timed","seconds":300}]'::jsonb,'published',now());
    end if;
    insert into set_version_questions(set_version_id,question_version_id,position) values ('d5000000-0000-0000-0000-0000000000a1',qv,i);
  end loop;
end $$;

-- QUANT set: 5 number-series questions (Grade 5) ------------------------------
do $$
declare
  qs uuid := 'd0000000-0000-0000-0000-0000000000b1';
  qv uuid; lq uuid;
  rows text[][] := array[
    array['2, 4, 6, 8, ?','10','9','12','11','o1','easy'],
    array['5, 10, 20, 40, ?','80','60','50','100','o1','medium'],
    array['1, 4, 9, 16, ?','25','20','24','30','o1','medium'],
    array['3, 6, 9, 12, ?','15','14','18','16','o1','easy'],
    array['100, 90, 80, 70, ?','60','65','75','50','o1','easy']
  ];
  i int;
begin
  for i in 1..array_length(rows,1) loop
    lq := gen_random_uuid(); qv := gen_random_uuid();
    insert into logical_questions(id,category_id,subcategory_id) values
      (lq,'b0000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000002');
    insert into question_versions(id,logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state,published_at)
    values (qv,lq,1,'a0000000-0000-0000-0000-000000000005',
      (select id from difficulties where key=rows[i][7]),'number_series',
      json_build_array(json_build_object('type','text','value',rows[i][1]))::jsonb,
      json_build_array(
        json_build_object('option_id','o1','content',json_build_array(json_build_object('type','text','value',rows[i][2]))),
        json_build_object('option_id','o2','content',json_build_array(json_build_object('type','text','value',rows[i][3]))),
        json_build_object('option_id','o3','content',json_build_array(json_build_object('type','text','value',rows[i][4]))),
        json_build_object('option_id','o4','content',json_build_array(json_build_object('type','text','value',rows[i][5])))
      )::jsonb,
      array[rows[i][6]],'published',now());
    if i=1 then
      insert into question_sets(id,grade_id,category_id,subcategory_id,name) values
        (qs,'a0000000-0000-0000-0000-000000000005','b0000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000002','Number Series · Level 1');
      insert into question_set_versions(id,question_set_id,version_number,difficulty_id,question_count,allowed_practice,allowed_exam,state,published_at)
        values ('d5000000-0000-0000-0000-0000000000b1',qs,1,'c0000000-0000-0000-0000-000000000002',5,true,true,'published',now());
    end if;
    insert into set_version_questions(set_version_id,question_version_id,position) values ('d5000000-0000-0000-0000-0000000000b1',qv,i);
  end loop;
end $$;

-- Learning plan (Grade 5) -> both sets count toward Progress -------------------
insert into learning_plans(id,grade_id,name) values ('d8000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000005','Grade 5 Core') on conflict do nothing;
insert into learning_plan_versions(id,learning_plan_id,version_number,is_active,published_at) values
 ('d8100000-0000-0000-0000-000000000001','d8000000-0000-0000-0000-000000000001',1,true,now()) on conflict do nothing;
insert into learning_plan_sets(learning_plan_version_id,question_set_id) values
 ('d8100000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-0000000000a1'),
 ('d8100000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-0000000000b1') on conflict do nothing;

-- Avatars (Fox family, 3 stages) + Themes ------------------------------------
insert into avatar_families(id,key,name,display_order) values ('c2000000-0000-0000-0000-000000000001','fox','Fox',0) on conflict do nothing;
insert into avatar_stages(id,family_id,stage_number,name,required_xp) values
 ('c2100000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',1,'Fox Kit',0),
 ('c2100000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001',2,'Young Fox',20),
 ('c2100000-0000-0000-0000-000000000003','c2000000-0000-0000-0000-000000000001',3,'Elder Fox',100) on conflict do nothing;
-- Themes carry a palette (CSS token -> hex) so equipping one repaints the whole client live (GAM-2, mig 0018).
insert into themes(id,key,name,palette) values
 ('c3000000-0000-0000-0000-000000000001','sky','Sky','{"--primary":"#3e7bee","--primary-dark":"#2c5fd0","--tint-blue":"#eaf0ff"}'::jsonb),
 ('c3000000-0000-0000-0000-000000000002','aurora','Aurora','{"--primary":"#8b5cf6","--primary-dark":"#6d4bc0","--tint-blue":"#f3ecfb"}'::jsonb),
 ('c3000000-0000-0000-0000-000000000003','meadow','Meadow','{"--primary":"#22a06b","--primary-dark":"#1e7a56","--tint-blue":"#e8f7f1"}'::jsonb),
 ('c3000000-0000-0000-0000-000000000004','sunset','Sunset','{"--primary":"#ef5b6b","--primary-dark":"#c2453f","--tint-blue":"#fdecef"}'::jsonb)
 on conflict (id) do update set palette = excluded.palette, name = excluded.name;
insert into theme_unlock_rules(theme_id,version_number,rule_expr,active) values
 ('c3000000-0000-0000-0000-000000000001',1,'{"type":"default"}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000002',1,'{"type":"xp_total","threshold":30}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000003',1,'{"type":"xp_total","threshold":50}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000004',1,'{"type":"xp_total","threshold":100}'::jsonb,true) on conflict do nothing;

-- Achievements ---------------------------------------------------------------
insert into achievements(id,key,name) values
 ('f0000000-0000-0000-0000-000000000001','first_set','First Set'),
 ('f0000000-0000-0000-0000-000000000002','perfectionist','Perfectionist'),
 ('f0000000-0000-0000-0000-000000000003','xp_100','Century Club') on conflict do nothing;
insert into achievement_versions(id,achievement_id,version_number,criteria,active) values
 ('f1000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000001',1,'{"type":"first_completion"}'::jsonb,true),
 ('f1000000-0000-0000-0000-000000000002','f0000000-0000-0000-0000-000000000002',1,'{"type":"perfect_set"}'::jsonb,true),
 ('f1000000-0000-0000-0000-000000000003','f0000000-0000-0000-0000-000000000003',1,'{"type":"xp_total","threshold":100}'::jsonb,true) on conflict do nothing;
insert into achievement_rewards(achievement_version_id,reward_kind,xp_amount) values
 ('f1000000-0000-0000-0000-000000000001','xp',25),('f1000000-0000-0000-0000-000000000003','xp',50) on conflict do nothing;
insert into achievement_rewards(achievement_version_id,reward_kind,coin_amount) values
 ('f1000000-0000-0000-0000-000000000002','coins',5) on conflict do nothing;

-- Announcements ---------------------------------------------------------------
insert into announcements(id,title,body_blocks,state,carousel_order,published_at) values
 ('e5000000-0000-0000-0000-000000000001','Welcome to CCAT Practice!','[{"type":"text","value":"New analogy and number-series sets are live. Give them a try!"}]'::jsonb,'published',0,now()),
 ('e5000000-0000-0000-0000-000000000002','Daily streaks are here','[{"type":"text","value":"Practice a little every day to build your streak and earn coins."}]'::jsonb,'published',1,now())
on conflict do nothing;

-- Book Store ------------------------------------------------------------------
-- Priced, subject-tagged, grade-targeted catalog across grades 3–6 so the store's grade + subject
-- filters and price / "% OFF" badges have real backing (some rows carry an original_price_cents).
insert into books(id,title,author,description,active,price_cents,original_price_cents,subject,grade_ids) values
 ('e6000000-0000-0000-0000-000000000001','Big Book of Brain Puzzles','A. Puzzle','Logic and pattern puzzles for curious minds.',true,1299,1799,'English','{a0000000-0000-0000-0000-000000000005}'),
 ('e6000000-0000-0000-0000-000000000002','Word Power Junior','B. Lexicon','Build vocabulary the fun way.',true,999,null,'English','{a0000000-0000-0000-0000-000000000004}'),
 ('e6000000-0000-0000-0000-000000000003','Math Marvels 3','C. Number','Number sense & patterns.',true,1499,1999,'Math','{a0000000-0000-0000-0000-000000000003}'),
 ('e6000000-0000-0000-0000-000000000004','Math Marvels 5','C. Number','Multi-step problem solving.',true,1599,null,'Math','{a0000000-0000-0000-0000-000000000005}'),
 ('e6000000-0000-0000-0000-000000000005','Science Sparks 4','D. Atom','Curious experiments & logic.',true,1699,2099,'Science','{a0000000-0000-0000-0000-000000000004}'),
 ('e6000000-0000-0000-0000-000000000006','Science Sparks 6','D. Atom','Reasoning with evidence.',true,1799,null,'Science','{a0000000-0000-0000-0000-000000000006}'),
 ('e6000000-0000-0000-0000-000000000007','Word Power Senior','B. Lexicon','Advanced vocabulary.',true,1199,1599,'English','{a0000000-0000-0000-0000-000000000006}'),
 ('e6000000-0000-0000-0000-000000000008','Grade 3 Reasoning','E. Logic','Gentle intro to CCAT skills.',true,1099,null,'English','{a0000000-0000-0000-0000-000000000003}')
on conflict do nothing;
insert into book_retailer_links(id,book_id,retailer,destination_url,display_order,active) values
 ('e6100000-0000-0000-0000-000000000001','e6000000-0000-0000-0000-000000000001','Amazon','https://amazon.ca/dp/brain-puzzles',0,true),
 ('e6100000-0000-0000-0000-000000000002','e6000000-0000-0000-0000-000000000002','Indigo / Chapters','https://indigo.ca/word-power-junior',0,true),
 ('e6100000-0000-0000-0000-000000000003','e6000000-0000-0000-0000-000000000003','Amazon','https://amazon.ca/dp/mathmarvels3',0,true),
 ('e6100000-0000-0000-0000-000000000004','e6000000-0000-0000-0000-000000000003','Indigo / Chapters','https://indigo.ca/mathmarvels3',1,true),
 ('e6100000-0000-0000-0000-000000000005','e6000000-0000-0000-0000-000000000004','Amazon','https://amazon.ca/dp/mathmarvels5',0,true),
 ('e6100000-0000-0000-0000-000000000006','e6000000-0000-0000-0000-000000000005','Kobo','https://kobo.com/sciencesparks4',0,true),
 ('e6100000-0000-0000-0000-000000000007','e6000000-0000-0000-0000-000000000006','Amazon','https://amazon.ca/dp/sciencesparks6',0,true),
 ('e6100000-0000-0000-0000-000000000008','e6000000-0000-0000-0000-000000000007','Indigo / Chapters','https://indigo.ca/wordpowersenior',0,true),
 ('e6100000-0000-0000-0000-000000000009','e6000000-0000-0000-0000-000000000008','Amazon','https://amazon.ca/dp/g3reasoning',0,true)
on conflict do nothing;

-- Full permission catalog (Blueprint §23) --------------------------------------
insert into permissions(key,description,super_admin_only) values
 ('student.directory','View student directory + guardian PII',false),
 ('student.suspend','Suspend a student',false),('student.unsuspend','Lift suspension',false),
 ('student.ban','Ban a student',false),('student.unban','Reverse a ban',false),
 ('device.revoke','Revoke enrolled device',false),('device.replace','Support device replacement',false),
 ('device.break_glass','Break-glass device replacement',false),
 ('session.invalidate','Invalidate a session',false),('reward.adjust','Compensating reward adjustment',false),
 ('deletion.support','Support deletion/restore',false),('export.support','Support data export',false),
 ('student.deletion.override','Exceptional admin deletion',false),
 ('content.create','Create/import content',false),('content.edit','Edit unpublished content',false),
 ('content.review','Review content',false),('content.publish','Publish content',false),
 ('content.retire','Retire published content',false),('learning_plan.manage','Manage learning plans',false),
 ('achievement.manage','Manage achievements',false),('avatar.manage','Manage avatars',false),('theme.manage','Manage themes',false),
 ('announcement.manage','Manage announcements',false),('announcement.publish','Publish carousel',false),
 ('push.request','Request push campaign',false),('book.manage','Manage Book Store',false),
 ('incident.manage','Manage incidents',false),
 ('audit.export.self','Export own audit',false),
 ('grade.manage','Manage grade catalog',true),('config.global','Global configuration',true),
 ('flags.emergency','Emergency global controls',true),('admin.manage','Admin lifecycle/permissions',true),
 ('push.approve','Approve push',true),('audit.read.global','Read global audit',true),('dr.restore','DR restore control',true)
on conflict do nothing;

insert into admin_profiles(id,email,display_name,security_role,status,mfa_enrolled,must_change_password) values
 ('a9000000-0000-0000-0000-000000000001','super@cm.ca','Super Admin','super_admin','active',true,false),
 ('a9000000-0000-0000-0000-000000000002','support@cm.ca','Support Admin','admin','active',true,false),
 ('a9000000-0000-0000-0000-000000000003','content@cm.ca','Content Editor','admin','active',true,false)
on conflict do nothing;
-- Support admin: student support + comms + health, but NOT ban/publish/config/accounts/push-approve.
insert into admin_permissions(admin_id,permission_key,granted_by) values
 ('a9000000-0000-0000-0000-000000000002','student.directory','a9000000-0000-0000-0000-000000000001'),
 ('a9000000-0000-0000-0000-000000000002','student.suspend','a9000000-0000-0000-0000-000000000001'),
 ('a9000000-0000-0000-0000-000000000002','student.unsuspend','a9000000-0000-0000-0000-000000000001'),
 ('a9000000-0000-0000-0000-000000000002','device.revoke','a9000000-0000-0000-0000-000000000001'),
 ('a9000000-0000-0000-0000-000000000002','reward.adjust','a9000000-0000-0000-0000-000000000001'),
 ('a9000000-0000-0000-0000-000000000002','announcement.manage','a9000000-0000-0000-0000-000000000001'),
 -- Content editor: full content workflow incl. publish, plus rewards/achievements.
 ('a9000000-0000-0000-0000-000000000003','content.create','a9000000-0000-0000-0000-000000000001'),
 ('a9000000-0000-0000-0000-000000000003','content.edit','a9000000-0000-0000-0000-000000000001'),
 ('a9000000-0000-0000-0000-000000000003','content.review','a9000000-0000-0000-0000-000000000001'),
 ('a9000000-0000-0000-0000-000000000003','content.publish','a9000000-0000-0000-0000-000000000001'),
 ('a9000000-0000-0000-0000-000000000003','content.retire','a9000000-0000-0000-0000-000000000001'),
 ('a9000000-0000-0000-0000-000000000003','achievement.manage','a9000000-0000-0000-0000-000000000001')
on conflict do nothing;
-- Password verifier for 'Passw0rd!' (pepper 'dev-pepper'). DEV ONLY.
insert into admin_local_credentials(admin_id,password_hash) values
 ('a9000000-0000-0000-0000-000000000001','scrypt$8f6cf872bedad70a1c508db0ae8080d7$deb397cbb47990db50d9d93c0cbd3cb7f43daa36b4ba65001973b9aad7351092'),
 ('a9000000-0000-0000-0000-000000000002','scrypt$8f6cf872bedad70a1c508db0ae8080d7$deb397cbb47990db50d9d93c0cbd3cb7f43daa36b4ba65001973b9aad7351092'),
 ('a9000000-0000-0000-0000-000000000003','scrypt$8f6cf872bedad70a1c508db0ae8080d7$deb397cbb47990db50d9d93c0cbd3cb7f43daa36b4ba65001973b9aad7351092')
on conflict do nothing;

-- Content workflow demo: one APPROVED question ready to publish + one DRAFT to review ---------
do $$
declare lq uuid; begin
  lq := 'd0000000-0000-0000-0000-0000000000c1';
  if not exists (select 1 from logical_questions where id=lq) then
    insert into logical_questions(id,category_id,subcategory_id) values (lq,'b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001');
    insert into question_versions(id,logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state,provenance)
    values ('d1000000-0000-0000-0000-0000000000c1',lq,1,'a0000000-0000-0000-0000-000000000005','c0000000-0000-0000-0000-000000000002','analogy',
      '[{"type":"text","value":"Pen is to Write as Knife is to ?"}]'::jsonb,
      '[{"option_id":"o1","content":[{"type":"text","value":"Cut"}]},{"option_id":"o2","content":[{"type":"text","value":"Draw"}]},{"option_id":"o3","content":[{"type":"text","value":"Erase"}]}]'::jsonb,
      '{o1}','approved','{"origin":"human"}'::jsonb);
  end if;
  lq := 'd0000000-0000-0000-0000-0000000000c2';
  if not exists (select 1 from logical_questions where id=lq) then
    insert into logical_questions(id,category_id,subcategory_id) values (lq,'b0000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000002');
    insert into question_versions(id,logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state,provenance)
    values ('d1000000-0000-0000-0000-0000000000c2',lq,1,'a0000000-0000-0000-0000-000000000005','c0000000-0000-0000-0000-000000000001','number_series',
      '[{"type":"text","value":"7, 14, 28, 56, ?"}]'::jsonb,
      '[{"option_id":"o1","content":[{"type":"text","value":"112"}]},{"option_id":"o2","content":[{"type":"text","value":"84"}]},{"option_id":"o3","content":[{"type":"text","value":"98"}]}]'::jsonb,
      '{o1}','draft','{"origin":"ai"}'::jsonb);
  end if;
end $$;

-- A push campaign awaiting approval + an open incident + a couple health snapshots ------------
insert into push_campaigns(id,title,payload,state,requested_by,created_at) values
 ('e7000000-0000-0000-0000-000000000001','Weekend challenge','{"title":"Weekend challenge","body":"Complete 3 sets this weekend for bonus coins!"}'::jsonb,'requested','a9000000-0000-0000-0000-000000000002',now())
on conflict do nothing;
insert into incident_records(id,title,severity,state,opened_by,summary,opened_at) values
 ('e8000000-0000-0000-0000-000000000001','Elevated OTP latency','minor','monitoring','a9000000-0000-0000-0000-000000000001','SMS provider slower than usual; email OTP unaffected.',now()-interval '3 hours')
on conflict do nothing;
insert into health_snapshots(indicator,state,value,observed_at) values
 ('login_success','Healthy',99.4,now()),('content_delivery','Healthy',100,now()),
 ('provider_health','Degraded',92,now()),('latency_p95','Healthy',210,now())
on conflict do nothing;
-- Demo: make Fox a full 7-stage live family; add Owl (draft, 4/7 active). Idempotent.
insert into ccat.avatar_stages(id, family_id, stage_number, name, required_xp, active)
select gen_random_uuid(), f.id, n, 'Fox · Stage '||n, (array[0,50,120,220,350,520,750])[n], true
  from ccat.avatar_families f, generate_series(4,7) n
 where f.key='fox' and not exists (select 1 from ccat.avatar_stages s where s.family_id=f.id and s.stage_number=n);

insert into ccat.avatar_families(id,key,name,display_order,active)
select gen_random_uuid(),'owl','Owl',(select coalesce(max(display_order),0)+1 from ccat.avatar_families),false
 where not exists (select 1 from ccat.avatar_families where key='owl');
insert into ccat.avatar_stages(id,family_id,stage_number,name,required_xp,active)
select gen_random_uuid(), f.id, n, 'Owl · Stage '||n, (array[0,50,120,220,350,520,750])[n], n<=4
  from ccat.avatar_families f, generate_series(1,7) n
 where f.key='owl' and not exists (select 1 from ccat.avatar_stages s where s.family_id=f.id and s.stage_number=n);

-- a couple of demo ownership grants so owner counts are non-zero
insert into ccat.student_avatar_grants(student_id, avatar_stage_id, source_kind)
select s.id, st.id, 'xp'
  from ccat.students s
  join ccat.avatar_stages st on st.family_id=(select id from ccat.avatar_families where key='fox') and st.stage_number<=2
 where s.username_normalized::text like 'stu_00%'
 on conflict do nothing;
