import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

// CHANGE 2 (remove 'Analogies' + 'Odd One Out') and CHANGE 3 (order default = fixed).
// Verifies: (1) the two subcategories are absent after migrate+seed and nothing is filed under them;
// (2) question_set_versions.preserve_order defaults to true (serve in authoring order);
// (3) the ACTUAL 0029 SQL safe-aborts when 'Odd One Out' unexpectedly has content (nothing deleted);
// (4) the ACTUAL 0029 SQL deletes 'Analogies' content when it is not referenced by a student session.
// The 0029 body is embedded verbatim so we test the migration, not a paraphrase.

// These ids match the test harness's inline seed (apps/gateway/test/setup.ts): grade 5, the verbal
// category, and the 'easy' difficulty. setup.ts seeds only verbal + quantitative categories (no
// non-verbal), so fixtures below attach to the verbal category, which always exists.
const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
const VERBAL = 'b0000000-0000-0000-0000-000000000001';
const EASY = 'c0000000-0000-0000-0000-000000000001';

// Verbatim body of packages/contracts/migrations/0029_remove_subcategories.sql (keyed on the real keys).
const MIGRATION_0029 = `do $$
declare v_analogies uuid; v_odd uuid;
begin
  select id into v_odd       from ccat.subcategories where key = 'odd_one_out';
  select id into v_analogies from ccat.subcategories where key = 'analogies';
  if v_odd is not null then
    if exists (select 1 from ccat.logical_questions where subcategory_id = v_odd)
       or exists (select 1 from ccat.question_sets where subcategory_id = v_odd) then
      raise exception 'Odd One Out unexpectedly has content — aborting.';
    end if;
    delete from ccat.subcategories where id = v_odd;
  end if;
  if v_analogies is not null then
    delete from ccat.set_version_questions svq using ccat.question_set_versions sv, ccat.question_sets qs
      where svq.set_version_id = sv.id and sv.question_set_id = qs.id and qs.subcategory_id = v_analogies;
    delete from ccat.question_set_versions sv using ccat.question_sets qs
      where sv.question_set_id = qs.id and qs.subcategory_id = v_analogies;
    delete from ccat.question_sets where subcategory_id = v_analogies;
    delete from ccat.set_version_questions svq using ccat.question_versions qv, ccat.logical_questions lq
      where svq.question_version_id = qv.id and qv.logical_question_id = lq.id and lq.subcategory_id = v_analogies;
    delete from ccat.content_reviews cr using ccat.question_versions qv, ccat.logical_questions lq
      where cr.target_kind='question_version' and cr.target_id=qv.id and qv.logical_question_id=lq.id and lq.subcategory_id=v_analogies;
    delete from ccat.question_versions qv using ccat.logical_questions lq
      where qv.logical_question_id = lq.id and lq.subcategory_id = v_analogies;
    delete from ccat.logical_questions where subcategory_id = v_analogies;
    delete from ccat.subcategories where id = v_analogies;
  end if;
end $$;`;

let db: pg.Client;
const one = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];
const count = async (sql: string, p: any[] = []) => Number((await db.query(sql, p)).rows[0].c);

beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('set search_path = ccat, public');
});
afterAll(async () => {
  // Best-effort cleanup of any fixtures left by an aborted case.
  await db.query(`delete from ccat.logical_questions where subcategory_id in (select id from ccat.subcategories where key in ('odd_one_out','analogies'))`).catch(() => {});
  await db.query(`delete from ccat.subcategories where key in ('odd_one_out','analogies')`).catch(() => {});
  await db.end();
});

describe('taxonomy prune (CHANGE 2) + order default (CHANGE 3)', () => {
  it('after migrate+seed, Analogies and Odd One Out do not exist', async () => {
    expect(await count(`select count(*) c from ccat.subcategories where key in ('analogies','odd_one_out')`)).toBe(0);
  });

  it('no content is filed under the removed subcategories', async () => {
    expect(await count(`select count(*) c from ccat.logical_questions lq join ccat.subcategories s on s.id=lq.subcategory_id where s.key in ('analogies','odd_one_out')`)).toBe(0);
    expect(await count(`select count(*) c from ccat.question_sets qs join ccat.subcategories s on s.id=qs.subcategory_id where s.key in ('analogies','odd_one_out')`)).toBe(0);
  });

  it('preserve_order defaults to true (serve in authoring order — CHANGE 3)', async () => {
    const r = await one(`select column_default from information_schema.columns where table_schema='ccat' and table_name='question_set_versions' and column_name='preserve_order'`);
    expect(String(r.column_default)).toBe('true');
  });

  it('0029 SAFE-ABORTS if Odd One Out unexpectedly has content (nothing deleted)', async () => {
    // Recreate an odd_one_out subcategory with a question under it, then run the real 0029 body.
    // 0029's guard keys on key='odd_one_out' regardless of parent category, so we attach it to the
    // verbal category (which the harness seeds) rather than a non-verbal one it doesn't create.
    await db.query(`insert into ccat.subcategories(id,category_id,key,name) values (gen_random_uuid(),$1,'odd_one_out','Odd One Out') on conflict do nothing`, [VERBAL]);
    const sub = await one(`select id from ccat.subcategories where key='odd_one_out'`);
    await db.query(`insert into ccat.logical_questions(id,category_id,subcategory_id) values (gen_random_uuid(),$1,$2)`, [VERBAL, sub.id]);
    await expect(db.query(MIGRATION_0029)).rejects.toThrow(/Odd One Out unexpectedly has content/);
    // aborted → the subcategory and its question are still present
    expect(await count(`select count(*) c from ccat.subcategories where key='odd_one_out'`)).toBe(1);
    // cleanup
    await db.query(`delete from ccat.logical_questions where subcategory_id=$1`, [sub.id]);
    await db.query(`delete from ccat.subcategories where id=$1`, [sub.id]);
  });

  it('0029 DELETES Analogies content when unreferenced, then removes the subcategory', async () => {
    await db.query(`insert into ccat.subcategories(id,category_id,key,name) values (gen_random_uuid(),$1,'analogies','Analogies') on conflict do nothing`, [VERBAL]);
    const sub = await one(`select id from ccat.subcategories where key='analogies'`);
    const lq = (await one(`insert into ccat.logical_questions(id,category_id,subcategory_id) values (gen_random_uuid(),$1,$2) returning id`, [VERBAL, sub.id])).id;
    const qv = (await one(`insert into ccat.question_versions(id,logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,state)
      values (gen_random_uuid(),$1,1,$2,$3,'analogy',
        '[{"type":"text","value":"A is to B as C is to ?"}]'::jsonb,
        '[{"option_id":"o1","content":[{"type":"text","value":"D"}]},{"option_id":"o2","content":[{"type":"text","value":"E"}]}]'::jsonb,
        '{o1}','draft') returning id`, [lq, GRADE5, EASY])).id;
    const qs = (await one(`insert into ccat.question_sets(id,grade_id,category_id,subcategory_id,name) values (gen_random_uuid(),$1,$2,$3,'Prune test set') returning id`, [GRADE5, VERBAL, sub.id])).id;
    const sv = (await one(`insert into ccat.question_set_versions(id,question_set_id,version_number,difficulty_id,question_count,allowed_practice,allowed_exam,state) values (gen_random_uuid(),$1,1,$2,5,true,false,'draft') returning id`, [qs, EASY])).id;
    await db.query(`insert into ccat.set_version_questions(set_version_id,question_version_id,position) values ($1,$2,1)`, [sv, qv]);

    await db.query(MIGRATION_0029); // no session_answers reference → deletes cleanly

    expect(await count(`select count(*) c from ccat.subcategories where key='analogies'`)).toBe(0);
    expect(await count(`select count(*) c from ccat.question_sets where id=$1`, [qs])).toBe(0);
    expect(await count(`select count(*) c from ccat.question_versions where id=$1`, [qv])).toBe(0);
    expect(await count(`select count(*) c from ccat.logical_questions where id=$1`, [lq])).toBe(0);
  });
});
