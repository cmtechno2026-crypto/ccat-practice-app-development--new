import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { sendEmail } from './email.js';

// ---- 24-hour teacher acceptance SLA ----------------------------------------------------------
// A parent's requested slot must be accepted or declined by the teacher within ACCEPT_WINDOW_HOURS
// of the booking request being created. REMINDER_LEAD_HOURS before the window closes the teacher is
// reminded; at the window, still-pending slots are auto-declined and teacher / parent / admin are
// notified. Operates on the TeacherHub ("cm-whiteboard") DB (public.ta_* tables). Idempotent: the
// reminder is stamped (sla_reminder_at) so it is sent once, and expiry only touches pending slots.
const ACCEPT_WINDOW_HOURS = 24;
const REMINDER_LEAD_HOURS = 1;

type MiniLog = { info?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void };
type Slot = { day_of_week: string; start_time: string; end_time: string; teacher_name?: string };

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string));
}
const CM_BLUE = '#1c3f6e';
const P = 'margin:0 0 14px;color:#455065;font-size:15px;line-height:1.7;';
const h2 = (t: string) => `<h2 style="margin:0 0 6px;color:${CM_BLUE};font-size:22px;font-weight:800;line-height:1.25;text-align:center;">${t}</h2>`;
const preview = (t: string) => `<p style="margin:0 0 22px;color:#6b7280;font-size:15px;line-height:1.6;text-align:center;">${t}</p>`;
const button = (label: string, href: string) => `<div style="text-align:center;margin:8px 0 22px;"><a href="${href}" style="display:inline-block;background:#e5443f;color:#fff;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:1px;text-transform:uppercase;padding:14px 36px;border-radius:999px;">${label}</a></div>`;

function brand(cfg: Config): string {
  const logoBase = (cfg.teachTimePublicUrl || '').replace(/\/+$/, '');
  return logoBase
    ? `<div style="margin:0 0 22px;text-align:center;"><img src="${logoBase}/cm-logo.png" width="200" alt="Concept Mastery" style="width:200px;max-width:70%;height:auto;display:block;margin:0 auto;border:0;"></div>`
    : `<div style="margin:0 0 22px;text-align:center;"><span style="display:inline-block;padding:11px 18px;border-radius:999px;background:${CM_BLUE};color:#fff;font-size:15px;font-weight:800;">Concept Mastery</span></div>`;
}
function sessions(rows: Slot[]): string {
  return `<table role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin:0 0 18px;color:#33415a;font-size:13px;">
    <tr>
      <th align="left" style="padding:10px 8px;border-bottom:1px solid #e5e7eb;color:${CM_BLUE};font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Day</th>
      <th align="left" style="padding:10px 8px;border-bottom:1px solid #e5e7eb;color:${CM_BLUE};font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Time</th>
      <th align="left" style="padding:10px 8px;border-bottom:1px solid #e5e7eb;color:${CM_BLUE};font-size:12px;text-transform:uppercase;letter-spacing:.04em;">Teacher</th>
    </tr>
    ${rows.map((x) => `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${esc(x.day_of_week)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${esc(x.start_time)}–${esc(x.end_time)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${esc(x.teacher_name ?? '')}</td>
    </tr>`).join('')}
  </table>`;
}
const footer = `<div style="margin:34px 0 0;padding-top:22px;border-top:1px solid #edeff3;text-align:center;">
    <p style="margin:0 0 10px;color:#6b7280;font-size:13px;line-height:1.7;"><strong style="color:${CM_BLUE};">Need help? We're here.</strong></p>
    <p style="margin:0 0 10px;color:#6b7280;font-size:13px;line-height:1.7;">Phone support: <a href="tel:+19054696087" style="color:${CM_BLUE};text-decoration:none;">+1 905-469-6087</a><br/>Call / WhatsApp: <a href="tel:+16477656606" style="color:${CM_BLUE};text-decoration:none;">+1 (647) 765-6606</a></p>
    <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.7;">Concept Mastery, 2161 Overfield Rd, Oakville, ON L6M 3T1, Canada</p>
  </div>`;
function wrap(cfg: Config, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="margin:0;background:#f4f5f7;color:#1f2937;font-family:'Segoe UI',system-ui,-apple-system,BlinkMacSystemFont,Arial,sans-serif;">
    <table role="presentation" width="100%" style="border-collapse:collapse;background:#f4f5f7;"><tr><td align="center" style="padding:28px 14px;">
      <table role="presentation" width="600" style="max-width:600px;width:100%;border-collapse:collapse;background:#fff;border:1px solid #eceff2;border-radius:14px;">
        <tr><td style="padding:36px 40px;">${brand(cfg)}${inner}${footer}</td></tr>
      </table>
    </td></tr></table></body></html>`;
}

export async function runTeacherSlaTick(teacherDb: DB, cfg: Config, log?: MiniLog): Promise<{ reminded: number; expired: number }> {
  let reminded = 0;

  // 1) Reminder: one email per (request, teacher) with pending slots in the final hour of the window.
  const rem = await teacherDb.query(
    `select s.teacher_id, r.id as request_id,
            max(s.teacher_name) as teacher_name, max(tt.email) as teacher_email,
            max(r.student_name) as student_name,
            json_agg(json_build_object('day_of_week', s.day_of_week, 'start_time', s.start_time,
                     'end_time', s.end_time, 'teacher_name', s.teacher_name)
                     order by s.day_of_week, s.start_time) as slots
       from public.ta_booking_request_slots rs
       join public.ta_slots s on s.id = rs.slot_id
       join public.ta_booking_requests r on r.id = rs.request_id
       join public.ta_teachers tt on tt.id = s.teacher_id
      where r.status = 'pending'
        and coalesce(rs.teacher_slot_status, 'pending') = 'pending'
        and rs.sla_reminder_at is null
        and rs.sla_expired_at is null
        and r.created_at <= now() - (($1)::text || ' hours')::interval
        and r.created_at >  now() - (($2)::text || ' hours')::interval
      group by s.teacher_id, r.id`,
    [ACCEPT_WINDOW_HOURS - REMINDER_LEAD_HOURS, ACCEPT_WINDOW_HOURS]);

  for (const row of rem.rows as any[]) {
    const slots = (row.slots as Slot[]) || [];
    const who = esc(row.student_name || 'a student');
    const teacher = esc(row.teacher_name || 'there');
    const link = (cfg.teachTimePublicUrl || '').replace(/\/+$/, '') + '/requests';
    const inner = h2('1 hour left to respond')
      + preview(`A booking request for ${who} is about to expire.`)
      + `<p style="${P}">Hello ${teacher},</p>`
      + `<p style="${P}">You have about <strong>one hour left</strong> to accept or decline the requested session(s) below. If you do not respond, they will be automatically declined.</p>`
      + sessions(slots)
      + button('Review Request', link);
    if (row.teacher_email) {
      await sendEmail(cfg, { to: row.teacher_email, subject: 'Reminder: 1 hour left to respond to a booking request', html: wrap(cfg, inner) }, log);
    }
    await teacherDb.query(
      `update public.ta_booking_request_slots rs
          set sla_reminder_at = now()
         from public.ta_slots s
        where rs.slot_id = s.id and rs.request_id = $1 and s.teacher_id = $2
          and coalesce(rs.teacher_slot_status, 'pending') = 'pending' and rs.sla_reminder_at is null`,
      [row.request_id, row.teacher_id]);
    reminded++;
  }

  // 2) Expiry: auto-decline still-pending slots past the window.
  const exp = await teacherDb.query(
    `update public.ta_booking_request_slots rs
        set teacher_slot_status = 'rejected', sla_expired_at = now()
       from public.ta_slots s, public.ta_booking_requests r
      where rs.slot_id = s.id and rs.request_id = r.id
        and r.status = 'pending'
        and coalesce(rs.teacher_slot_status, 'pending') = 'pending'
        and r.created_at <= now() - (($1)::text || ' hours')::interval
     returning rs.request_id, s.teacher_id, s.teacher_name, s.day_of_week, s.start_time, s.end_time`,
    [ACCEPT_WINDOW_HOURS]);
  const expired = exp.rows.length;
  if (expired === 0) return { reminded, expired };

  const byReq = new Map<string, any[]>();
  const byReqTeacher = new Map<string, { teacher_id: string; teacher_name: string; slots: Slot[] }>();
  for (const r of exp.rows as any[]) {
    let arr = byReq.get(r.request_id);
    if (!arr) { arr = []; byReq.set(r.request_id, arr); }
    arr.push(r);
    const k = r.request_id + '|' + r.teacher_id;
    let g = byReqTeacher.get(k);
    if (!g) { g = { teacher_id: r.teacher_id, teacher_name: r.teacher_name, slots: [] }; byReqTeacher.set(k, g); }
    g.slots.push({ day_of_week: r.day_of_week, start_time: r.start_time, end_time: r.end_time, teacher_name: r.teacher_name });
  }

  for (const requestId of byReq.keys()) {
    const stt = await teacherDb.query(`select coalesce(teacher_slot_status, 'pending') as st from public.ta_booking_request_slots where request_id = $1`, [requestId]);
    const states = (stt.rows as any[]).map((x) => x.st as string);
    const allDecided = states.every((s) => s !== 'pending');
    const anyAccepted = states.some((s) => s === 'accepted');
    if (allDecided) {
      const summary = anyAccepted ? 'accepted' : 'declined';
      await teacherDb.query(`update public.ta_booking_requests set teacher_status = $2, teacher_decided_at = now() where id = $1 and teacher_status is distinct from $2`, [requestId, summary]);
    }
    const info = await teacherDb.query(`select parent_name, parent_email, student_name from public.ta_booking_requests where id = $1`, [requestId]);
    const req = (info.rows[0] as any) || {};
    const expiredSlots = (byReq.get(requestId) as any[]).map((x) => ({ day_of_week: x.day_of_week, start_time: x.start_time, end_time: x.end_time, teacher_name: x.teacher_name }));

    const adminTo = cfg.adminNotifyEmail || cfg.email.from;
    if (adminTo) {
      const outcome = allDecided ? (anyAccepted ? 'partially accepted; remainder auto-declined' : 'fully auto-declined') : 'some slots auto-declined; others still pending with other teachers';
      const inner = h2('Booking request expired')
        + preview('A teacher did not respond within 24 hours; the affected slots were auto-declined.')
        + `<p style="${P}">Student: <strong>${esc(req.student_name || '')}</strong><br>Parent: ${esc(req.parent_name || '')} — ${esc(req.parent_email || '')}<br>Request ID: ${esc(requestId)}<br>Outcome: ${outcome}</p>`
        + sessions(expiredSlots);
      await sendEmail(cfg, { to: adminTo, subject: `TeacherHub: booking request expired — ${req.student_name || 'student'}`, html: wrap(cfg, inner) }, log);
    }

    if (allDecided && !anyAccepted && req.parent_email) {
      const who = esc(req.student_name || 'your child');
      const parent = esc(req.parent_name || 'there');
      const inner = h2('Update on your booking request')
        + preview('We were not able to confirm the requested booking this time.')
        + `<p style="${P}">Hello ${parent},</p>`
        + `<p style="${P}">Thank you for your Concept Mastery booking request for ${who}. Unfortunately the requested times were not confirmed in time, so this request has now closed.</p>`
        + `<p style="${P}">Please submit new preferred times or contact our team and we will help you find the next available option.</p>`;
      await sendEmail(cfg, { to: req.parent_email, subject: 'Update on your Concept Mastery booking request', html: wrap(cfg, inner) }, log);
    }
  }

  for (const g of byReqTeacher.values()) {
    const tr = await teacherDb.query(`select email, name from public.ta_teachers where id = $1`, [g.teacher_id]);
    const email = (tr.rows[0] as any)?.email;
    if (!email) continue;
    const teacher = esc(g.teacher_name || (tr.rows[0] as any)?.name || 'there');
    const inner = h2('A booking request expired')
      + preview('These requested session(s) were auto-declined because they were not answered within 24 hours.')
      + `<p style="${P}">Hello ${teacher},</p>`
      + `<p style="${P}">The following requested session(s) have been automatically declined on your behalf because they were not accepted within the 24-hour window. If this was a mistake, please contact the office.</p>`
      + sessions(g.slots);
    await sendEmail(cfg, { to: email, subject: 'A booking request expired without your response', html: wrap(cfg, inner) }, log);
  }

  return { reminded, expired };
}

// Auto-release past one-time (demo / make-up) bookings. Recurring bookings are permanent; demo and
// make-up are a single occurrence, so once that occurrence's end time has passed the slot must free
// up again (status back to 'available'), exactly like a manual "release now". The occurrence is the
// first date on/after the booking date — in the teacher's own timezone — whose weekday matches the
// slot's day_of_week; if that end instant is before booked_at (slot booked later that same weekday)
// the following week's occurrence is used. Postgres `at time zone` keeps this DST-correct. Idempotent.
export async function releasePastOneTimeBookings(teacherDb: DB, log?: MiniLog): Promise<number> {
  const r = await teacherDb.query(
    `with cand as (
       select s.id,
              coalesce(nullif(s.iana_timezone, ''), 'Asia/Kolkata') as tz,
              s.booked_at, s.end_time,
              case s.day_of_week
                when 'Sunday' then 0 when 'Monday' then 1 when 'Tuesday' then 2 when 'Wednesday' then 3
                when 'Thursday' then 4 when 'Friday' then 5 when 'Saturday' then 6 end as target_dow
         from public.ta_slots s
        where s.status = 'booked'
          and coalesce(s.session_type, 'recurring') in ('demo','makeup')
          and s.booked_at is not null
          and s.end_time ~ '^[0-9]{1,2}:[0-9]{2}'
     ),
     occ as (
       select c.id, c.tz, c.booked_at, c.end_time,
              ((c.booked_at at time zone c.tz)::date
                + (((c.target_dow - extract(dow from (c.booked_at at time zone c.tz))::int) % 7 + 7) % 7)) as occ_date
         from cand c
        where c.target_dow is not null
     ),
     occ2 as (
       select o.id, o.booked_at,
              ((o.occ_date::text || ' ' || o.end_time)::timestamp at time zone o.tz) as occ_end
         from occ o
     ),
     due as (
       select id from occ2
        where (case when occ_end < booked_at then occ_end + interval '7 days' else occ_end end) < now()
     )
     update public.ta_slots s
        set status = 'available', booked_student = '', booked_note = null, booked_by = '',
            booked_at = null, booked_request_id = null, updated_at = now()
       from due
      where s.id = due.id
     returning s.id`);
  const n = r.rows.length;
  if (n > 0) log?.info?.({ released: n }, 'auto-released past one-time (demo/make-up) bookings');
  return n;
}
