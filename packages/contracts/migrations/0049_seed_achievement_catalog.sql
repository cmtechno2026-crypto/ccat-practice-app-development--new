-- 0049_seed_achievement_catalog.sql
-- Seed / re-sync the achievement catalog (idempotent). Reward amounts live ONLY here in
-- ccat.achievement_rewards — the award engine (lib/achievements.ts) grants from these rows and both
-- web ccat and web admin read them, so XP/coins can never diverge between display and grant.
--
-- Triggers used (evaluated in lib/achievements.ts): first_completion, perfect_set, xp_total{threshold},
-- questions_answered{threshold}, streak_days{threshold}, batteries_covered{threshold}. New triggers
-- ship in the same gateway change as this migration; seeding them before deploy is harmless (an unknown
-- trigger simply never fires until the engine that understands it is live).
do $$
declare
  r record;
  aid uuid;
  vid uuid;
begin
  for r in
    select * from (values
      ('first_set',        'First Steps',      '{"type":"first_completion"}'::jsonb,                    20, 10),
      ('perfectionist',    'Sharp Shooter',    '{"type":"perfect_set"}'::jsonb,                         50, 25),
      ('xp_100',           'XP Rookie',        '{"type":"xp_total","threshold":100}'::jsonb,            50, 20),
      ('battery_explorer', 'Battery Explorer', '{"type":"batteries_covered","threshold":3}'::jsonb,     80, 40),
      ('streak_5',         'Streak Star',      '{"type":"streak_days","threshold":5}'::jsonb,          120, 60),
      ('questions_100',    'Century Club',     '{"type":"questions_answered","threshold":100}'::jsonb, 100, 50),
      ('xp_500',           'Rising Star',      '{"type":"xp_total","threshold":500}'::jsonb,             0, 40)
    ) as t(key, name, criteria, xp, coins)
  loop
    insert into ccat.achievements(key, name) values (r.key, r.name)
      on conflict (key) do update set name = excluded.name
      returning id into aid;

    select av.id into vid from ccat.achievement_versions av
      where av.achievement_id = aid order by av.version_number desc limit 1;
    if vid is null then
      insert into ccat.achievement_versions(achievement_id, version_number, criteria, active)
        values (aid, 1, r.criteria, true) returning id into vid;
    else
      update ccat.achievement_versions set criteria = r.criteria, active = true where id = vid;
    end if;

    delete from ccat.achievement_rewards where achievement_version_id = vid;
    if r.xp > 0 then
      insert into ccat.achievement_rewards(achievement_version_id, reward_kind, xp_amount) values (vid, 'xp', r.xp);
    end if;
    if r.coins > 0 then
      insert into ccat.achievement_rewards(achievement_version_id, reward_kind, coin_amount) values (vid, 'coins', r.coins);
    end if;
  end loop;
end $$;
