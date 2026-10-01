-- ============================================================================
-- 0057_ngat_quant_nonverbal_no_subcat.sql — NGAT Quantitative & Non-verbal take
-- sets DIRECTLY under the battery (no subcategory). Deactivate their subcategories
-- so the taxonomy (which reads only active subcategories) returns none for them.
-- Verbal keeps its subcategories. CCAT untouched. Idempotent. (UPDATE, not DELETE:
-- a DELETE triggers an expensive unindexed FK validation on this DB.)
-- ============================================================================
set search_path = ccat, public;

update ccat.subcategories s
set active = false
from ccat.categories c
where s.category_id = c.id
  and c.program = 'ngat'
  and c.key in ('quantitative', 'non_verbal');
