-- STUDENTS-1: break-glass device enrollment (§5.2). Enrolling a new device out-of-band bypasses the
-- guardian OTP channel, so it is the one path that needs a Super-Admin signature. A non-super admin
-- who holds device.break_glass can only *request* co-sign; a Super-Admin either signs directly or
-- approves a pending request. This table is the co-sign request queue.
create table if not exists ccat.student_break_glass_requests (
  id                uuid primary key default gen_random_uuid(),
  student_id        uuid not null references ccat.students(id) on delete cascade,
  requested_by      uuid not null references ccat.admin_profiles(id),
  platform          text,
  device_hash       text not null,
  verification_note text not null,      -- how the guardian's identity was verified out of band
  reference         text,               -- ticket / case reference
  status            text not null default 'pending' check (status in ('pending','approved','denied','cancelled')),
  decided_by        uuid references ccat.admin_profiles(id),
  decided_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists student_break_glass_pending_idx
  on ccat.student_break_glass_requests(student_id) where status = 'pending';
