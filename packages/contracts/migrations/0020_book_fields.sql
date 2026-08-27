-- BOOKS-1 (decision 9-b): a real priced, subject-tagged, grade-targeted catalog. grade_ids already
-- exists on books; add price and subject. Price is stored in cents to avoid float rounding.
alter table ccat.books add column if not exists price_cents int check (price_cents is null or price_cents >= 0);
alter table ccat.books add column if not exists subject text;
