import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { z } from 'zod';
import { makeAuthenticateAdmin, requirePermission, requireSite } from '../plugins/adminAuth.js';
import { AppError, Errors } from '../errors.js';
import { withTransaction } from '../db.js';
import { sendEmail } from '../lib/email.js';
import { randomBytes } from 'node:crypto';

// Teacher Hub (TeachTime) admin surface. This site's data lives in a SEPARATE Supabase project
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
         (select count(*)::int from public.ta_slots where status = 'booked')     as booked_slots`);
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
      `select t.id, t.name, t.email, t.subjects, t.created_at,
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
              s.start_time, s.end_time, s.mode, s.status, s.timezone, s.notes,
              s.booked_student, s.booked_note, s.booked_by, s.booked_at
         from public.ta_slots s
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
    status: z.enum(['available', 'booked']),
    student: z.string().trim().max(120).optional(),
    note: z.string().trim().max(500).optional(),
  }).refine((v) => v.status === 'available' || !!(v.student && v.student.length > 0), { message: 'Student name is required to book', path: ['student'] });

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
              booked_at      = case when $2 = 'booked' then now() else null end,
              booked_request_id = case when $2 = 'booked' then booked_request_id else null end,
              updated_at     = now()
        where id = $1
        returning id, teacher_id, teacher_name, subject, grade, day_of_week, start_time, end_time,
                  mode, status, timezone, booked_student, booked_note, booked_by, booked_at`,
      // booked_student and booked_by are NOT NULL (default ''); clear them to '' on unbook, never null.
      [id, b.status, booking ? (b.student ?? '') : '', booking ? (b.note ?? null) : null, booking ? bookedBy : '']);
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


  // ==== Parent Booking Links (A) + Booking Requests inbox (B) =====================================
  // TeachTime OWNS the ta_booking_* schema (shipped in cm-whiteboard migration `parent_booking_links`).
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
  type DecisionSlot = { outcome: string; teacher_name: string; subject: string; day_of_week: string; start_time: string; end_time: string; mode: string; timezone: string };
  async function sendDecisionEmail(log: FastifyBaseLogger, o: {
    decision: string; to: string; parentName: string; studentName: string | null; numClasses: number; reason: string | null; slots: DecisionSlot[];
  }): Promise<void> {
    if (!o.to) return;
    const who = escapeHtml(o.studentName || 'your child');
    const fmt = (x: DecisionSlot) => `${x.day_of_week} ${x.start_time}–${x.end_time} · ${escapeHtml(x.teacher_name)} · ${x.mode} (${x.timezone})`;
    const booked = o.slots.filter((x) => x.outcome === 'approved');
    const notBooked = o.slots.filter((x) => x.outcome === 'taken' || x.outcome === 'rejected');
    let subject: string, heading: string, intro: string, extra = '', showTable = false;
    if (o.decision === 'approved') {
      subject = 'Your Concept Mastery booking is confirmed';
      heading = 'Booking confirmed';
      intro = `Good news — ${booked.length === 1 ? 'the session below has' : 'the sessions below have'} been confirmed for ${who}.`;
      showTable = true;
    } else if (o.decision === 'partially_approved') {
      subject = 'Your Concept Mastery booking — partially confirmed';
      heading = 'Booking partially confirmed';
      intro = `We’ve confirmed ${booked.length} of your requested ${booked.length === 1 ? 'session' : 'sessions'} for ${who}.`;
      extra = `<p style="margin:18px 0 0;color:#5b6472;font-size:14px;line-height:1.6;">Unfortunately ${notBooked.length} of your requested ${notBooked.length === 1 ? 'time is' : 'times are'} no longer available. Simply reply to this email and we’ll help you find an alternative.</p>`;
      showTable = true;
    } else {
      subject = 'Update on your Concept Mastery booking request';
      heading = 'Booking request update';
      intro = `Thank you for your interest in Concept Mastery. Unfortunately we’re unable to confirm your requested ${o.slots.length === 1 ? 'session' : 'sessions'} for ${who} at this time.`;
      if (o.reason) extra += `<p style="margin:18px 0 0;color:#5b6472;font-size:14px;line-height:1.6;"><strong>Note:</strong> ${escapeHtml(o.reason)}</p>`;
      extra += `<p style="margin:12px 0 0;color:#5b6472;font-size:14px;line-height:1.6;">The times you selected remain open — you’re welcome to submit a new request, or reply to this email and we’ll help you find a suitable slot.</p>`;
    }
    const tableHtml = showTable && booked.length ? `
      <table role="presentation" width="100%" style="border-collapse:collapse;margin:18px 0 0;background:#f7f9fc;border:1px solid #e6e9f0;border-radius:8px;overflow:hidden;">
        ${booked.map((x) => `<tr><td style="padding:10px 14px;border-bottom:1px solid #eef1f6;font-size:14px;color:#26303f;">${fmt(x)}</td></tr>`).join('')}
      </table>` : '';
    const html = `<!doctype html><html><body style="margin:0;background:#eef1f6;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
      <table role="presentation" width="100%" style="border-collapse:collapse;"><tr><td align="center">
        <table role="presentation" width="560" style="max-width:560px;width:100%;border-collapse:collapse;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(20,30,50,.06);">
          <tr><td style="background:#2f6fd0;padding:20px 28px;"><span style="color:#ffffff;font-weight:800;font-size:18px;letter-spacing:.02em;">Concept Mastery</span></td></tr>
          <tr><td style="padding:28px;">
            <h1 style="margin:0 0 12px;font-size:20px;color:#1c2635;">${heading}</h1>
            <p style="margin:0;color:#26303f;font-size:15px;line-height:1.6;">Hi ${escapeHtml(o.parentName)},</p>
            <p style="margin:12px 0 0;color:#26303f;font-size:15px;line-height:1.6;">${intro}</p>
            ${tableHtml}
            ${extra}
            <p style="margin:22px 0 0;color:#26303f;font-size:15px;line-height:1.6;">Warm regards,<br/>The Concept Mastery Team</p>
          </td></tr>
          <tr><td style="padding:16px 28px;background:#f7f9fc;border-top:1px solid #eef1f6;">
            <p style="margin:0;color:#8a93a3;font-size:12px;line-height:1.5;">Concept Mastery · <a href="mailto:info@conceptmastery.com" style="color:#2f6fd0;text-decoration:none;">info@conceptmastery.com</a><br/>This is an automated message about your booking request — you can reply to reach our team.</p>
          </td></tr>
        </table>
      </td></tr></table>
    </body></html>`;
    try { await sendEmail(cfg, { to: o.to, subject, html }, log); }
    catch (e) { log?.warn?.({ err: (e as Error).message }, 'decision email failed'); }
  }

  // Preview: how many available slots a link (these teachers + grade + subject) would surface now.
  app.get('/v1/admin/teacher/booking-links/preview', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const q = req.query as { teacher_ids?: string; combos?: string; grade?: string; subject?: string };
    const teacherIds = (q.teacher_ids ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    let combos = parseCombosParam(q.combos);
    if (!combos && q.subject && Number.isInteger(Number(q.grade))) combos = normalizeCombos([{ subject: q.subject, grade: Number(q.grade) }]); // legacy single
    if (teacherIds.length === 0 || !combos || combos.length === 0) throw Errors.validation('teacher_ids and combos are required');
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
    const combos = normalizeCombos(b.combos && b.combos.length ? b.combos : (b.subject && typeof b.grade === 'number' ? [{ subject: b.subject, grade: b.grade }] : []));
    if (combos.length === 0) throw Errors.validation('At least one grade+subject combination is required');
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

  // List links with computed status (active/expired/revoked) + request counts + created-by names.
  app.get('/v1/admin/teacher/booking-links', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
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
    const { rows } = await tdb().query(`select count(*)::int as pending from public.ta_booking_requests where status = 'pending'`);
    return { pending: rows[0]?.pending ?? 0 };
  });

  // List requests with their requested slots + link context. Default to pending (the inbox).
  app.get('/v1/admin/teacher/booking-requests', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const q = req.query as { status?: string; link_id?: string };
    const status = (q.status ?? 'pending').trim();
    const params: any[] = [];
    const conds: string[] = [];
    if (status !== 'all') { params.push(status); conds.push(`r.status = $${params.length}`); }
    if (q.link_id) { params.push(q.link_id); conds.push(`r.link_id = $${params.length}`); }
    const where = conds.length ? 'where ' + conds.join(' and ') : '';
    const { rows } = await tdb().query(
      `select r.id, r.link_id, r.num_classes, r.parent_name, r.parent_email, r.parent_phone,
              r.student_name, r.notes, r.parent_timezone, r.status, r.decided_by, r.decided_at, r.created_at,
              l.subject as link_subject, l.grade as link_grade, l.label as link_label,
              coalesce(js.slots, '[]'::json) as slots
         from public.ta_booking_requests r
         join public.ta_booking_links l on l.id = r.link_id
         left join lateral (
           select json_agg(json_build_object(
             'slot_id', rs.slot_id, 'outcome', rs.outcome,
             'teacher_id', s.teacher_id, 'teacher_name', s.teacher_name, 'subject', s.subject,
             'day_of_week', s.day_of_week, 'start_time', s.start_time, 'end_time', s.end_time,
             'mode', s.mode, 'status', s.status, 'timezone', s.timezone,
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
        `select rs.slot_id, rs.outcome, s.teacher_name, s.subject, s.day_of_week, s.start_time, s.end_time, s.mode, s.timezone
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
        `select rs.slot_id, rs.outcome, s.teacher_name, s.subject, s.day_of_week, s.start_time, s.end_time, s.mode, s.timezone
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

}
