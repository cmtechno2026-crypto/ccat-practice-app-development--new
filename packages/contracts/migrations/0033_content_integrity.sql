-- 0033_content_integrity.sql
-- Keep the student catalog aligned with immutable, fully published set membership and make CSV
-- imports replay-safe at the PostgreSQL boundary. Malformed published sets are filtered by the
-- Gateway catalog/session guards; changing their stored lifecycle state is a separate, explicitly
-- approved operational cleanup because it can affect a large number of existing rows.

set search_path = ccat, public;

create unique index if not exists question_versions_import_fingerprint_unique
  on ccat.question_versions ((provenance->>'import_fingerprint'))
  where provenance->>'import_fingerprint' is not null;
