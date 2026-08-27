-- ============================================================================
-- CCAT Migration 0007 — Gateway application infrastructure
-- Idempotency store backing the idempotency/retry contract (§13, §32.1).
-- Application-owned; distinct from the domain uniqueness constraints that provide
-- the correctness backstop (session_submissions, ledger source refs).
-- ============================================================================
set search_path = ccat, public;

create table if not exists ccat.idempotency_keys (
  operation      text not null,           -- e.g. 'POST /sessions/{id}/submit'
  idem_key       text not null,           -- Idempotency-Key header value
  request_hash   text not null,           -- hash of the request body
  status_code    int,                     -- stored response for replay
  response_body  jsonb,
  created_at     timestamptz not null default now(),
  primary key (operation, idem_key)
);
create index if not exists idempotency_keys_created_idx on ccat.idempotency_keys(created_at);

-- Gateway role needs DML here too (covered by the schema-wide grant in 0006 for
-- objects created afterwards via default privileges).
grant select, insert, update, delete on ccat.idempotency_keys to ccat_gateway;
-- RLS parity with the rest of the schema.
alter table ccat.idempotency_keys enable row level security;
alter table ccat.idempotency_keys force row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='ccat' and tablename='idempotency_keys' and policyname='gateway_all') then
    create policy gateway_all on ccat.idempotency_keys for all to ccat_gateway using (true) with check (true);
  end if;
end $$;
