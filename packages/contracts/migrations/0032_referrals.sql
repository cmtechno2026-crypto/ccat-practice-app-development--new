-- Gate 2B: referrals. Each learner gets a stable, opaque invite code they can share; when a new
-- learner registers with that code, we record a redemption and grant the referrer coins along a
-- milestone ladder (exactly-once via the coin ledger's unique (student_id, source_kind, source_id)).
-- Child-safety notes: the code carries NO personal data; sharing is learner-initiated; the reward is
-- in-app coins only (no external contact, no payment, no exposure of the inviter's or invitee's PII).

create table if not exists ccat.referral_codes (
  student_id uuid primary key references ccat.students(id) on delete cascade,
  code       text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists ccat.referral_redemptions (
  id                  uuid primary key default gen_random_uuid(),
  referrer_student_id uuid not null references ccat.students(id) on delete cascade,
  -- one row per invited learner: a learner can be referred at most once (at their registration).
  invited_student_id  uuid not null unique references ccat.students(id) on delete cascade,
  code                text not null,
  created_at          timestamptz not null default now(),
  constraint referral_no_self check (referrer_student_id <> invited_student_id)
);
create index if not exists referral_redemptions_referrer_idx on ccat.referral_redemptions(referrer_student_id);

-- RLS parity with the rest of ccat.* (gateway-only access; clients never read these directly).
do $$
begin
  execute 'alter table ccat.referral_codes enable row level security';
  execute 'alter table ccat.referral_codes force row level security';
  execute 'alter table ccat.referral_redemptions enable row level security';
  execute 'alter table ccat.referral_redemptions force row level security';
exception when others then null;
end $$;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='ccat' and tablename='referral_codes' and policyname='gateway_all') then
    execute 'create policy gateway_all on ccat.referral_codes for all using (true) with check (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='ccat' and tablename='referral_redemptions' and policyname='gateway_all') then
    execute 'create policy gateway_all on ccat.referral_redemptions for all using (true) with check (true)';
  end if;
end $$;
