import pg from 'pg';
import { runMigrations } from '../src/lib/migrate.js';
import { hashSecret } from '../src/security/crypto.js';

// Global setup: create a fresh test database, apply migrations 0000-0007, and seed a minimal
// content graph so the student vertical can run end-to-end.
// Requires:
//   ADMIN_DATABASE_URL — maintenance connection (to a db like `postgres`)
//   TEST_DATABASE_URL  — target test db url (will be dropped & recreated)

export default async function () {
  const admin = process.env.ADMIN_DATABASE_URL;
  const target = process.env.TEST_DATABASE_URL;
  if (!admin || !target) throw new Error('ADMIN_DATABASE_URL and TEST_DATABASE_URL required');
  const dbName = new URL(target).pathname.slice(1);

  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  await a.query(`drop database if exists ${dbName} with (force)`);
  await a.query(`create database ${dbName}`);
  await a.end();

  await runMigrations(target);

  const c = new pg.Client({ connectionString: target });
  await c.connect();
  await c.query('set search_path = ccat, public');
  // Seed grade (age bounds wide enough for the test child), category graph, published set.
  await c.query(`insert into grades(id,grade_number,name,age_min_years,age_max_years)
    values ('a0000000-0000-0000-0000-000000000005',5,'Grade 5',8,13)`);
  await c.query(`insert into categories(id,key,name) values ('b0000000-0000-0000-0000-000000000001','verbal','Verbal')`);
  await c.query(`insert into subcategories(id,category_id,key,name)
    values ('b1000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','an','Analogies')`);
  await c.query(`insert into difficulties(id,key,name,weight) values ('c0000000-0000-0000-0000-000000000001','easy','Easy',1.0)`);
  await c.query(`insert into logical_questions(id,category_id,subcategory_id)
    values ('d0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001')`);
  await c.query(`insert into question_versions(id,logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state,published_at)
    values ('d1000000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-000000000001',1,'a0000000-0000-0000-0000-000000000005','c0000000-0000-0000-0000-000000000001','analogy',
      '[{"type":"text","value":"Cat:Kitten :: Dog:?"}]'::jsonb,
      '[{"option_id":"o1","content":[{"type":"text","value":"Puppy"}]},{"option_id":"o2","content":[{"type":"text","value":"Cub"}]}]'::jsonb,
      '{o1}','published',now())`);
  await c.query(`insert into question_sets(id,grade_id,category_id,subcategory_id,name)
    values ('e0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000005','b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','Analogies 1')`);
  await c.query(`insert into question_set_versions(id,question_set_id,version_number,difficulty_id,question_count,allowed_practice,allowed_exam,state,published_at)
    values ('e1000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001',1,'c0000000-0000-0000-0000-000000000001',1,true,true,'published',now())`);
  await c.query(`insert into set_version_questions(set_version_id,question_version_id,position)
    values ('e1000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001',1)`);
  // Multi-correct ("pick all") fixture: a question whose correct set is {o1,o3}, in its own set.
  await c.query(`insert into logical_questions(id,category_id,subcategory_id)
    values ('d0000000-0000-0000-0000-0000000000e1','b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001')`);
  await c.query(`insert into question_versions(id,logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state,published_at)
    values ('d1000000-0000-0000-0000-0000000000e1','d0000000-0000-0000-0000-0000000000e1',1,'a0000000-0000-0000-0000-000000000005','c0000000-0000-0000-0000-000000000001','multi_select',
      '[{"type":"text","value":"Pick the even numbers"}]'::jsonb,
      '[{"option_id":"o1","content":[{"type":"text","value":"2"}]},{"option_id":"o2","content":[{"type":"text","value":"3"}]},{"option_id":"o3","content":[{"type":"text","value":"4"}]}]'::jsonb,
      '{o1,o3}','published',now())`);
  await c.query(`insert into question_sets(id,grade_id,category_id,subcategory_id,name)
    values ('e0000000-0000-0000-0000-0000000000e1','a0000000-0000-0000-0000-000000000005','b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','Multi 1')`);
  await c.query(`insert into question_set_versions(id,question_set_id,version_number,difficulty_id,question_count,allowed_practice,allowed_exam,state,published_at)
    values ('e1000000-0000-0000-0000-0000000000e1','e0000000-0000-0000-0000-0000000000e1',1,'c0000000-0000-0000-0000-000000000001',1,true,false,'published',now())`);
  await c.query(`insert into set_version_questions(set_version_id,question_version_id,position)
    values ('e1000000-0000-0000-0000-0000000000e1','d1000000-0000-0000-0000-0000000000e1',1)`);

  // Exam battery fixture: a second category (Quantitative) + a 2-battery exam paper (1 Verbal +
  // 1 Quantitative) so by-battery result breakdown + exam history can be asserted.
  await c.query(`insert into categories(id,key,name) values ('b0000000-0000-0000-0000-000000000002','quantitative','Quantitative')`);
  await c.query(`insert into subcategories(id,category_id,key,name) values ('b1000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000002','ns','Number Series')`);
  await c.query(`insert into logical_questions(id,category_id,subcategory_id) values ('d0000000-0000-0000-0000-0000000000a2','b0000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000002')`);
  await c.query(`insert into question_versions(id,logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state,published_at)
    values ('d1000000-0000-0000-0000-0000000000a2','d0000000-0000-0000-0000-0000000000a2',1,'a0000000-0000-0000-0000-000000000005','c0000000-0000-0000-0000-000000000001','number_series',
      '[{"type":"text","value":"2,4,6,?"}]'::jsonb,
      '[{"option_id":"o1","content":[{"type":"text","value":"8"}]},{"option_id":"o2","content":[{"type":"text","value":"7"}]}]'::jsonb,
      '{o1}','published',now())`);
  await c.query(`insert into question_sets(id,grade_id,category_id,subcategory_id,name)
    values ('e0000000-0000-0000-0000-0000000000b2','a0000000-0000-0000-0000-000000000005','b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','Mock Exam')`);
  await c.query(`insert into question_set_versions(id,question_set_id,version_number,difficulty_id,question_count,allowed_practice,allowed_exam,duration_minutes,state,published_at)
    values ('e1000000-0000-0000-0000-0000000000b2','e0000000-0000-0000-0000-0000000000b2',1,'c0000000-0000-0000-0000-000000000001',2,false,true,15,'published',now())`);
  await c.query(`insert into set_version_questions(set_version_id,question_version_id,position)
    values ('e1000000-0000-0000-0000-0000000000b2','d1000000-0000-0000-0000-000000000001',1),
           ('e1000000-0000-0000-0000-0000000000b2','d1000000-0000-0000-0000-0000000000a2',2)`);

  // Achievements: first completion (+25 XP) and perfect set (+5 coins).
  await c.query(`insert into achievements(id,key,name) values
    ('f0000000-0000-0000-0000-000000000001','first_set','First Set'),
    ('f0000000-0000-0000-0000-000000000002','perfectionist','Perfectionist')`);
  await c.query(`insert into achievement_versions(id,achievement_id,version_number,criteria,active) values
    ('f1000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000001',1,'{"type":"first_completion"}'::jsonb,true),
    ('f1000000-0000-0000-0000-000000000002','f0000000-0000-0000-0000-000000000002',1,'{"type":"perfect_set"}'::jsonb,true)`);
  await c.query(`insert into achievement_rewards(achievement_version_id,reward_kind,xp_amount) values
    ('f1000000-0000-0000-0000-000000000001','xp',25)`);
  await c.query(`insert into achievement_rewards(achievement_version_id,reward_kind,coin_amount) values
    ('f1000000-0000-0000-0000-000000000002','coins',5)`);
  // Avatars: one family, 3 stages (free / 20 XP / 100 XP).
  await c.query(`insert into avatar_families(id,key,name,display_order) values
    ('c2000000-0000-0000-0000-000000000001','fox','Fox',0)`);
  await c.query(`insert into avatar_stages(id,family_id,stage_number,name,required_xp) values
    ('c2100000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001',1,'Fox Kit',0),
    ('c2100000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000001',2,'Young Fox',20),
    ('c2100000-0000-0000-0000-000000000003','c2000000-0000-0000-0000-000000000001',3,'Elder Fox',100)`);
  // Themes: a free default and an XP-gated one (30 XP).
  await c.query(`insert into themes(id,key,name) values
    ('c3000000-0000-0000-0000-000000000001','sky','Sky'),
    ('c3000000-0000-0000-0000-000000000002','aurora','Aurora')`);
  await c.query(`insert into theme_unlock_rules(theme_id,version_number,rule_expr,active) values
    ('c3000000-0000-0000-0000-000000000001',1,'{"type":"default"}'::jsonb,true),
    ('c3000000-0000-0000-0000-000000000002',1,'{"type":"xp_total","threshold":30}'::jsonb,true)`);

  // Announcement (published, all grades) + a book with an allowlisted HTTPS retailer link.
  await c.query(`insert into announcements(id,title,body_blocks,state,carousel_order,published_at) values
    ('e5000000-0000-0000-0000-000000000001','Welcome to CCAT!','[{"type":"text","value":"New sets added this week."}]'::jsonb,'published',0,now())`);
  await c.query(`insert into books(id,title,author,description,active) values
    ('e6000000-0000-0000-0000-000000000001','Big Book of Puzzles','A. Author','Fun logic puzzles',true)`);
  await c.query(`insert into book_retailer_links(id,book_id,retailer,destination_url,display_order,active) values
    ('e6100000-0000-0000-0000-000000000001','e6000000-0000-0000-0000-000000000001','Example Books','https://books.example.com/big-book',0,true)`);

  // Full permission catalog (Blueprint §23).
  const perms: [string, boolean][] = [
    ['student.directory',false],['student.suspend',false],['student.unsuspend',false],['student.ban',false],['student.unban',false],
    ['device.revoke',false],['device.replace',false],['device.break_glass',false],['session.invalidate',false],['reward.adjust',false],
    ['deletion.support',false],['export.support',false],['student.deletion.override',false],
    ['content.create',false],['content.edit',false],['content.review',false],['content.publish',false],['content.retire',false],['learning_plan.manage',false],
    ['achievement.manage',false],['avatar.manage',false],['theme.manage',false],
    ['announcement.manage',false],['announcement.publish',false],['push.request',false],['book.manage',false],
    ['incident.manage',false],['audit.export.self',false],
    ['grade.manage',true],['config.global',true],['flags.emergency',true],['admin.manage',true],['push.approve',true],['audit.read.global',true],['dr.restore',true]];
  for (const [k,sa] of perms) await c.query('insert into permissions(key,description,super_admin_only) values ($1,$1,$2) on conflict do nothing', [k,sa]);

  // Admins: super, support (limited), content editor (content workflow).
  await c.query(`insert into admin_profiles(id,email,display_name,security_role,status,mfa_enrolled,must_change_password) values
    ('a9000000-0000-0000-0000-000000000001','super@cm.ca','Super Admin','super_admin','active',true,false),
    ('a9000000-0000-0000-0000-000000000002','support@cm.ca','Support Admin','admin','active',true,false),
    ('a9000000-0000-0000-0000-000000000003','content@cm.ca','Content Editor','admin','active',true,false)`);
  await c.query(`insert into admin_permissions(admin_id,permission_key,granted_by) values
    ('a9000000-0000-0000-0000-000000000002','student.directory','a9000000-0000-0000-0000-000000000001'),
    ('a9000000-0000-0000-0000-000000000002','student.suspend','a9000000-0000-0000-0000-000000000001'),
    ('a9000000-0000-0000-0000-000000000002','student.unsuspend','a9000000-0000-0000-0000-000000000001'),
    ('a9000000-0000-0000-0000-000000000002','device.revoke','a9000000-0000-0000-0000-000000000001'),
    ('a9000000-0000-0000-0000-000000000002','reward.adjust','a9000000-0000-0000-0000-000000000001'),
    ('a9000000-0000-0000-0000-000000000002','announcement.manage','a9000000-0000-0000-0000-000000000001'),
    ('a9000000-0000-0000-0000-000000000003','content.create','a9000000-0000-0000-0000-000000000001'),
    ('a9000000-0000-0000-0000-000000000003','content.edit','a9000000-0000-0000-0000-000000000001'),
    ('a9000000-0000-0000-0000-000000000003','content.review','a9000000-0000-0000-0000-000000000001'),
    ('a9000000-0000-0000-0000-000000000003','content.publish','a9000000-0000-0000-0000-000000000001'),
    ('a9000000-0000-0000-0000-000000000003','achievement.manage','a9000000-0000-0000-0000-000000000001')`);
  const pw = await hashSecret('Passw0rd!', 'dev-pepper');
  await c.query('insert into admin_local_credentials(admin_id,password_hash) values ($1,$2),($3,$2),($4,$2)',
    ['a9000000-0000-0000-0000-000000000001', pw, 'a9000000-0000-0000-0000-000000000002', 'a9000000-0000-0000-0000-000000000003']);

  // Content-workflow fixtures: one APPROVED question (publishable) + one DRAFT (reviewable).
  await c.query(`insert into logical_questions(id,category_id,subcategory_id) values
    ('d0000000-0000-0000-0000-0000000000c1','b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001')`);
  await c.query(`insert into question_versions(id,logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state,provenance)
    values ('d1000000-0000-0000-0000-0000000000c1','d0000000-0000-0000-0000-0000000000c1',1,'a0000000-0000-0000-0000-000000000005','c0000000-0000-0000-0000-000000000001','analogy',
    '[{"type":"text","value":"Pen:Write :: Knife:?"}]'::jsonb,
    '[{"option_id":"o1","content":[{"type":"text","value":"Cut"}]},{"option_id":"o2","content":[{"type":"text","value":"Draw"}]}]'::jsonb,
    '{o1}','approved','{"origin":"human"}'::jsonb)`);
  await c.query(`insert into logical_questions(id,category_id,subcategory_id) values
    ('d0000000-0000-0000-0000-0000000000c2','b0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001')`);
  await c.query(`insert into question_versions(id,logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state,provenance)
    values ('d1000000-0000-0000-0000-0000000000c2','d0000000-0000-0000-0000-0000000000c2',1,'a0000000-0000-0000-0000-000000000005','c0000000-0000-0000-0000-000000000001','analogy',
    '[{"type":"text","value":"Hot:Cold :: Up:?"}]'::jsonb,
    '[{"option_id":"o1","content":[{"type":"text","value":"Down"}]},{"option_id":"o2","content":[{"type":"text","value":"Sky"}]}]'::jsonb,
    '{o1}','draft','{"origin":"ai"}'::jsonb)`);
  // Push campaign awaiting approval + incident + health snapshots.
  await c.query(`insert into push_campaigns(id,title,payload,state,requested_by) values
    ('e7000000-0000-0000-0000-000000000001','Weekend challenge','{"title":"Weekend","body":"3 sets"}'::jsonb,'requested','a9000000-0000-0000-0000-000000000002')`);
  await c.query(`insert into incident_records(id,title,severity,state,opened_by,summary) values
    ('e8000000-0000-0000-0000-000000000001','OTP latency','minor','monitoring','a9000000-0000-0000-0000-000000000001','SMS slow')`);
  await c.query(`insert into health_snapshots(indicator,state,value) values ('login_success','Healthy',99.4),('provider_health','Degraded',92)`);

  await c.end();

  process.env.DATABASE_URL = target;
  process.env.GATEWAY_HMAC_SECRET = 'test-secret';
  process.env.NODE_ENV = 'local';
}
