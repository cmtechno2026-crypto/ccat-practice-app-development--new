-- 0028_order_default_fixed.sql
-- The per-set "order mode" toggle was removed from the question editor (CHANGE 3). Owner decision
-- (2026-08-25): the documented server default is FIXED (serve questions in authoring order; options are
-- still shuffled per-question by sessions.ts). Set the column default to true and align existing sets to
-- fixed so serving is consistent now that admins can no longer toggle it. preserve_order is NOT covered
-- by the published-immutability trigger, so this is safe on published sets. On a fresh migrate the table
-- is empty, so the UPDATE is a no-op and only the new default matters.
alter table ccat.question_set_versions alter column preserve_order set default true;
update ccat.question_set_versions set preserve_order = true where preserve_order = false;
