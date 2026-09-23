# Parent Booking Links + Booking Requests (Teacher Hub)

Admin-side implementation for the TeachTime parent-booking flow. **TeachTime owns the `ta_booking_*`
schema** (shipped in cm-whiteboard migration `parent_booking_links`, 2026-09-23). This repo (CCAT
gateway + admin) only reads/writes those tables through the existing `TEACHER_DATABASE_URL` pool; it
never creates or alters `ta_*`.

## Live schema (source of truth — do not alter from this repo)

- `ta_booking_links(id, token unique, label, teacher_ids uuid[], grade int 1-12, subject, expires_at,
  is_active bool, created_by, created_at)` — revoked = `is_active=false`; expired = `expires_at < now()`.
- `ta_booking_requests(id, link_id, num_classes 1-200, parent_name, parent_email, parent_phone,
  student_name, notes, parent_timezone, status, decided_by, decided_at, created_at)`
  status ∈ `pending | approved | partially_approved | rejected | cancelled`. **No reject-reason column** —
  the admin appends the reason to `notes`.
- `ta_booking_request_slots(request_id, slot_id, outcome)` PK `(request_id, slot_id)`;
  outcome ∈ `pending | approved | taken | rejected | cancelled`.
- `ta_slots.booked_request_id uuid → ta_booking_requests(id)` links a booked slot to its request.
- **Slot vocabulary is `available | booked`** (TeachTime migrated `open → available` in the same
  migration, and split grade into `grade_min`/`grade_max`). The gateway + admin were updated to match.

## Gateway endpoints (`apps/gateway/src/routes/admin-teacher.ts`)

Read gated by `teacher.directory`, writes by `teacher.slots.manage`; `requireSite('teacher')`. super_admin bypasses.

- `GET  /v1/admin/teacher/booking-links/preview?teacher_ids=a,b&grade=5&subject=Math` → `{ available, teachers }`
- `POST /v1/admin/teacher/booking-links` `{ teacher_ids[], grade, subject, label?, expires_in_days?|never_expires? }` (default 14-day expiry) → link + `url`
- `GET  /v1/admin/teacher/booking-links?status=all|active|expired|revoked`
- `PATCH /v1/admin/teacher/booking-links/:id` `{ action:'revoke'|'activate', expires_in_days?|never_expires? }`
- `GET  /v1/admin/teacher/booking-requests/pending-count` → `{ pending }` (rail badge)
- `GET  /v1/admin/teacher/booking-requests?status=pending|all&link_id=`
- `POST /v1/admin/teacher/booking-requests/:id/approve` `{ slot_ids? }` — books chosen (or all) slots in ONE
  transaction. Race-safe: a slot taken meanwhile → outcome `taken`. Slots left out → `rejected`.
  Request status becomes `approved` (all booked), `partially_approved` (some), or `rejected` (none).
- `POST /v1/admin/teacher/booking-requests/:id/reject` `{ reason? }` — slots stay available; reason appended to `notes`.

Approve/reject send the parent a decision email **after commit** via the gateway's shared email helper (`lib/email.ts`), which never throws and no-ops until `EMAIL_*` is configured, so a send failure never rolls back.

## Admin UI (`apps/admin/src`)

- `pages/BookingLinks.tsx` — create (teacher multi-select + grade + subject + live preview count), list, copy URL, revoke/activate. Route `/teacher/booking-links`.
- `pages/BookingRequests.tsx` — inbox; per-slot approve selection, approve/reject. Route `/teacher/requests`.
- `components/Layout.tsx` — Teacher Hub rail gains **Booking Links** + **Requests** (with a live pending badge).

## Environment (gateway)

- `TEACHTIME_PUBLIC_URL` — public TeachTime origin; renders links as `${base}/b/<token>`. Optional.
- `EMAIL_*` (existing) — the shared gateway email config. Parent decision emails send through it; until it
  is set, they no-op safely (logged and skipped). No n8n / no separate webhook.

### Parent decision email
Sent to `parent_email` after a decision. Branded HTML (`Concept Mastery`), three variants:
`approved` (confirmed sessions table), `partially_approved` (confirmed table + note on unavailable times),
`rejected` (polite decline + optional reason + note that the times remain open). Built in
`sendDecisionEmail()` in `admin-teacher.ts`; reply-to reaches `info@conceptmastery.com`.

## Deploy order

1. **cm-whiteboard schema** — already live (TeachTime). No action.
2. Set gateway env on Render: `TEACHTIME_PUBLIC_URL` (optional). Parent decision emails use the existing `EMAIL_*` config — already set if the gateway already sends email. `TEACHER_DATABASE_URL` already set.
3. **Deploy gateway (Render).** NOTE: this also ships the `open → available` fix — until it deploys,
   admin book/unbook is broken against the migrated DB, so this is a bug-fix deploy, not just a feature.
4. **Deploy admin (Vercel).** Ships the new pages + rail + the same enum fix.
5. **TeachTime (separate app):** build the parent page at `/b/<token>` — resolve the link, show matching
   available slots (`teacher_id = ANY(teacher_ids) AND subject = link.subject AND grade BETWEEN grade_min AND grade_max AND status='available'`),
   and on submit insert one `ta_booking_requests` + N `ta_booking_request_slots(outcome='pending')`.
   TeachTime may fire its own submit-time webhook/notification (separate from the admin's decision email above).

Verified: the approve/reject SQL was run end-to-end against the live cm-whiteboard schema (seed → approve
slot1 / reject slot2 → `partially_approved`, slot booked with `booked_request_id`, other slot left available)
and all test rows deleted.
