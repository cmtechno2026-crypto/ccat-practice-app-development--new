import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { z } from 'zod';
import { makeAuthenticateAdmin, requirePermission, requireSite } from '../plugins/adminAuth.js';
import { AppError, Errors } from '../errors.js';
import { withTransaction } from '../db.js';
import { sendEmail } from '../lib/email.js';
import { randomBytes } from 'node:crypto';

// Expand a weekly recurring slot into dated occurrences (no rows materialized).
// Returns YYYY-MM-DD for each weekly occurrence of `dayOfWeek` from today (or
// effectiveFrom, whichever is later) up to `horizonWeeks`, stopping at effectiveTo.
const DOW_INDEX: Record<string, number> = { Sunday:0, Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6 };
function occurrenceDates(dayOfWeek: string, effectiveFrom: string | null, effectiveTo: string | null, horizonWeeks = 16): string[] {
  const target = DOW_INDEX[dayOfWeek];
  if (target == null) return [];
  const today = new Date(); today.setHours(0,0,0,0);
  let start = new Date(today);
  if (effectiveFrom) { const f = new Date(effectiveFrom + 'T00:00:00'); if (f > start) start = f; }
  const first = new Date(start);
  first.setDate(first.getDate() + ((target - first.getDay() + 7) % 7));
  const horizon = new Date(today); horizon.setDate(horizon.getDate() + horizonWeeks * 7);
  const hardEnd = effectiveTo ? new Date(effectiveTo + 'T00:00:00') : null;
  const out: string[] = [];
  for (const cur = new Date(first); cur <= horizon; cur.setDate(cur.getDate() + 7)) {
    if (hardEnd && cur > hardEnd) break;
    out.push(cur.toISOString().slice(0, 10));
  }
  return out;
}

// ---- Calendar invite (.ics) ----------------------------------------------
// Build a base64 VCALENDAR for a set of booked sessions. Recurring sessions get a weekly RRULE
// anchored to the next occurrence of their weekday; demo/make-up are single events. TZID uses the
// slot's IANA zone (no VTIMEZONE block — Google/Apple/Outlook resolve named IANA zones).
function icsEscape(s: string): string { return String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n'); }
function icsDateTime(date: string, time: string): string { return date.replace(/-/g, '') + 'T' + String(time).replace(/:/g, '').slice(0, 6); }
type IcsEvent = { uid: string; title: string; desc?: string; date: string; start: string; end: string; tzid: string; recurring: boolean };
function buildIcsBase64(events: IcsEvent[]): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Concept Mastery//TeacherHub//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${e.tzid}:${icsDateTime(e.date, e.start)}`,
      `DTEND;TZID=${e.tzid}:${icsDateTime(e.date, e.end)}`);
    if (e.recurring) lines.push('RRULE:FREQ=WEEKLY');
    lines.push(`SUMMARY:${icsEscape(e.title)}`);
    if (e.desc) lines.push(`DESCRIPTION:${icsEscape(e.desc)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64');
}

// Teacher Hub (TeacherHub) admin surface. This site's data lives in a SEPARATE Supabase project
// ("cm-whiteboard", public.ta_* tables), reached through a dedicated read pool (`teacherDb`, from
// TEACHER_DATABASE_URL). Every route is gated by requirePermission('teacher.*') AND
// requireSite('teacher'); super_admin bypasses both. When the pool is not configured the routes
// answer 503 rather than crash, so the gateway is safe to deploy before the env var is set.
export function registerAdminTeacherRoutes(app: FastifyInstance, db: DB, cfg: Config, teacherDb: DB | null) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  function tdb(): DB {
    if (!teacherDb) throw new AppError(503, 'SITE_NOT_CONFIGURED', 'Teacher Hub database is not configured (set TEACHER_DATABASE_URL).');
    return teacherDb;
  }

  // Dashboard KPIs for the Teacher Hub site.
  app.get('/v1/admin/teacher/summary', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const { rows } = await tdb().query(
      `select
         (select count(*)::int from public.ta_teachers)                          as teachers,
         (select count(*)::int from public.ta_slots)                             as published_slots,
         (select count(*)::int from public.ta_slots where status = 'available')  as open_slots,
         (select count(*)::int from public.ta_slots where status = 'booked')     as booked_slots,
         (select count(*)::int from public.ta_booking_requests where status = 'pending' and teacher_status <> 'accepted')  as pending_requests,
         (select count(*)::int from public.ta_booking_requests where teacher_status = 'accepted' and status = 'pending') as ready_to_book,
         (select count(*)::int from public.ta_leave_requests where status = 'pending')                                  as pending_leave,
         (select count(*)::int from public.ta_booking_links where is_active = true and (expires_at is null or expires_at > now()))      as active_links,
         (select count(*)::int from public.ta_booking_links where is_active = true and expires_at is not null and expires_at <= now()) as expired_links,
         (select count(*)::int from public.ta_booking_requests where created_at >= date_trunc('week', now()))           as requests_this_week,
         (select count(*)::int from public.ta_booking_requests where status in ('approved','partially_approved') and decided_at >= date_trunc('week', now())) as booked_this_week,
         (select count(*)::int from public.ta_teachers where created_at >= date_trunc('week', now()))                   as new_teachers_week`);
    return rows[0]!;
  });

  // Teacher directory. Never selects the password hash. Slot counts via lateral-free subselects.
  app.get('/v1/admin/teacher/teachers', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const q = req.query as { search?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 200);
    const search = (q.search ?? '').trim();
    const params: any[] = [];
    let where = '';
    if (search) { params.push('%' + search.toLowerCase() + '%'); where = 'where lower(t.name) like $1 or lower(t.email) like $1'; }
    params.push(limit);
    const { rows } = await tdb().query(
      `select t.id, t.name, t.email, t.subjects, t.inactive_subjects, t.profile_approved, t.created_at, t.banned_at,
              (select count(*)::int from public.ta_slots s where s.teacher_id = t.id)                          as slots,
              (select count(*)::int from public.ta_slots s where s.teacher_id = t.id and s.status = 'available') as open_slots
         from public.ta_teachers t
         ${where}
         order by t.name
         limit $${params.length}`,
      params);
    return { teachers: rows };
  });

  // Slots for one teacher (teacher_id) or all teachers. Ordered by teacher, then weekday, then start
  // time so the admin UI can group them under each teacher.
  app.get('/v1/admin/teacher/slots', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const q = req.query as { teacher_id?: string };
    const teacherId = (q.teacher_id ?? '').trim();
    const params: any[] = [];
    let where = '';
    if (teacherId) { params.push(teacherId); where = 'where s.teacher_id = $1'; }
    const { rows } = await tdb().query(
      `select s.id, s.teacher_id, s.teacher_name, s.subject, s.grade, s.grade_min, s.grade_max, s.day_of_week,
              s.start_time, s.end_time, s.status, s.timezone, s.notes,
              s.booked_student, s.booked_note, s.booked_by, s.booked_at,
              coalesce(brs.session_type, s.session_type, br.session_type) as session_type
         from public.ta_slots s
         left join public.ta_booking_requests br on br.id = s.booked_request_id
         left join public.ta_booking_request_slots brs on brs.request_id = s.booked_request_id and brs.slot_id = s.id
         ${where}
         order by s.teacher_name,
                  case s.day_of_week
                    when 'Monday' then 1 when 'Tuesday' then 2 when 'Wednesday' then 3
                    when 'Thursday' then 4 when 'Friday' then 5 when 'Saturday' then 6
                    when 'Sunday' then 7 else 8 end,
                  s.start_time`,
      params);
    return { slots: rows };
  });

  // Book / unbook a slot from the admin. Writes status to the Teacher Hub DB (public.ta_slots), so the
  // change is immediately visible in the teacher app (same table). Gated by teacher.slots.manage +
  // requireSite('teacher'). The change is recorded in the CCAT audit log (best-effort).
  // Booking a slot requires a student name; unbooking clears the detail. `booked_by` is a
  // human-readable admin name so the teacher's own view can show who booked it.
  const slotStatusSchema = z.object({
    status: z.enum(['available', 'booked', 'unavailable']),
    student: z.string().trim().max(120).optional(),
    note: z.string().trim().max(500).optional(),
    session_type: z.enum(['demo', 'recurring', 'makeup']).optional(),
  }).refine((v) => v.status !== 'booked' || !!(v.student && v.student.length > 0), { message: 'Student name is required to book', path: ['student'] });

  app.patch('/v1/admin/teacher/slots/:id', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const id = (req.params as { id: string }).id;
    const b = slotStatusSchema.parse(req.body ?? {});
    const booking = b.status === 'booked';
    let bookedBy: string | null = null;
    if (booking) {
      const who = await db.query('select display_name, email from ccat.admin_profiles where id=$1', [req.admin!.adminId]);
      bookedBy = (who.rows[0]?.display_name as string) || (who.rows[0]?.email as string) || 'Admin';
    }
    const { rows } = await tdb().query(
      `update public.ta_slots
          set status = $2,
              booked_student = $3,
              booked_note    = $4,
              booked_by      = $5,
              session_type   = case when $2 = 'booked' then $6 else null end,
              booked_at      = case when $2 = 'booked' then now() else null end,
              booked_request_id = case when $2 = 'booked' then booked_request_id else null end,
              updated_at     = now()
        where id = $1
        returning id, teacher_id, teacher_name, subject, grade, day_of_week, start_time, end_time,
                  status, timezone, session_type, booked_student, booked_note, booked_by, booked_at`,
      // booked_student and booked_by are NOT NULL (default ''); clear them to '' on unbook, never null.
      [id, b.status, booking ? (b.student ?? '') : '', booking ? (b.note ?? null) : null, booking ? bookedBy : '', booking ? (b.session_type ?? 'recurring') : null]);
    if (rows.length === 0) throw Errors.notFound('Slot not found');
    // Governance: record in the CCAT audit log. Best-effort — a logging failure must not fail the booking.
    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1, 'admin', 'teacher.slot.status', 'ta_slot', $2, $3)`,
        [req.admin!.adminId, id, JSON.stringify({ status: b.status, student: booking ? b.student : null, teacher: rows[0]!.teacher_name })]);
    } catch { /* audit is best-effort */ }
    return rows[0];
  });


  // Create a slot on an empty grid cell (admin). Requires subject + grade range; optionally books it
  // with a student + session type. Timezone inherits the teacher's existing slots (fallback IST).
  const createSlotSchema = z.object({
    teacher_id: z.string().uuid(),
    day_of_week: z.enum(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']),
    start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    subject: z.string().trim().min(1).max(80),
    grade_min: z.number().int().min(1).max(12),
    grade_max: z.number().int().min(1).max(12),
    status: z.enum(['available','booked']).default('available'),
    student: z.string().trim().max(120).optional(),
    note: z.string().trim().max(500).optional(),
    session_type: z.enum(['demo','recurring','makeup']).optional(),
  }).refine((v) => v.grade_min <= v.grade_max, { message: 'grade_min must be <= grade_max', path: ['grade_max'] })
    .refine((v) => v.status !== 'booked' || !!(v.student && v.student.length > 0), { message: 'Student name is required to book', path: ['student'] });
  app.post('/v1/admin/teacher/slots', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const b = createSlotSchema.parse(req.body ?? {});
    const t = await tdb().query('select name from public.ta_teachers where id = $1', [b.teacher_id]);
    if (t.rows.length === 0) throw Errors.notFound('Teacher not found');
    const tz = await tdb().query('select timezone, iana_timezone from public.ta_slots where teacher_id = $1 order by created_at desc limit 1', [b.teacher_id]);
    const timezone = (tz.rows[0]?.timezone as string) || 'IST';
    const iana = (tz.rows[0]?.iana_timezone as string) || 'Asia/Kolkata';
    const booking = b.status === 'booked';
    let bookedBy = '';
    if (booking) {
      const who = await db.query('select display_name, email from ccat.admin_profiles where id=$1', [req.admin!.adminId]);
      bookedBy = (who.rows[0]?.display_name as string) || (who.rows[0]?.email as string) || 'Admin';
    }
    const { rows } = await tdb().query(
      `insert into public.ta_slots
         (teacher_id, teacher_name, subject, grade_min, grade_max, day_of_week, start_time, end_time,
          status, timezone, iana_timezone, session_type, booked_student, booked_note, booked_by, booked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, case when $9='booked' then now() else null end)
       returning id, teacher_id, teacher_name, subject, grade_min, grade_max, day_of_week, start_time, end_time,
                 status, timezone, session_type, booked_student, booked_note, booked_by`,
      [b.teacher_id, t.rows[0].name, b.subject, b.grade_min, b.grade_max, b.day_of_week, b.start_time, b.end_time,
       b.status, timezone, iana, booking ? (b.session_type ?? 'recurring') : null,
       booking ? (b.student ?? '') : '', booking ? (b.note ?? null) : null, booking ? bookedBy : '']);
    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1,'admin','teacher.slot.create','ta_slot',$2,$3)`,
        [req.admin!.adminId, rows[0].id, JSON.stringify({ teacher: t.rows[0].name, status: b.status, subject: b.subject })]);
    } catch { /* audit best-effort */ }
    return rows[0];
  });

  // Permanently delete a slot (available, booked or unavailable). Cascades ta_booking_request_slots.
  app.delete('/v1/admin/teacher/slots/:id', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const id = (req.params as { id: string }).id;
    const { rows } = await tdb().query(
      `delete from public.ta_slots where id = $1 returning id, teacher_name, status, day_of_week, start_time`, [id]);
    if (rows.length === 0) throw Errors.notFound('Slot not found');
    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1,'admin','teacher.slot.delete','ta_slot',$2,$3)`,
        [req.admin!.adminId, id, JSON.stringify({ status: rows[0].status, teacher: rows[0].teacher_name })]);
    } catch { /* audit best-effort */ }
    return { deleted: id };
  });

  // Occurrences of a booked slot (for the unbook popover's "On date" list). Recurring only;
  // demo/make-up return a single date. Read-only.
  app.get('/v1/admin/teacher/slots/:id/occurrences', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const id = (req.params as { id: string }).id;
    const { rows } = await tdb().query(
      `select s.id, s.teacher_id, s.day_of_week, s.start_time, s.end_time, s.status,
              s.booked_student, s.effective_from, s.effective_to,
              coalesce(brs.session_type, s.session_type, br.session_type) as session_type
         from public.ta_slots s
         left join public.ta_booking_requests br on br.id = s.booked_request_id
         left join public.ta_booking_request_slots brs on brs.request_id = s.booked_request_id and brs.slot_id = s.id
        where s.id = $1`, [id]);
    if (rows.length === 0) throw Errors.notFound('Slot not found');
    const s = rows[0] as any;
    const ef = s.effective_from ? new Date(s.effective_from).toISOString().slice(0,10) : null;
    const et = s.effective_to  ? new Date(s.effective_to).toISOString().slice(0,10)  : null;
    const sessionType = (s.session_type as string) || 'recurring';
    const dates = sessionType === 'recurring' ? occurrenceDates(s.day_of_week, ef, et) : [];
    return {
      slot: { id: s.id, day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time,
              booked_student: s.booked_student, session_type: sessionType, effective_to: et },
      occurrences: dates,
    };
  });

  // Unbook a booked slot. Recurring supports scope (this slot | all of the child's recurring slots with
  // this teacher) and mode (now = release; end = stop the series on a date or after N occurrences by
  // setting effective_to). Demo/make-up are one-off: a single release, scope/mode ignored.
  const unbookSchema = z.object({
    scope: z.enum(['slot', 'child']).default('slot'),
    mode: z.enum(['now', 'end']).default('now'),
    end_mode: z.enum(['date', 'count']).optional(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end_count: z.number().int().positive().max(520).optional(),
  });
  app.post('/v1/admin/teacher/slots/:id/unbook', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const id = (req.params as { id: string }).id;
    const b = unbookSchema.parse(req.body ?? {});
    const base = await tdb().query(
      `select s.id, s.teacher_id, s.day_of_week, s.booked_student, s.effective_from,
              coalesce(brs.session_type, s.session_type, br.session_type) as session_type
         from public.ta_slots s
         left join public.ta_booking_requests br on br.id = s.booked_request_id
         left join public.ta_booking_request_slots brs on brs.request_id = s.booked_request_id and brs.slot_id = s.id
        where s.id = $1`, [id]);
    if (base.rows.length === 0) throw Errors.notFound('Slot not found');
    const s = base.rows[0] as any;
    const sessionType = (s.session_type as string) || 'recurring';
    const recurring = sessionType === 'recurring';

    // Resolve target slot ids.
    let ids: string[] = [id];
    if (recurring && b.scope === 'child' && s.booked_student) {
      const kids = await tdb().query(
        `select s.id from public.ta_slots s
           left join public.ta_booking_requests br on br.id = s.booked_request_id
           left join public.ta_booking_request_slots brs on brs.request_id = s.booked_request_id and brs.slot_id = s.id
          where s.teacher_id = $1 and s.status = 'booked' and s.booked_student = $2
            and coalesce(brs.session_type, br.session_type, 'recurring') = 'recurring'`,
        [s.teacher_id, s.booked_student]);
      ids = kids.rows.map((r: any) => r.id as string);
      if (!ids.includes(id)) ids.push(id);
    }

    let result: Record<string, unknown> = {};
    if (recurring && b.mode === 'end') {
      let endDate: string | null = null;
      if (b.end_mode === 'date' && b.end_date) endDate = b.end_date;
      else if (b.end_mode === 'count' && b.end_count) {
        const ef = s.effective_from ? new Date(s.effective_from).toISOString().slice(0,10) : null;
        const occ = occurrenceDates(s.day_of_week, ef, null, Math.max(16, b.end_count + 2));
        endDate = occ[Math.min(b.end_count, occ.length) - 1] || null;
      }
      if (!endDate) throw Errors.validation('end_date or end_count is required to end the series');
      const r = await tdb().query(
        `update public.ta_slots set effective_to = $2, updated_at = now() where id = any($1::uuid[]) returning id`,
        [ids, endDate]);
      result = { ended: r.rows.map((x: any) => x.id), effective_to: endDate };
    } else {
      const r = await tdb().query(
        `update public.ta_slots
            set status = 'available', booked_student = '', booked_note = null, booked_by = '',
                booked_at = null, booked_request_id = null, updated_at = now()
          where id = any($1::uuid[]) returning id`, [ids]);
      result = { unbooked: r.rows.map((x: any) => x.id) };
    }
    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1,'admin','teacher.slot.unbook','ta_slot',$2,$3)`,
        [req.admin!.adminId, id, JSON.stringify({ scope: b.scope, mode: b.mode, session_type: sessionType, ...result })]);
    } catch { /* audit best-effort */ }
    return { ok: true, session_type: sessionType, scope: b.scope, ...result };
  });

  // ==== TeacherHub settings (global) — Auto Booking toggle ========================================
  // auto_book: when true, a teacher accepting a parent request books the slot immediately (TeacherHub app);
  // when false, acceptance is recorded and the admin books the slots. Stored in public.ta_settings so both
  // this admin and the TeacherHub app read the same value.
  app.get('/v1/admin/teacher/settings', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const { rows } = await tdb().query(`select value from public.ta_settings where key = 'auto_book'`);
    const row = rows[0];
    return { auto_book: row ? row.value === true : false };
  });
  app.patch('/v1/admin/teacher/settings', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const b = z.object({ auto_book: z.boolean() }).parse(req.body ?? {});
    await tdb().query(
      `insert into public.ta_settings (key, value, updated_at) values ('auto_book', $1::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`, [JSON.stringify(b.auto_book)]);
    try {
      await db.query(`insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
        values ($1,'admin','teacher.settings.update','ta_settings','auto_book',$2)`,
        [req.admin!.adminId, JSON.stringify({ auto_book: b.auto_book })]);
    } catch { /* audit best-effort */ }
    return { auto_book: b.auto_book };
  });

  // ==== Parent Booking Links (A) + Booking Requests inbox (B) =====================================
  // TeacherHub OWNS the ta_booking_* schema (shipped in cm-whiteboard migration `parent_booking_links`).
  // This admin only reads/writes those tables through teacherDb; it never creates or alters them.
  // Slot vocabulary is 'available' | 'booked'. Approval books slots race-safely via a conditional
  // UPDATE (... where status='available'): a slot taken between the parent's request and the admin's
  // decision resolves to outcome 'taken', not 'approved'. Reject reason has no column in the shipped
  // schema, so it is appended to ta_booking_requests.notes.

  const uuid = z.string().uuid();

  // Validate + de-duplicate a list of {subject, grade} booking-link combinations.
  function normalizeCombos(raw: unknown): Array<{ subject: string; grade: number }> {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>(); const out: Array<{ subject: string; grade: number }> = [];
    for (const it of raw) {
      const subject = String((it as { subject?: unknown })?.subject ?? '').trim();
      const grade = Number((it as { grade?: unknown })?.grade);
      if (!subject || subject.length > 120 || !Number.isInteger(grade) || grade < 1 || grade > 12) continue;
      const key = `${grade}|${subject}`;
      if (seen.has(key)) continue; seen.add(key); out.push({ subject, grade });
    }
    return out;
  }
  function parseCombosParam(v?: string): Array<{ subject: string; grade: number }> | null {
    if (!v) return null;
    try { return normalizeCombos(JSON.parse(v)); } catch { return null; }
  }
  // All (subject, grade) combinations the given teachers offer — parsed from ta_teachers.subjects
  // ("Subject (Grade N)"). Used to auto-scope a link to everything the selected teacher(s) teach.
  async function combosForTeachers(teacherIds: string[]): Promise<Array<{ subject: string; grade: number }>> {
    if (!teacherIds.length) return [];
    const { rows } = await tdb().query('select subjects from public.ta_teachers where id = any($1::uuid[])', [teacherIds]);
    const raws: Array<{ subject: string; grade: number }> = [];
    for (const r of rows) for (const raw of ((r.subjects as string[]) || [])) {
      const m = /^(.*?)\s*\(\s*Grade\s*(\d{1,2})\s*\)\s*$/i.exec(String(raw || ''));
      if (m) raws.push({ subject: (m[1] || '').trim(), grade: Number(m[2]) });
    }
    return normalizeCombos(raws);
  }

  // Resolve admin display names for a set of admin ids (booking links store created_by = admin id).
  async function adminNames(ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter(Boolean))];
    const m = new Map<string, string>();
    if (uniq.length === 0) return m;
    try {
      const r = await db.query('select id, display_name, email from ccat.admin_profiles where id = any($1)', [uniq]);
      for (const row of r.rows) m.set(row.id as string, (row.display_name as string) || (row.email as string) || 'Admin');
    } catch { /* names are cosmetic */ }
    return m;
  }
  async function adminDisplayName(adminId: string): Promise<string> {
    return (await adminNames([adminId])).get(adminId) ?? 'Admin';
  }

  // Notify the parent of the decision by email. Uses the gateway's shared email helper, which NEVER
  // throws and no-ops when email is not configured, so a send failure can never roll back or fail the
  // decision. Fire-and-forget: callers `void` it after commit.
  function escapeHtml(v: unknown): string {
    return String(v ?? '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string));
  }
  type DecisionSlot = { outcome: string; teacher_name: string; subject: string; day_of_week: string; start_time: string; end_time: string; timezone: string; slot_id?: string; teacher_id?: string; iana_timezone?: string | null; session_type?: string | null };
  // Calendar-invite events for the booked sessions in a decision (used for both the parent
  // attachment and the per-teacher copies).
  function icsEventsFor(slots: DecisionSlot[], studentName: string | null): IcsEvent[] {
    const who = studentName || 'your child';
    return slots.filter((s) => s.outcome === 'approved').map((s) => {
      const date = occurrenceDates(s.day_of_week, null, null, 1)[0] || new Date().toISOString().slice(0, 10);
      const recurring = !(s.session_type === 'demo' || s.session_type === 'makeup');
      return {
        uid: `${s.slot_id || Math.random().toString(36).slice(2)}@conceptmastery.teacherhub`,
        title: `${s.subject || 'Class'} — Concept Mastery`,
        desc: `Concept Mastery ${s.subject || ''} class for ${who} with ${s.teacher_name}.`.trim(),
        date, start: String(s.start_time), end: String(s.end_time),
        tzid: s.iana_timezone || 'Asia/Kolkata', recurring,
      };
    });
  }
  async function sendDecisionEmail(log: FastifyBaseLogger, o: {
    decision: string; to: string; parentName: string; studentName: string | null; numClasses: number; reason: string | null; slots: DecisionSlot[];
  }): Promise<void> {
    if (!o.to) return;
    const who = escapeHtml(o.studentName || 'your child');
    const parent = escapeHtml(o.parentName || 'there');
    const booked = o.slots.filter((x) => x.outcome === 'approved');

    // ---- Branded template (matches TeacherHub_Booking_Email_Templates). Styles are inlined because
    // email clients strip <style> blocks. The Concept Mastery logo is rendered as a text "brand pill"
    // rather than the large base64 image, to keep the message small. ----
    const CM_BLUE = '#1c3f6e';
    const P = 'margin:0 0 14px;color:#455065;font-size:15px;line-height:1.7;';
    // Logo is a hosted PNG served by the TeacherHub public app (public/cm-logo.png). We reference a
    // URL rather than a base64 data: URI because Gmail/Outlook strip inline data images. When the
    // public URL is not configured, fall back to a text brand pill so the header never breaks.
    const logoBase = (cfg.teachTimePublicUrl || '').replace(/\/+$/, '');
    const brand = logoBase
      ? `<div style="margin:0 0 22px;text-align:center;"><img src="${logoBase}/cm-logo.png" width="200" alt="Concept Mastery" style="width:200px;max-width:70%;height:auto;display:block;margin:0 auto;border:0;"></div>`
      : `<div style="margin:0 0 22px;text-align:center;"><span style="display:inline-block;padding:11px 18px;border-radius:999px;background:${CM_BLUE};color:#fff;font-size:15px;font-weight:800;letter-spacing:.2px;">Concept Mastery</span></div>`;
    const h2 = (t: string) => `<h2 style="margin:0 0 6px;color:${CM_BLUE};font-size:22px;font-weight:800;line-height:1.25;text-align:center;">${t}</h2>`;
    const preview = (t: string) => `<p style="margin:0 0 22px;color:#6b7280;font-size:15px;line-height:1.6;text-align:center;">${t}</p>`;
    // Day / Time / Teacher sessions table for a set of slots.
    const sessions = (rows: DecisionSlot[]) => `
      <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin:0 0 18px;color:#33415a;font-size:13px;">
        <tr>
          <th align="left" style="padding:10px 8px;border-bottom:1px solid #e5e7eb;color:${CM_BLUE};font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Day</th>
          <th align="left" style="padding:10px 8px;border-bottom:1px solid #e5e7eb;color:${CM_BLUE};font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Time</th>
          <th align="left" style="padding:10px 8px;border-bottom:1px solid #e5e7eb;color:${CM_BLUE};font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Teacher</th>
        </tr>
        ${rows.map((x) => `<tr>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${escapeHtml(x.day_of_week)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${escapeHtml(x.start_time)}–${escapeHtml(x.end_time)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${escapeHtml(x.teacher_name)}</td>
        </tr>`).join('')}
      </table>`;
    const panel = (title: string, inner: string) => `
      <div style="margin:0 0 22px;padding:20px;border-radius:10px;background:#eef3fb;">
        <div style="margin:0 0 10px;color:${CM_BLUE};font-size:15px;font-weight:800;">${title}</div>
        ${inner}
      </div>`;
    const footer = `
      <div style="margin:34px 0 0;padding-top:22px;border-top:1px solid #edeff3;text-align:center;">
        <p style="margin:0 0 10px;color:#6b7280;font-size:13px;line-height:1.7;text-align:center;"><strong style="color:${CM_BLUE};">Need help? We're here.</strong></p>
        <p style="margin:0 0 10px;color:#6b7280;font-size:13px;line-height:1.7;text-align:center;">Phone support: <a href="tel:+19054696087" style="color:${CM_BLUE};text-decoration:none;">+1 905-469-6087</a><br/>Call / WhatsApp: <a href="tel:+16477656606" style="color:${CM_BLUE};text-decoration:none;">+1 (647) 765-6606</a></p>
        <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.7;text-align:center;">Concept Mastery, 2161 Overfield Rd, Oakville, ON L6M 3T1, Canada</p>
      </div>`;

    let subject: string, body: string;
    if (o.decision === 'approved') {
      subject = 'Your Concept Mastery booking is confirmed';
      body = h2('Your booking is confirmed')
        + preview(`We have booked the requested sessions for ${who}.`)
        + `<p style="${P}">Hello ${parent},</p>`
        + `<p style="${P}">Your Concept Mastery booking for ${who} is confirmed. The following sessions are now booked with the child's name in TeacherHub.</p>`
        + sessions(booked)
        + `<p style="${P}">Please keep these times available for ${who}. If you need to make a change, contact us as soon as possible so we can check availability.</p>`;
    } else if (o.decision === 'partially_approved') {
      // Folded into the Confirmed email: list the booked sessions and add a short note that a few
      // requested times were not available. No separate "No longer available" table.
      subject = 'Your Concept Mastery booking is confirmed';
      body = h2('Your booking is confirmed')
        + preview(`We have booked the available sessions for ${who}.`)
        + `<p style="${P}">Hello ${parent},</p>`
        + `<p style="${P}">Your Concept Mastery booking for ${who} is confirmed. The following sessions are now booked with the child's name in TeacherHub.</p>`
        + sessions(booked)
        + `<p style="${P}">A few of the other requested times were no longer available. Our office will help with alternatives if you would like another session.</p>`;
    } else {
      subject = 'Update on your Concept Mastery booking request';
      const reason = o.reason ? escapeHtml(o.reason) : 'We are not able to confirm the requested times this time.';
      body = h2('Update on your booking request')
        + preview('We were not able to confirm the requested booking this time.')
        + `<p style="${P}">Hello ${parent},</p>`
        + `<p style="${P}">Thank you for submitting a booking request for ${who}. We are sorry, but we are not able to confirm the requested booking this time.</p>`
        + panel('Reason', `<p style="margin:0;color:#455065;font-size:15px;line-height:1.7;">${reason}</p>`)
        + `<p style="${P}">If you would like to try different times, please contact our office and we will help you check the next available options.</p>`;
    }

    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="margin:0;background:#f4f5f7;color:#1f2937;font-family:'Segoe UI',system-ui,-apple-system,BlinkMacSystemFont,Arial,sans-serif;">
      <table role="presentation" width="100%" style="border-collapse:collapse;background:#f4f5f7;"><tr><td align="center" style="padding:28px 14px;">
        <table role="presentation" width="600" style="max-width:600px;width:100%;border-collapse:collapse;background:#fff;border:1px solid #eceff2;border-radius:14px;">
          <tr><td style="padding:36px 40px;">
            ${brand}
            ${body}
            ${footer}
          </td></tr>
        </table>
      </td></tr></table>
    </body></html>`;
    // Attach a calendar invite for the booked sessions (confirmed bookings only).
    const icsEvents = (o.decision === 'approved' || o.decision === 'partially_approved') ? icsEventsFor(o.slots, o.studentName) : [];
    const attachments = icsEvents.length ? [{ name: 'concept-mastery-classes.ics', mime_type: 'text/calendar', content: buildIcsBase64(icsEvents) }] : undefined;
    try { await sendEmail(cfg, { to: o.to, subject, html, attachments }, log); }
    catch (e) { log?.warn?.({ err: (e as Error).message }, 'decision email failed'); }

    // Teacher copy: notify each teacher of the session(s) booked with them, with the same invite.
    if (icsEvents.length) { try { await sendTeacherConfirmations(log, o.slots, o.studentName); } catch (e) { log?.warn?.({ err: (e as Error).message }, 'teacher confirmation failed'); } }
  }

  // Send each teacher a confirmation + calendar invite for the sessions booked with them.
  async function sendTeacherConfirmations(log: FastifyBaseLogger, slots: DecisionSlot[], studentName: string | null): Promise<void> {
    const booked = slots.filter((s) => s.outcome === 'approved' && s.teacher_id);
    if (!booked.length) return;
    const ids = [...new Set(booked.map((s) => s.teacher_id as string))];
    const { rows } = await tdb().query('select id, name, email from public.ta_teachers where id = any($1::uuid[])', [ids]);
    const emailById = new Map<string, { name: string; email: string }>(rows.map((r) => [String(r.id), { name: r.name as string, email: r.email as string }]));
    const who = escapeHtml(studentName || 'a student');
    const CM_BLUE = '#1c3f6e';
    for (const tid of ids) {
      const t = emailById.get(tid);
      if (!t || !t.email) continue;
      const mine = booked.filter((s) => s.teacher_id === tid);
      const rowsHtml = mine.map((s) => `<tr>
        <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(s.day_of_week)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(String(s.start_time))}–${escapeHtml(String(s.end_time))}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(s.subject || '')}</td></tr>`).join('');
      const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:'Segoe UI',system-ui,Arial,sans-serif;">
        <table role="presentation" width="100%" style="border-collapse:collapse;background:#f4f5f7;"><tr><td align="center" style="padding:28px 14px;">
        <table role="presentation" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid #eceff2;border-radius:14px;"><tr><td style="padding:34px 40px;">
        <h2 style="margin:0 0 6px;color:${CM_BLUE};font-size:22px;font-weight:800;text-align:center;">New class booked</h2>
        <p style="margin:0 0 20px;color:#6b7280;font-size:15px;text-align:center;">A session has been booked with you for ${who}.</p>
        <p style="margin:0 0 14px;color:#455065;font-size:15px;line-height:1.7;">Hello ${escapeHtml(t.name || 'there')},</p>
        <p style="margin:0 0 14px;color:#455065;font-size:15px;line-height:1.7;">The following class${mine.length > 1 ? 'es have' : ' has'} been booked with you for ${who}. A calendar invite is attached.</p>
        <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin:0 0 16px;color:#33415a;font-size:13px;">
          <tr><th align="left" style="padding:10px 8px;border-bottom:1px solid #e5e7eb;color:${CM_BLUE};font-size:12px;text-transform:uppercase;">Day</th>
          <th align="left" style="padding:10px 8px;border-bottom:1px solid #e5e7eb;color:${CM_BLUE};font-size:12px;text-transform:uppercase;">Time</th>
          <th align="left" style="padding:10px 8px;border-bottom:1px solid #e5e7eb;color:${CM_BLUE};font-size:12px;text-transform:uppercase;">Subject</th></tr>
          ${rowsHtml}
        </table>
        <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.7;">Please keep these times for ${who}. If you cannot take a session, contact the office as soon as possible.</p>
        </td></tr></table></td></tr></table></body></html>`;
      const events = icsEventsFor(mine, studentName);
      const attachments = events.length ? [{ name: 'concept-mastery-classes.ics', mime_type: 'text/calendar', content: buildIcsBase64(events) }] : undefined;
      try { await sendEmail(cfg, { to: t.email, subject: `New class booked with you — ${studentName || 'Concept Mastery'}`, html, attachments }, log); }
      catch (e) { log?.warn?.({ err: (e as Error).message, teacher: tid }, 'teacher confirmation send failed'); }
    }
  }

  // Preview: how many available slots a link (these teachers + grade + subject) would surface now.
  app.get('/v1/admin/teacher/booking-links/preview', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const q = req.query as { teacher_ids?: string; combos?: string; grade?: string; subject?: string };
    const teacherIds = (q.teacher_ids ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    let combos = parseCombosParam(q.combos);
    if (!combos && q.subject && Number.isInteger(Number(q.grade))) combos = normalizeCombos([{ subject: q.subject, grade: Number(q.grade) }]); // legacy single
    if ((!combos || combos.length === 0) && teacherIds.length) combos = await combosForTeachers(teacherIds); // auto: all of the teacher(s) combos
    if (teacherIds.length === 0 || !combos || combos.length === 0) throw Errors.validation('teacher_ids required (and the teacher must have grade+subject offerings)');
    const { rows } = await tdb().query(
      `select count(*)::int as available
         from public.ta_slots s
        where s.teacher_id = any($1::uuid[])
          and s.status = 'available'
          and exists (select 1 from jsonb_to_recordset($2::jsonb) as c(subject text, grade int)
                       where c.subject = s.subject and c.grade between s.grade_min and s.grade_max)`,
      [teacherIds, JSON.stringify(combos)]);
    return { available: rows[0]?.available ?? 0, teachers: teacherIds.length, combos: combos.length };
  });

  const createLinkSchema = z.object({
    teacher_ids: z.array(uuid).min(1).max(50),
    // One or more (subject, grade) combinations this link surfaces. Legacy single grade/subject also
    // accepted for back-compat and folded into combos.
    combos: z.array(z.object({ subject: z.string().trim().min(1).max(120), grade: z.number().int().min(1).max(12) })).min(1).max(60).optional(),
    grade: z.number().int().min(1).max(12).optional(),
    subject: z.string().trim().min(1).max(120).optional(),
    label: z.string().trim().max(160).optional(),
    // Omitted / a positive number → days from now (default 14). never_expires:true → no expiry.
    expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
    never_expires: z.boolean().optional(),
  });

  app.post('/v1/admin/teacher/booking-links', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const b = createLinkSchema.parse(req.body ?? {});
    let combos = normalizeCombos(b.combos && b.combos.length ? b.combos : (b.subject && typeof b.grade === 'number' ? [{ subject: b.subject, grade: b.grade }] : []));
    if (combos.length === 0) combos = await combosForTeachers(b.teacher_ids); // auto: cover everything the selected teacher(s) teach
    if (combos.length === 0) combos = normalizeCombos([{ subject: 'All subjects', grade: 1 }]); // fallback: never block a link (combos are display-only; slots filter by teacher_ids)
    const chk = await tdb().query('select id from public.ta_teachers where id = any($1::uuid[])', [b.teacher_ids]);
    const found = new Set(chk.rows.map((r) => r.id as string));
    const missing = b.teacher_ids.filter((id) => !found.has(id));
    if (missing.length) throw Errors.validation('Unknown teacher id(s)', { missing });
    const token = randomBytes(24).toString('base64url'); // 32 url-safe chars
    const expiresAt = b.never_expires ? null : new Date(Date.now() + (b.expires_in_days ?? 14) * 86400000);
    const first = combos[0]!; // legacy grade/subject kept in sync with the first combo (columns are NOT NULL)
    const { rows } = await tdb().query(
      `insert into public.ta_booking_links (token, label, teacher_ids, grade, subject, combos, expires_at, is_active, created_by)
       values ($1,$2,$3::uuid[],$4,$5,$6::jsonb,$7,true,$8)
       returning id, token, label, teacher_ids, grade, subject, combos, expires_at, is_active, created_by, created_at`,
      [token, b.label ?? null, b.teacher_ids, first.grade, first.subject, JSON.stringify(combos), expiresAt, req.admin!.adminId]);
    const row = rows[0]!;
    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1,'admin','teacher.booking_link.create','ta_booking_link',$2,$3)`,
        [req.admin!.adminId, row.id, JSON.stringify({ teachers: b.teacher_ids.length, combos })]);
    } catch { /* audit best-effort */ }
    const base = cfg.teachTimePublicUrl;
    return { ...row, url: base ? `${base}/b/${row.token}` : null };
  });

  // ── n8n integration (Stage-8 R5): create a per-parent booking link via API key, no admin session.
  // Auth: X-API-Key header must equal cfg.teacherhubApiKey (set TEACHERHUB_API_KEY). Body:
  //   { grade, subject, teacher_ids[], num_classes?, expires_in_days?=7, label? } -> { token, url, expires_at }
  const n8nLinkSchema = z.object({
    teacher_ids: z.array(uuid).min(1).max(50),
    grade: z.number().int().min(1).max(12),
    subject: z.string().trim().min(1).max(120),
    num_classes: z.number().int().min(1).max(200).optional(),
    expires_in_days: z.number().int().min(1).max(365).optional(),
    label: z.string().trim().max(160).optional(),
  });
  app.post('/teacherhub/booking-links', async (req, reply) => {
    const key = String((req.headers['x-api-key'] as string | undefined) ?? '');
    if (!cfg.teacherhubApiKey || key !== cfg.teacherhubApiKey) return reply.code(401).send({ error: 'unauthorized' });
    requireSite(req, 'teacher');
    const b = n8nLinkSchema.parse(req.body ?? {});
    const chk = await tdb().query('select id from public.ta_teachers where id = any($1::uuid[])', [b.teacher_ids]);
    const found = new Set(chk.rows.map((r) => r.id as string));
    const missing = b.teacher_ids.filter((id) => !found.has(id));
    if (missing.length) throw Errors.validation('Unknown teacher id(s)', { missing });
    const combos = normalizeCombos([{ subject: b.subject, grade: b.grade }]);
    const first = combos[0]!;
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + (b.expires_in_days ?? 7) * 86400000);
    const { rows } = await tdb().query(
      `insert into public.ta_booking_links (token, label, teacher_ids, grade, subject, combos, expires_at, is_active, created_by)
       values ($1,$2,$3::uuid[],$4,$5,$6::jsonb,$7,true,$8)
       returning id, token, expires_at`,
      [token, b.label ?? null, b.teacher_ids, first.grade, first.subject, JSON.stringify(combos), expiresAt, 'n8n']);
    const row = rows[0]!;
    try {
      await tdb().query(
        `insert into public.ta_audit_log (actor_kind, event_type, target_kind, target_id, new_value)
         values ('system','teacher.booking_link.create','ta_booking_link',$1,$2::jsonb)`,
        [String(row.id), JSON.stringify({ via: 'n8n', teachers: b.teacher_ids.length, subject: b.subject, grade: b.grade })]);
    } catch { /* audit best-effort */ }
    const base = cfg.teachTimePublicUrl;
    return { token: row.token, url: base ? `${base}/b/${row.token}` : null, expires_at: row.expires_at };
  });

  // List links with computed status (active/expired/revoked) + request counts + created-by names.
  app.get('/v1/admin/teacher/booking-links', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    try { await tdb().query('select public.ta_ensure_booking_links(null)'); } catch { /* best-effort auto-renew of expired links */ }
    const q = req.query as { status?: string };
    const filter = (q.status ?? 'all').trim();
    const { rows } = await tdb().query(
      `select l.id, l.token, l.label, l.teacher_ids, l.grade, l.subject, l.combos, l.expires_at, l.is_active,
              l.created_by, l.created_at,
              (select count(*)::int from public.ta_booking_requests r where r.link_id = l.id and r.status = 'pending') as pending_requests,
              (select count(*)::int from public.ta_booking_requests r where r.link_id = l.id)                          as total_requests
         from public.ta_booking_links l
         order by l.created_at desc
         limit 500`);
    const names = await adminNames(rows.map((r) => r.created_by as string));
    const base = cfg.teachTimePublicUrl;
    const now = Date.now();
    const withStatus = rows.map((r) => {
      const status = !r.is_active ? 'revoked'
        : (r.expires_at && new Date(r.expires_at).getTime() < now) ? 'expired' : 'active';
      return { ...r, status, created_by_name: names.get(r.created_by as string) ?? null, url: base ? `${base}/b/${r.token}` : null };
    });
    const out = filter === 'all' ? withStatus : withStatus.filter((r) => r.status === filter);
    return { links: out };
  });

  const patchLinkSchema = z.object({
    action: z.enum(['revoke', 'activate']).optional(),
    expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
    never_expires: z.boolean().optional(),
  });
  app.patch('/v1/admin/teacher/booking-links/:id', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const id = (req.params as { id: string }).id;
    const b = patchLinkSchema.parse(req.body ?? {});
    const sets: string[] = [];
    const params: any[] = [id];
    if (b.action === 'revoke') sets.push('is_active = false');
    if (b.action === 'activate') sets.push('is_active = true');
    if (b.never_expires) sets.push('expires_at = null');
    else if (typeof b.expires_in_days === 'number') { params.push(new Date(Date.now() + b.expires_in_days * 86400000)); sets.push(`expires_at = $${params.length}`); }
    if (sets.length === 0) throw Errors.validation('Nothing to update');
    const { rows } = await tdb().query(
      `update public.ta_booking_links set ${sets.join(', ')} where id = $1
       returning id, token, label, teacher_ids, grade, subject, expires_at, is_active, created_by, created_at`, params);
    if (rows.length === 0) throw Errors.notFound('Booking link not found');
    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1,'admin','teacher.booking_link.update','ta_booking_link',$2,$3)`,
        [req.admin!.adminId, id, JSON.stringify({ action: b.action ?? null })]);
    } catch { /* best-effort */ }
    return rows[0];
  });

  // Pending-request count (Teacher Hub rail badge).
  app.get('/v1/admin/teacher/booking-requests/pending-count', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const { rows } = await tdb().query(`select count(*)::int as pending from public.ta_booking_requests where teacher_status = 'accepted' and status = 'pending'`);
    return { pending: rows[0]?.pending ?? 0 };
  });

  // List requests with their requested slots + link context. Default to pending (the inbox).
  app.get('/v1/admin/teacher/booking-requests', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const q = req.query as { status?: string; link_id?: string; teacher_id?: string; teacher_status?: string };
    const status = (q.status ?? 'pending').trim();
    const params: any[] = [];
    const conds: string[] = [];
    if (status !== 'all') { params.push(status); conds.push(`r.status = $${params.length}`); }
    if (q.teacher_status && q.teacher_status !== 'all') { params.push(q.teacher_status); conds.push(`r.teacher_status = $${params.length}`); }
    if (q.link_id) { params.push(q.link_id); conds.push(`r.link_id = $${params.length}`); }
    // Requests that include at least one slot belonging to this teacher.
    if (q.teacher_id) { params.push(q.teacher_id); conds.push(`exists (select 1 from public.ta_booking_request_slots rs2 join public.ta_slots s2 on s2.id = rs2.slot_id where rs2.request_id = r.id and s2.teacher_id = $${params.length})`); }
    const where = conds.length ? 'where ' + conds.join(' and ') : '';
    const { rows } = await tdb().query(
      `select r.id, r.link_id, r.num_classes, r.parent_name, r.parent_email, r.parent_phone,
              r.student_name, r.notes, r.parent_timezone, r.session_type, r.custom_time_requests, r.status, r.teacher_status, r.teacher_decided_at,
              r.decided_by, r.decided_at, r.created_at,
              l.subject as link_subject, l.grade as link_grade, l.label as link_label,
              coalesce(js.slots, '[]'::json) as slots
         from public.ta_booking_requests r
         join public.ta_booking_links l on l.id = r.link_id
         left join lateral (
           select json_agg(json_build_object(
             'slot_id', rs.slot_id, 'outcome', rs.outcome, 'teacher_slot_status', rs.teacher_slot_status, 'session_type', rs.session_type,
             'teacher_id', s.teacher_id, 'teacher_name', s.teacher_name, 'subject', s.subject,
             'day_of_week', s.day_of_week, 'start_time', s.start_time, 'end_time', s.end_time,
             'status', s.status, 'timezone', s.timezone,
             'grade_min', s.grade_min, 'grade_max', s.grade_max
           ) order by s.day_of_week, s.start_time) as slots
             from public.ta_booking_request_slots rs
             join public.ta_slots s on s.id = rs.slot_id
            where rs.request_id = r.id
         ) js on true
         ${where}
         order by r.created_at desc
         limit 300`, params);
    const names = await adminNames(rows.map((r) => r.decided_by as string).filter(Boolean));
    return { requests: rows.map((r) => ({ ...r, decided_by_name: r.decided_by ? (names.get(r.decided_by as string) ?? null) : null })) };
  });

  // Approve: book the chosen (or all) requested slots in ONE transaction, race-safe.
  const approveSchema = z.object({ slot_ids: z.array(uuid).optional() });
  app.post('/v1/admin/teacher/booking-requests/:id/approve', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const reqId = (req.params as { id: string }).id;
    const b = approveSchema.parse(req.body ?? {});
    const bookedBy = await adminDisplayName(req.admin!.adminId);

    const result = await withTransaction(tdb(), async (client) => {
      const rq = await client.query(
        `select id, link_id, parent_name, parent_email, parent_phone, student_name, notes, num_classes, status
           from public.ta_booking_requests where id = $1 for update`, [reqId]);
      if (rq.rows.length === 0) throw Errors.notFound('Booking request not found');
      const request = rq.rows[0];
      if (request.status !== 'pending') throw Errors.conflict('REQUEST_DECIDED', 'This request has already been decided');
      const rs = await client.query(`select slot_id from public.ta_booking_request_slots where request_id = $1`, [reqId]);
      const requested: string[] = rs.rows.map((r) => r.slot_id as string);
      if (requested.length === 0) throw Errors.validation('Request has no slots');
      const chosen = b.slot_ids && b.slot_ids.length ? b.slot_ids.filter((id) => requested.includes(id)) : requested;
      const approveSet = new Set(chosen);
      const student = ((request.student_name as string | null) || (request.parent_name as string | null) || '');
      const note = (request.notes as string | null) ?? null;

      let approved = 0, taken = 0, rejected = 0;
      for (const slotId of requested) {
        if (!approveSet.has(slotId)) {
          await client.query(`update public.ta_booking_request_slots set outcome = 'rejected' where request_id = $1 and slot_id = $2`, [reqId, slotId]);
          rejected++;
          continue;
        }
        const upd = await client.query(
          `update public.ta_slots
              set status = 'booked', booked_student = $2, booked_note = $3, booked_by = $4,
                  booked_at = now(), booked_request_id = $5, updated_at = now()
            where id = $1 and status = 'available'
            returning id`, [slotId, student, note, bookedBy, reqId]);
        if (upd.rows.length === 1) {
          await client.query(`update public.ta_booking_request_slots set outcome = 'approved' where request_id = $1 and slot_id = $2`, [reqId, slotId]);
          approved++;
        } else {
          await client.query(`update public.ta_booking_request_slots set outcome = 'taken' where request_id = $1 and slot_id = $2`, [reqId, slotId]);
          taken++;
        }
      }
      const newStatus = approved === 0 ? 'rejected' : (approved === requested.length ? 'approved' : 'partially_approved');
      await client.query(`update public.ta_booking_requests set status = $2, decided_by = $3, decided_at = now() where id = $1`, [reqId, newStatus, req.admin!.adminId]);
      const detail = await client.query(
        `select rs.slot_id, rs.outcome, s.teacher_id, s.teacher_name, s.subject, s.day_of_week, s.start_time, s.end_time, s.timezone, s.iana_timezone, coalesce(rs.session_type, s.session_type) as session_type
           from public.ta_booking_request_slots rs join public.ta_slots s on s.id = rs.slot_id where rs.request_id = $1`, [reqId]);
      return { request, newStatus, approved, taken, rejected, slots: detail.rows };
    });

    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1,'admin','teacher.booking_request.approve','ta_booking_request',$2,$3)`,
        [req.admin!.adminId, reqId, JSON.stringify({ status: result.newStatus, approved: result.approved, taken: result.taken, rejected: result.rejected })]);
    } catch { /* best-effort */ }

    void sendDecisionEmail(req.log, {
      decision: result.newStatus, to: result.request.parent_email, parentName: result.request.parent_name,
      studentName: result.request.student_name, numClasses: result.request.num_classes, reason: null,
      slots: result.slots as DecisionSlot[],
    });
    return { status: result.newStatus, approved: result.approved, taken: result.taken, rejected: result.rejected };
  });

  // Reject: mark all requested slots rejected, leave the slots available, append reason to notes.
  const rejectSchema = z.object({ reason: z.string().trim().max(500).optional() });
  app.post('/v1/admin/teacher/booking-requests/:id/reject', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const reqId = (req.params as { id: string }).id;
    const b = rejectSchema.parse(req.body ?? {});
    const reason = b.reason && b.reason.length ? b.reason : null;

    const result = await withTransaction(tdb(), async (client) => {
      const rq = await client.query(
        `select id, link_id, parent_name, parent_email, parent_phone, student_name, num_classes, notes, status
           from public.ta_booking_requests where id = $1 for update`, [reqId]);
      if (rq.rows.length === 0) throw Errors.notFound('Booking request not found');
      const request = rq.rows[0];
      if (request.status !== 'pending') throw Errors.conflict('REQUEST_DECIDED', 'This request has already been decided');
      await client.query(`update public.ta_booking_request_slots set outcome = 'rejected' where request_id = $1`, [reqId]);
      const prevNotes = (request.notes as string | null);
      const stamp = `[Rejected ${new Date().toISOString().slice(0, 10)}: ${reason}]`;
      const stamped = reason ? ((prevNotes && prevNotes.trim()) ? prevNotes + '\n' + stamp : stamp) : prevNotes;
      await client.query(`update public.ta_booking_requests set status = 'rejected', decided_by = $2, decided_at = now(), notes = $3 where id = $1`, [reqId, req.admin!.adminId, stamped]);
      const detail = await client.query(
        `select rs.slot_id, rs.outcome, s.teacher_id, s.teacher_name, s.subject, s.day_of_week, s.start_time, s.end_time, s.timezone, s.iana_timezone, coalesce(rs.session_type, s.session_type) as session_type
           from public.ta_booking_request_slots rs join public.ta_slots s on s.id = rs.slot_id where rs.request_id = $1`, [reqId]);
      return { request, slots: detail.rows };
    });

    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1,'admin','teacher.booking_request.reject','ta_booking_request',$2,$3)`,
        [req.admin!.adminId, reqId, JSON.stringify({ reason })]);
    } catch { /* best-effort */ }

    void sendDecisionEmail(req.log, {
      decision: 'rejected', to: result.request.parent_email, parentName: result.request.parent_name,
      studentName: result.request.student_name, numClasses: result.request.num_classes, reason,
      slots: result.slots as DecisionSlot[],
    });
    return { status: 'rejected' };
  });

  // Transfer a pending request to another teacher (admin picks any teacher). For each requested
  // time: if the target teacher already has an OPEN slot at that day+time, the request is repointed
  // to it; otherwise a CUSTOM available slot is created for that teacher carrying the time/subject.
  // The request returns to pending so the new teacher (or admin) can accept/book it.
  const transferSchema = z.object({ to_teacher_id: uuid });
  app.post('/v1/admin/teacher/booking-requests/:id/transfer', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const reqId = (req.params as { id: string }).id;
    const b = transferSchema.parse(req.body ?? {});
    const toTeacherId = b.to_teacher_id;

    const result = await withTransaction(tdb(), async (client) => {
      const rq = await client.query(`select id, status from public.ta_booking_requests where id = $1 for update`, [reqId]);
      if (rq.rows.length === 0) throw Errors.notFound('Booking request not found');
      if (rq.rows[0].status !== 'pending') throw Errors.conflict('REQUEST_DECIDED', 'Only a pending request can be transferred');

      const t = await client.query('select id, name from public.ta_teachers where id = $1', [toTeacherId]);
      if (t.rows.length === 0) throw Errors.notFound('Target teacher not found');
      const toName = t.rows[0].name as string;
      const ref = await client.query('select timezone, iana_timezone from public.ta_slots where teacher_id = $1 order by created_at desc nulls last limit 1', [toTeacherId]);
      const refTz = (ref.rows[0]?.timezone as string) || 'IST';
      const refIana = (ref.rows[0]?.iana_timezone as string) || 'Asia/Kolkata';

      const cur = await client.query(
        `select rs.slot_id, rs.session_type as rs_type,
                s.day_of_week, s.start_time, s.end_time, s.subject, s.grade_min, s.grade_max, s.session_type as s_type
           from public.ta_booking_request_slots rs
           join public.ta_slots s on s.id = rs.slot_id
          where rs.request_id = $1`, [reqId]);
      if (cur.rows.length === 0) throw Errors.validation('Request has no slots');

      const mapping: Array<{ to: string; kind: 'matched' | 'custom'; label: string }> = [];
      for (const row of cur.rows) {
        const m = await client.query(
          `select id from public.ta_slots
            where teacher_id = $1 and day_of_week = $2 and start_time = $3 and end_time = $4 and status = 'available'
            limit 1`, [toTeacherId, row.day_of_week, row.start_time, row.end_time]);
        let newSlotId: string; let kind: 'matched' | 'custom';
        if (m.rows.length === 1) {
          newSlotId = m.rows[0].id as string; kind = 'matched';
        } else {
          const ins = await client.query(
            `insert into public.ta_slots
               (teacher_id, teacher_name, subject, grade_min, grade_max, day_of_week, start_time, end_time, status, timezone, iana_timezone)
             values ($1,$2,$3,$4,$5,$6,$7,$8,'available',$9,$10)
             returning id`,
            [toTeacherId, toName, row.subject, row.grade_min, row.grade_max, row.day_of_week, row.start_time, row.end_time, refTz, refIana]);
          newSlotId = ins.rows[0].id as string; kind = 'custom';
        }
        await client.query(
          `update public.ta_booking_request_slots
              set slot_id = $3, teacher_slot_status = 'pending', outcome = 'pending'
            where request_id = $1 and slot_id = $2`, [reqId, row.slot_id, newSlotId]);
        mapping.push({ to: newSlotId, kind, label: `${row.day_of_week} ${row.start_time}–${row.end_time}` });
      }
      await client.query(
        `update public.ta_booking_requests set teacher_status = 'pending', teacher_decided_at = null, status = 'pending' where id = $1`, [reqId]);
      return { toName, mapping };
    });

    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1,'admin','teacher.booking_request.transfer','ta_booking_request',$2,$3)`,
        [req.admin!.adminId, reqId, JSON.stringify({ to_teacher_id: toTeacherId, mapping: result.mapping })]);
    } catch { /* best-effort */ }

    return {
      ok: true, to_teacher: result.toName,
      matched: result.mapping.filter((m) => m.kind === 'matched').length,
      custom: result.mapping.filter((m) => m.kind === 'custom').length,
      mapping: result.mapping,
    };
  });

  // Candidate teachers for a transfer: all active teachers (admin picks any). Includes a quick
  // flag for whether each already has an open slot matching the request's requested times.
  app.get('/v1/admin/teacher/booking-requests/:id/transfer-candidates', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const reqId = (req.params as { id: string }).id;
    const cur = await tdb().query(
      `select s.day_of_week, s.start_time::text as start_time, s.end_time::text as end_time
         from public.ta_booking_request_slots rs join public.ta_slots s on s.id = rs.slot_id
        where rs.request_id = $1`, [reqId]);
    const times = cur.rows.map((r) => ({ day_of_week: r.day_of_week as string, start_time: r.start_time as string, end_time: r.end_time as string }));
    const teachers = await tdb().query(
      `select id, name, coalesce(banned_at is not null, false) as banned from public.ta_teachers order by name asc`);
    // For each teacher, which of the requested times they already have OPEN (so the UI can preview
    // matched-vs-custom). Empty request-times → no open map (every time becomes custom).
    const openByTeacher = new Map<string, Set<string>>();
    if (times.length) {
      const open = await tdb().query(
        `select distinct s.teacher_id, s.day_of_week, s.start_time::text as start_time, s.end_time::text as end_time
           from public.ta_slots s
           join jsonb_to_recordset($1::jsonb) as t(day_of_week text, start_time text, end_time text)
             on t.day_of_week = s.day_of_week and t.start_time = s.start_time::text and t.end_time = s.end_time::text
          where s.status = 'available'`, [JSON.stringify(times)]);
      for (const o of open.rows) {
        const key = `${o.day_of_week}|${o.start_time}|${o.end_time}`;
        const tid = String(o.teacher_id);
        if (!openByTeacher.has(tid)) openByTeacher.set(tid, new Set());
        openByTeacher.get(tid)!.add(key);
      }
    }
    return {
      times,
      teachers: teachers.rows.filter((t) => !t.banned).map((t) => ({ id: t.id, name: t.name, open: [...(openByTeacher.get(String(t.id)) ?? [])] })),
    };
  });

  // Accept / decline a request ON BEHALF of the teacher (admin override, when the teacher hasn't
  // acted in the teacher app). Sets teacher_status only — booking still happens via approve.
  app.post('/v1/admin/teacher/booking-requests/:id/teacher-decision/:decision', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const { id: reqId, decision } = req.params as { id: string; decision: string };
    const map: Record<string, string> = { accept: 'accepted', decline: 'declined' };
    const teacherStatus = map[decision];
    if (!teacherStatus) throw Errors.validation('Decision must be accept or decline');
    const upd = await tdb().query(
      `update public.ta_booking_requests
          set teacher_status = $2, teacher_decided_at = now()
        where id = $1 and status = 'pending'
        returning id`, [reqId, teacherStatus]);
    if (upd.rows.length === 0) throw Errors.notFound('Pending booking request not found');
    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1,'admin','teacher.booking_request.teacher_decision','ta_booking_request',$2,$3)`,
        [req.admin!.adminId, reqId, JSON.stringify({ teacher_status: teacherStatus, on_behalf: true })]);
    } catch { /* best-effort */ }
    return { status: teacherStatus };
  });

  // ---- Teacher LEAVE requests. Teachers submit leave (date range + reason) in the TeacherHub app; an
  // admin approves/rejects here. An APPROVED leave hides that teacher's availability for the range. ----
  app.get('/v1/admin/teacher/leave-requests', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const q = req.query as { status?: string };
    const status = (q.status ?? 'all').trim();
    const params: unknown[] = [];
    let where = '';
    if (status && status !== 'all') { params.push(status); where = 'where lr.status = $1'; }
    const { rows } = await tdb().query(
      `select lr.id, lr.teacher_id, t.name as teacher_name, t.email as teacher_email,
              lr.start_date, lr.end_date, lr.reason, lr.status, lr.decided_by, lr.decided_at, lr.created_at
         from public.ta_leave_requests lr
         join public.ta_teachers t on t.id = lr.teacher_id
         ${where}
         order by lr.created_at desc
         limit 500`, params);
    return { requests: rows };
  });

  app.post('/v1/admin/teacher/leave-requests/:id/:decision', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const { id, decision } = req.params as { id: string; decision: string };
    if (decision !== 'approve' && decision !== 'reject') throw Errors.validation('decision must be approve or reject');
    const next = decision === 'approve' ? 'approved' : 'rejected';
    const who = await adminDisplayName(req.admin!.adminId);
    const { rows } = await tdb().query(
      `update public.ta_leave_requests set status = $1, decided_by = $2, decided_at = now()
        where id = $3 and status = 'pending'
        returning id, status`, [next, who, id]);
    if (!rows.length) throw Errors.validation('Leave request not found or already decided');
    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1,'admin',$2,'ta_leave_request',$3,$4)`,
        [req.admin!.adminId, 'teacher.leave.' + decision, id, JSON.stringify({ status: next })]);
    } catch { /* audit best-effort */ }
    return { id, status: next };
  });


  // Ban (temporary) / unban a teacher account. banned_at != null = banned. Enforcement of the block
  // (login + hiding availability from parents) lives in the TeacherHub app.
  app.post('/v1/admin/teacher/teachers/:id/:action', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const { id, action } = req.params as { id: string; action: string };
    if (action === 'ban' || action === 'unban') {
      const { rows } = await tdb().query(
        `update public.ta_teachers set banned_at = ${action === 'ban' ? 'now()' : 'null'} where id = $1 returning id, banned_at`, [id]);
      if (rows.length === 0) throw Errors.notFound('Teacher not found');
      return { id, banned_at: rows[0].banned_at };
    }
    if (action === 'approve' || action === 'unapprove') {
      const { rows } = await tdb().query(
        `update public.ta_teachers set profile_approved = $2 where id = $1 returning id, profile_approved`, [id, action === 'approve']);
      if (rows.length === 0) throw Errors.notFound('Teacher not found');
      return { id, profile_approved: rows[0].profile_approved };
    }
    throw Errors.validation('Action must be ban, unban, approve or unapprove');
  });

  // Toggle one capability (subject) active/inactive for a teacher. Inactive subjects are kept in
  // ta_teachers.inactive_subjects; availability/booking logic treats them as switched off.
  const capabilitySchema = z.object({ subject: z.string().trim().min(1).max(80), active: z.boolean() });
  app.post('/v1/admin/teacher/teachers/:id/capability', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const id = (req.params as { id: string }).id;
    const b = capabilitySchema.parse(req.body ?? {});
    const sql = b.active
      ? `update public.ta_teachers set inactive_subjects = array_remove(inactive_subjects, $2) where id = $1 returning id, inactive_subjects`
      : `update public.ta_teachers set inactive_subjects = (select array(select distinct unnest(coalesce(inactive_subjects,'{}') || array[$2]))) where id = $1 returning id, inactive_subjects`;
    const { rows } = await tdb().query(sql, [id, b.subject]);
    if (rows.length === 0) throw Errors.notFound('Teacher not found');
    return { id, inactive_subjects: rows[0].inactive_subjects };
  });

  // Permanently delete a teacher account and all their data. Transactional: clears the leave rows that
  // would block the FK, drops the teacher from any booking-link teacher lists, then deletes the teacher
  // (slots, sessions, training progress and booking-request slots cascade).
  app.delete('/v1/admin/teacher/teachers/:id', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const id = (req.params as { id: string }).id;
    await withTransaction(tdb(), async (client) => {
      const chk = await client.query('select id from public.ta_teachers where id = $1', [id]);
      if (chk.rows.length === 0) throw Errors.notFound('Teacher not found');
      await client.query('delete from public.ta_leave_requests where teacher_id = $1', [id]);
      await client.query('update public.ta_booking_links set teacher_ids = array_remove(teacher_ids, $1::uuid) where $1::uuid = any(teacher_ids)', [id]);
      await client.query('delete from public.ta_teachers where id = $1', [id]);
    });
    try {
      await db.query(
        `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, new_value)
         values ($1,'admin','teacher.account.delete','ta_teacher',$2,$3)`,
        [req.admin!.adminId, id, JSON.stringify({ deleted: true })]);
    } catch { /* best-effort */ }
    return { deleted: id };
  });
  // Training progress for every teacher — the matrix behind the "Teacher Progress" page.
  app.get('/v1/admin/teacher/training-progress', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const mres = await tdb().query(
      `select id, title, icon from public.ta_training_modules where active order by sort_order, id`);
    const tres = await tdb().query(
      `select t.id, t.name, t.email,
              count(p.module_id) filter (where p.passed)::int      as passed,
              count(p.module_id) filter (where not p.passed)::int  as in_progress,
              max(coalesce(p.completed_at, p.started_at))          as last_at,
              coalesce(array_agg(p.module_id) filter (where p.passed), '{}')     as passed_ids,
              coalesce(array_agg(p.module_id) filter (where not p.passed), '{}') as started_ids
         from public.ta_teachers t
         left join public.ta_training_progress p on p.teacher_id = t.id
         group by t.id, t.name, t.email
         order by t.name`);
    const modules = mres.rows as { id: number; title: string; icon: string | null }[];
    const teachers = (tres.rows as Array<{ id: string; name: string; email: string; passed: number | null; in_progress: number | null; last_at: string | null; passed_ids: unknown[] | null; started_ids: unknown[] | null }>).map(r => ({
      id: r.id, name: r.name, email: r.email,
      passed: r.passed ?? 0,
      in_progress: r.in_progress ?? 0,
      last_at: r.last_at,
      passed_ids: (r.passed_ids || []).map(x => Number(x)),
      started_ids: (r.started_ids || []).map(x => Number(x)),
    }));
    return { total: modules.length, modules, teachers };
  });

}
