-- 0029_remove_subcategories.sql
-- Remove two subcategories from the taxonomy (CHANGE 2):
--   * 'Analogies'    (Verbal)      key='analogies'
--   * 'Odd One Out'  (Non-verbal)  key='odd_one_out'
--
-- REVISED 2026-08-25 — history-preserving. The original version DELETEd the content under Analogies.
-- That fails on any database where a student session references an Analogies set version, because
-- ccat.sessions.set_version_id -> ccat.question_set_versions(id) is an intentional RESTRICT FK
-- (sessions/session_answers keep their content as immutable history; §8.1 says published versions are
-- RETIRED, never deleted). The old migration therefore aborted permanently and blocked startup.
--
-- Correct lifecycle: REMOVE these subcategories from the student catalog and admin taxonomy by
-- RETIRING their content (published/any -> 'retired', which the immutability triggers allow) and
-- DEACTIVATING the subcategory rows. Nothing referenced by a session is deleted, so existing session
-- history is preserved. Fully idempotent (guards on state/active) and safe on a fresh DB, on the local
-- DB, and on production Supabase alike.
do $$
declare v_analogies uuid; v_odd uuid;
begin
  select id into v_odd       from ccat.subcategories where key = 'odd_one_out';
  select id into v_analogies from ccat.subcategories where key = 'analogies';

  -- Deactivate both subcategories so they disappear from the taxonomy pickers / active listings.
  -- (The row is retained so question_sets/logical_questions FKs — and thus session history — stay valid.)
  update ccat.subcategories
     set active = false
   where key in ('odd_one_out', 'analogies') and active;

  if v_analogies is not null then
    -- Retire (do NOT delete) every non-retired SET VERSION under Analogies. The student catalog serves
    -- only state='published', so retiring removes these from students while preserving the sessions FK.
    -- published->retired is allowed by tg_set_version_immutable; drafts are unrestricted.
    update ccat.question_set_versions sv
       set state = 'retired', retired_at = coalesce(sv.retired_at, now())
      from ccat.question_sets qs
     where sv.question_set_id = qs.id
       and qs.subcategory_id = v_analogies
       and sv.state <> 'retired';

    -- Retire (do NOT delete) the Analogies QUESTION VERSIONS — session_answers.question_version_id
    -- references them (also a RESTRICT FK). published->retired allowed; drafts unrestricted.
    update ccat.question_versions qv
       set state = 'retired', retired_at = coalesce(qv.retired_at, now())
      from ccat.logical_questions lq
     where qv.logical_question_id = lq.id
       and lq.subcategory_id = v_analogies
       and qv.state <> 'retired';
  end if;
end $$;
