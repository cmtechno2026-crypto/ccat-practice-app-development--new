-- BOOKS-2: an optional original ("was") price so the Book Store can show a real discount / "% OFF"
-- badge. Nullable — when unset the client shows the plain price with no badge (never a faked
-- discount). Stored in cents like price_cents.
alter table ccat.books add column if not exists original_price_cents int
  check (original_price_cents is null or original_price_cents >= 0);
