-- ============================================================================
-- 0058_logical_questions_nullable_subcategory.sql
-- Allow questions with NO subcategory, so sets under a subcategory-less battery
-- (NGAT Quantitative / Non-verbal) can hold questions. Metadata-only (fast).
-- CCAT/Verbal questions keep their subcategory via the app; nothing is backfilled.
-- ============================================================================
set search_path = ccat, public;
alter table ccat.logical_questions alter column subcategory_id drop not null;
