-- 0033_content_integrity.sql
-- Keep the student catalog aligned with immutable, fully published set membership and make CSV
-- imports replay-safe at the PostgreSQL boundary. Existing malformed published sets are retired,
-- never deleted, so session/result history remains valid.

set search_path = ccat, public;

create unique index if not exists question_versions_import_fingerprint_unique
  on ccat.question_versions ((provenance->>'import_fingerprint'))
  where provenance->>'import_fingerprint' is not null;

update ccat.question_set_versions sv
   set state = 'retired', retired_at = coalesce(retired_at, now())
 where sv.state = 'published'
   and (
     sv.question_count <= 0
     or sv.question_count <> (
       select count(*)::int
         from ccat.set_version_questions svq
         join ccat.question_versions qv on qv.id = svq.question_version_id
        where svq.set_version_id = sv.id
          and svq.active = true
          and qv.state = 'published'
     )
   );
