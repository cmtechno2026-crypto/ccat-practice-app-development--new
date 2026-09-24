-- 0050_repeatable_achievements.sql
-- Repeatable (per-session event) achievements. A repeatable achievement can be earned again each session
-- whose result qualifies (e.g. every perfect set), instead of once per student. Cumulative-threshold
-- triggers (xp_total, questions_answered, streak_days, batteries_covered) are never marked repeatable —
-- once the threshold is crossed it stays crossed, so they are inherently one-time.
alter table ccat.achievement_versions add column if not exists repeatable boolean not null default false;

-- Uniqueness moves from (student, version) to (student, version, session) so a repeatable achievement gets
-- one grant per session. Non-repeatable achievements are still granted once — the award engine excludes an
-- already-earned non-repeatable version — so this only loosens the constraint for the repeatable case.
alter table ccat.student_achievements drop constraint if exists student_achievement_unique;
alter table ccat.student_achievements
  add constraint student_achievement_unique unique (student_id, achievement_version_id, granted_from_session_id);

-- Sharp Shooter (perfect set) becomes repeatable — reward a perfect score every time.
update ccat.achievement_versions av set repeatable = true
  from ccat.achievements a
 where a.id = av.achievement_id and a.key = 'perfectionist';
