-- Demo students for the admin directory (DEV ONLY). Idempotent: clears prior 'stu_%' demo rows
-- and regenerates a realistic spread across grades 3-6 with readiness, progress, devices and
-- guardian contacts so the Students directory can be exercised at a useful scale locally.
-- Run:  psql ... -f packages/contracts/seed/demo-students.sql   (or `pnpm seed:students`)
do $$
declare
  i int;
  gnum int; gid uuid; sid uuid; ggid uuid; lpv uuid;
  fnames text[] := array['Aisha','Kian','Noor','Leo','Maya','Omar','Devan','Sara','Priya','Arjun','Zoe','Ethan','Layla','Ravi','Mia','Yusuf','Hana','Ivan','Nadia','Sam','Ella','Rohan','Tara','Jack','Amara','Bilal','Chloe','Dara','Faris','Grace'];
  lnames text[] := array['Rahman','Gill','Haider','Martinez','Okafor','Siddiqui','Patel','Hussein','Rao','Sharma','Wong','Brown','Ahmed','Kumar','Nguyen','Ali','Cohen','Petrov','Khan','Mehta'];
  fn text; ln text; uname text; st ccat.student_status; pct numeric; bnd text; ndev int; nact int; xp bigint; coins bigint;
begin
  -- Idempotent guard (safe to re-run). Demo students carry append-only reward-ledger rows
  -- (xp_transactions / coin_transactions, source_kind='seed_demo'), and those FK-cascade from
  -- ccat.students. Deleting the demo students would cascade into the ledgers, which the
  -- append-only trigger (tg_forbid_mutation, §36.3) forbids — so we MUST NOT delete-and-regenerate
  -- once they exist. If demo students are already present, skip entirely. To regenerate from
  -- scratch, reset the database (dev: `docker compose down -v` then re-run migrate + seed).
  if exists (select 1 from ccat.students where username_normalized::text like 'stu\_%') then
    raise notice 'Demo students already present — student seed skipped (append-only ledgers cannot be cascade-deleted). Reset the DB to regenerate.';
    return;
  end if;

  -- clear previous demo rows (children first) — only reached on a fresh DB (no demo students yet)
  delete from ccat.readiness_snapshots where student_id in (select id from ccat.students where username_normalized::text like 'stu\_%');
  delete from ccat.student_progress_snapshots where student_id in (select id from ccat.students where username_normalized::text like 'stu\_%');
  delete from ccat.student_devices where student_id in (select id from ccat.students where username_normalized::text like 'stu\_%');
  delete from ccat.student_guardians where student_id in (select id from ccat.students where username_normalized::text like 'stu\_%');
  delete from ccat.students where username_normalized::text like 'stu\_%';
  delete from ccat.guardian_contacts where email::text like 'demo.parent.%@example.test';

  select id into lpv from ccat.learning_plan_versions limit 1;

  for i in 1..60 loop
    gnum := 3 + (i % 4);
    select id into gid from ccat.grades where grade_number = gnum;
    fn := fnames[1 + (i % array_length(fnames,1))];
    ln := lnames[1 + ((i*7) % array_length(lnames,1))];
    uname := 'stu_' || lpad(i::text, 3, '0');
    st := case when i % 23 = 0 then 'banned'::ccat.student_status
               when i % 19 = 0 then 'pending_deletion'::ccat.student_status
               when i % 14 = 0 then 'suspended'::ccat.student_status
               else 'active'::ccat.student_status end;
    xp := 200 + ((i * 613) % 15000);
    coins := 5 + ((i * 37) % 380);

    insert into ccat.students(id, grade_id, username_normalized, display_name, birth_month, birth_year, timezone, status, cached_xp_total, cached_coin_balance, version, created_at)
    values (gen_random_uuid(), gid, uname, fn || ' ' || ln, 1 + (i % 12), extract(year from now())::int - (gnum + 5), 'America/Toronto', st, xp, coins, 1, now() - (i || ' hours')::interval)
    returning id into sid;

    -- guardian
    insert into ccat.guardian_contacts(id, email, phone, email_verified_at, created_at, updated_at)
    values (gen_random_uuid(), ('demo.parent.' || i || '@example.test')::citext, '+1 416 555 ' || lpad(((i*29) % 10000)::text,4,'0'), now(), now(), now())
    returning id into ggid;
    insert into ccat.student_guardians(student_id, guardian_id, relationship, is_primary, created_at)
    values (sid, ggid, 'parent', true, now());

    -- readiness (some insufficient)
    if i % 11 = 0 then
      insert into ccat.readiness_snapshots(id, student_id, readiness_pct, insufficient_data, window_questions, band, computed_at)
      values (gen_random_uuid(), sid, null, true, 3, null, now());
    else
      pct := 25 + ((i * 517) % 70);
      bnd := case when pct >= 70 then 'ready' when pct < 45 then 'needs_work' else 'building' end;
      insert into ccat.readiness_snapshots(id, student_id, readiness_pct, insufficient_data, window_questions, band, computed_at)
      values (gen_random_uuid(), sid, pct, false, 40, bnd, now() - (i || ' minutes')::interval);
    end if;

    -- progress
    if lpv is not null then
      insert into ccat.student_progress_snapshots(id, student_id, learning_plan_version_id, completed_count, eligible_count, progress_pct, computed_at)
      values (gen_random_uuid(), sid, lpv, (i % 40), 40, round((i % 40) * 100.0 / 40, 1), now());
    end if;

    -- devices: mostly 1 active; some revoked-only; some 2; a few none
    ndev := case when i % 25 = 0 then 0 when i % 8 = 0 then 1 else 1 + (i % 2) end;
    nact := case when i % 8 = 0 then 0 else ndev end; -- i%8 => device revoked (has device, none active)
    if ndev > 0 then
      insert into ccat.student_devices(id, student_id, device_hash, platform, status, enrolled_at, last_seen_at, created_at, updated_at, revoked_at, revoked_reason)
      values (gen_random_uuid(), sid, 'demo-hash-' || i || '-a', case when i%2=0 then 'android' else 'ios' end,
              case when nact>0 then 'active' else 'revoked' end::ccat.device_status,
              now() - (i || ' days')::interval, now() - ((i%5) || ' hours')::interval, now(), now(),
              case when nact>0 then null else now() end, case when nact>0 then null else 'admin_device_revoke' end);
      if ndev > 1 then
        -- second device is a replaced/revoked one (single-active-device policy); shows as "2 devices, 1 active"
        insert into ccat.student_devices(id, student_id, device_hash, platform, status, enrolled_at, last_seen_at, created_at, updated_at, revoked_at, revoked_reason)
        values (gen_random_uuid(), sid, 'demo-hash-' || i || '-b', 'android', 'revoked'::ccat.device_status, now() - ((i+30) || ' days')::interval, now() - (i || ' days')::interval, now(), now(), now() - (i || ' days')::interval, 'device_replacement');
      end if;
    end if;
  end loop;
end $$;
select count(*) as demo_students from ccat.students where username_normalized::text like 'stu\_%';

-- Demo streaks for the directory (TASK-003): varied current/longest, some active, some stale.
insert into ccat.student_streaks(student_id, current_streak, longest_streak, last_active_day)
select s.id,
       (row_number() over (order by s.username_normalized) % 12) as cur,
       greatest((row_number() over (order by s.username_normalized) % 12), 5 + (row_number() over (order by s.username_normalized) % 20)) as longest,
       case when (row_number() over (order by s.username_normalized) % 5) = 0
            then (now() at time zone s.timezone)::date - 3   -- stale (broken)
            when (row_number() over (order by s.username_normalized) % 3) = 0
            then (now() at time zone s.timezone)::date - 1   -- practised yesterday (alive)
            else (now() at time zone s.timezone)::date end   -- practised today
  from ccat.students s
 where s.username_normalized::text like 'stu\_%'
on conflict (student_id) do update set current_streak=excluded.current_streak,
  longest_streak=excluded.longest_streak, last_active_day=excluded.last_active_day;

-- Matching ledger entries so the demo economy is genuinely in balance (cache == ledger).
insert into ccat.xp_transactions(student_id, delta, source_kind, source_id)
select id, cached_xp_total, 'seed_demo', id::text from ccat.students
 where username_normalized::text like 'stu\_%' and cached_xp_total <> 0
 on conflict do nothing;
insert into ccat.coin_transactions(student_id, delta, source_kind, source_id)
select id, cached_coin_balance, 'seed_demo', id::text from ccat.students
 where username_normalized::text like 'stu\_%' and cached_coin_balance <> 0
 on conflict do nothing;
