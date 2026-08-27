-- 0022: Preview ("cheat") accounts — one synthetic student per grade the team can log in as on the
-- public site to experience the product as a customer of that grade. Safety = harmlessness:
-- is_preview accounts are synthetic (no PII, no guardian/consent), reach ONLY their own session +
-- PUBLISHED grade content (the normal student scoping already enforces this), are EXCLUDED from all
-- real-customer analytics, and trigger NO outbound side effects. See seed-preview + gateway guards.
alter table ccat.students
  add column if not exists is_preview boolean not null default false;

-- Fast "list preview accounts" + cheap analytics-exclusion filter.
create index if not exists students_preview_idx on ccat.students(is_preview) where is_preview;

comment on column ccat.students.is_preview is
  'Synthetic preview/demo ("cheat") account: excluded from real analytics & student counts; multi-device login allowed; no outbound OTP/email/push. Never a real customer.';
