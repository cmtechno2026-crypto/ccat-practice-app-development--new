-- BOOKS-2: each buy link carries a format/kind (Paperback, eBook, Audiobook…) so the store can label
-- what a retailer link actually sells (mockup: {platform:'Amazon', kind:'Paperback'}).
alter table ccat.book_retailer_links add column if not exists kind text;
