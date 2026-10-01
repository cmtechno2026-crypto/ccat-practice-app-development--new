-- 0056_content_assets_checksum_index.sql
-- Global image de-duplication support. The asset upload paths now reuse an existing asset when an identical
-- image (same sha256) was already stored, instead of uploading + inserting a duplicate. This index makes the
-- "does this checksum already exist?" lookup fast. Scoped by storage_key prefix at query time (content/ vs
-- avatars/) so content figures and avatar art never dedupe across each other.
create index if not exists content_assets_checksum_idx on ccat.content_assets (checksum_sha256);
