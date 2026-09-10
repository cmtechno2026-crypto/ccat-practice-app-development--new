import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission, requireSuperAdmin } from '../plugins/adminAuth.js';
import { deriveAgeYears } from '../lib/age.js';
import { hashSecret } from '../security/crypto.js';

// Shared break-glass enrollment: revoke any active device + live sessions, then enroll the new device
// as the sole active one. Runs inside a caller-provided transaction so approve/direct share one path.
async function breakGlassEnroll(c: any, studentId: string, platform: string | null, deviceHash: string) {
  await c.query(`update ccat.student_devices set status='revoked', revoked_at=now(), revoked_reason='break_glass_replacement' where student_id=$1 and status='active'`, [studentId]);
  await c.query(`update ccat.auth_sessions set revoked_at=now(), revoked_reason='admin_break_glass' where student_id=$1 and revoked_at is null`, [studentId]);
  const d = await c.query(`insert into ccat.student_devices(student_id, device_hash, platform, status, enrolled_at, attestation_state) values ($1,$2,$3,'active',now(),'unknown') returning id`, [studentId, deviceHash, platform]);
  return d.rows[0]!.id as string;
}
async function auditLog(c: any, adminId: string, event: string, kind: string, id: string, reason: string | null) {
  await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,reason) values ($1,'admin',$2,$3,$4,$5)`, [adminId, event, kind, id, reason]);
}

// Student detail + device/lifecycle actions (Blueprint §5, §6, §7, §15, §16).
export function registerAdminStudentDetailRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };

  app.get('/v1/admin/students/:id/detail', guard, async (req) => {
    requirePermission(req, 'student.directory');
    const id = (req.params as any).id;
    const s = await db.query(`select s.*, g.grade_number, g.name grade_name from ccat.students s join ccat.grades g on g.id=s.grade_id where s.id=$1`, [id]);
    if (s.rows.length === 0) throw Errors.notFound('Student not found');
    const st = s.rows[0]!;
    const guardians = await db.query(`select gc.email, gc.phone, gc.email_verified_at, gc.phone_verified_at, sg.relationship, sg.is_primary
        from ccat.student_guardians sg join ccat.guardian_contacts gc on gc.id=sg.guardian_id where sg.student_id=$1`, [id]);
    const devices = await db.query(`select id, platform, status, enrolled_at, last_seen_at, revoked_at, revoked_reason from ccat.student_devices where student_id=$1 order by created_at desc`, [id]);
    const history = await db.query(`select from_status, to_status, reason_code, reason_text, effective_at,
        (select display_name from ccat.admin_profiles ap where ap.id=e.actor_admin_id) actor
        from ccat.student_status_events e where student_id=$1 order by effective_at desc limit 20`, [id]);
    const readiness = await db.query(`select readiness_pct, insufficient_data, band, computed_at from ccat.readiness_snapshots where student_id=$1 order by computed_at desc limit 1`, [id]);
    const progress = await db.query(`select progress_pct, completed_count, eligible_count, computed_at from ccat.student_progress_snapshots where student_id=$1 order by computed_at desc limit 1`, [id]);
    const sessions = await db.query(`select se.id, se.mode, se.state, se.started_at, se.terminal_at, r.score_correct, r.score_total, r.xp_awarded
        from ccat.sessions se left join ccat.session_results r on r.session_id=se.id where se.student_id=$1 order by se.started_at desc limit 8`, [id]);
    const consents = await db.query(`select policy_version, created_at from ccat.consents where student_id=$1 order by created_at desc`, [id]);
    const breakGlass = await db.query(`select r.id, r.platform, r.device_hash, r.verification_note, r.reference, r.created_at,
        (select display_name from ccat.admin_profiles ap where ap.id=r.requested_by) requested_by
        from ccat.student_break_glass_requests r where r.student_id=$1 and r.status='pending' order by r.created_at desc`, [id]);
    const gradeReq = await db.query(
      `select r.id, r.requested_grade_id, r.reason, r.created_at,
              cg.grade_number as current_grade_number, rg.grade_number as requested_grade_number
         from ccat.grade_change_requests r
         join ccat.grades cg on cg.id=r.current_grade_id
         join ccat.grades rg on rg.id=r.requested_grade_id
        where r.student_id=$1 and r.status='pending' order by r.created_at desc limit 1`, [id]);
    const streakRow = await db.query(
      `select case when last_active_day >= (now() at time zone $2)::date - 1 then current_streak else 0 end as current,
              longest_streak as longest, last_active_day
         from ccat.student_streaks where student_id=$1`, [id, st.timezone]);
    const streak = streakRow.rows[0]
      ? { current: Number(streakRow.rows[0].current), longest: Number(streakRow.rows[0].longest), last_active_day: streakRow.rows[0].last_active_day }
      : { current: 0, longest: 0, last_active_day: null };
    return {
      id: st.id, display_name: st.display_name, username: st.username_normalized,
      grade_number: st.grade_number, grade_name: st.grade_name, status: st.status, version: st.version,
      age_years: deriveAgeYears(st.birth_month, st.birth_year), birth_month: st.birth_month, birth_year: st.birth_year,
      timezone: st.timezone, xp_total: Number(st.cached_xp_total), coins: Number(st.cached_coin_balance),
      guardians: guardians.rows, devices: devices.rows, status_history: history.rows,
      readiness: readiness.rows[0] ?? null, progress: progress.rows[0] ?? null,
      recent_sessions: sessions.rows, consents: consents.rows, streak,
      break_glass_requests: breakGlass.rows,
      grade_change_request: gradeReq.rows[0] ?? null,
    };
  });

  // Edit student profile fields (STUDENTS — granular). Requires `student.update` (Super-Admin passes
  // via role). Optimistic concurrency via If-Match against students.version (same as status changes).
  // Only display_name and grade_id are editable here; grade is a plain FK, so changing it does NOT
  // touch sessions/results/answers/achievements — progress/history are preserved. Audited old→new.
  const editStudentSchema = z.object({
    display_name: z.string().trim().min(1).max(40).optional(),
    grade_id: z.string().uuid().optional(),
  }).refine((b) => b.display_name !== undefined || b.grade_id !== undefined, { message: 'Nothing to update' });
  app.patch('/v1/admin/students/:id', guard, async (req) => {
    requirePermission(req, 'student.update');
    const id = (req.params as any).id;
    const b = editStudentSchema.parse(req.body ?? {});
    const ifMatch = req.headers['if-match'];
    const expected = ifMatch !== undefined ? Number(String(ifMatch)) : undefined;
    if (expected !== undefined && !Number.isFinite(expected)) throw Errors.validation('If-Match must be the numeric student version');

    const out = await withTransaction(db, async (c) => {
      const cur = await c.query('select display_name, grade_id, version from ccat.students where id=$1 for update', [id]);
      if (cur.rows.length === 0) throw Errors.notFound('Student not found');
      const prev = cur.rows[0]!;
      if (expected !== undefined && Number(prev.version) !== expected)
        throw Errors.conflict('VERSION_CONFLICT', 'Student was modified by someone else — reload and retry.');

      // Validate the target grade exists and is selectable.
      if (b.grade_id !== undefined) {
        const g = await c.query('select 1 from ccat.grades where id=$1 and active and retired_at is null', [b.grade_id]);
        if (g.rows.length === 0) throw Errors.validation('Unknown or inactive grade');
      }
      const nextName = b.display_name ?? prev.display_name;
      const nextGrade = b.grade_id ?? prev.grade_id;
      const updated = await c.query(
        `update ccat.students set display_name=$2, grade_id=$3, version=version+1, updated_at=now()
          where id=$1 and version=$4 returning version, grade_id`,
        [id, nextName, nextGrade, prev.version],
      );
      if (updated.rows.length === 0) throw Errors.conflict('VERSION_CONFLICT', 'Student was modified by someone else — reload and retry.');
      await c.query(
        `insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value)
         values ($1,'admin','student.updated','student',$2,$3,$4)`,
        [req.admin!.adminId, id,
         JSON.stringify({ display_name: prev.display_name, grade_id: prev.grade_id }),
         JSON.stringify({ display_name: nextName, grade_id: nextGrade })],
      );
      // If this edit moved the grade to exactly what a PENDING grade-change request asked for, the admin
      // has effectively granted it — approve+close that request so the learner stops seeing "Pending"
      // (and it clears from the review queue/bell). Otherwise a direct edit leaves any request untouched.
      let resolvedRequest: string | null = null;
      if (nextGrade !== prev.grade_id) {
        const pend = await c.query(
          `update ccat.grade_change_requests
              set status='approved', reviewed_by=$2, decided_at=now()
            where student_id=$1 and status='pending' and requested_grade_id=$3
            returning id`,
          [id, req.admin!.adminId, nextGrade]);
        if (pend.rows.length > 0) {
          resolvedRequest = pend.rows[0]!.id as string;
          await c.query(
            `insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value,reason)
             values ($1,'admin','student.grade_change.approved','student',$2,$3,$4,'resolved_by_direct_edit')`,
            [req.admin!.adminId, id, JSON.stringify({ grade_id: prev.grade_id }), JSON.stringify({ grade_id: nextGrade })]);
        }
      }
      return { version: Number(updated.rows[0]!.version), grade_id: nextGrade, display_name: nextName, resolvedRequest };
    });
    return { id, display_name: out.display_name, grade_id: out.grade_id, version: out.version, resolved_grade_request: out.resolvedRequest };
  });

  // Pending grade-change requests queue (Admin → Students). Gated on the review authority.
  app.get('/v1/admin/students/grade-requests', guard, async (req) => {
    requirePermission(req, 'student.update');
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }).parse(req.query ?? {});
    const status = q.status ?? 'pending';
    const rows = await db.query(
      `select r.id, r.student_id, s.display_name as student_name, r.reason, r.status, r.created_at, r.decided_at,
              cg.grade_number as current_grade_number, rg.grade_number as requested_grade_number
         from ccat.grade_change_requests r
         join ccat.students s on s.id=r.student_id
         join ccat.grades cg on cg.id=r.current_grade_id
         join ccat.grades rg on rg.id=r.requested_grade_id
        where r.status=$1 order by r.created_at asc`, [status]);
    return { items: rows.rows };
  });

  // Approve a pending grade-change request — updates the student's grade AND closes the request in ONE
  // transaction. Grade is a plain FK, so no progress/history is affected. Rejection (below) leaves grade.
  app.post('/v1/admin/students/:id/grade-requests/:reqId/approve', guard, async (req) => {
    requirePermission(req, 'student.update');
    const id = (req.params as any).id; const reqId = (req.params as any).reqId;
    const out = await withTransaction(db, async (c) => {
      const rq = await c.query(
        `select id, requested_grade_id, current_grade_id from ccat.grade_change_requests
          where id=$1 and student_id=$2 and status='pending' for update`, [reqId, id]);
      if (rq.rows.length === 0) throw Errors.notFound('No pending grade-change request');
      const requested = rq.rows[0]!.requested_grade_id as string;
      const g = await c.query('select 1 from ccat.grades where id=$1 and active and retired_at is null', [requested]);
      if (g.rows.length === 0) throw Errors.validation('Requested grade is no longer selectable');
      const prev = await c.query('select grade_id from ccat.students where id=$1 for update', [id]);
      await c.query('update ccat.students set grade_id=$2, version=version+1, updated_at=now() where id=$1', [id, requested]);
      await c.query(`update ccat.grade_change_requests set status='approved', reviewed_by=$2, decided_at=now() where id=$1`, [reqId, req.admin!.adminId]);
      await c.query(
        `insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value)
         values ($1,'admin','student.grade_change.approved','student',$2,$3,$4)`,
        [req.admin!.adminId, id, JSON.stringify({ grade_id: prev.rows[0]?.grade_id ?? null }), JSON.stringify({ grade_id: requested })]);
      return { requested_grade_id: requested };
    });
    return { status: 'approved', grade_id: out.requested_grade_id };
  });

  // Reject a pending grade-change request — status only; the student's grade is unchanged.
  app.post('/v1/admin/students/:id/grade-requests/:reqId/reject', guard, async (req) => {
    requirePermission(req, 'student.update');
    const id = (req.params as any).id; const reqId = (req.params as any).reqId;
    const r = await db.query(
      `update ccat.grade_change_requests set status='rejected', reviewed_by=$3, decided_at=now()
        where id=$1 and student_id=$2 and status='pending' returning id`, [reqId, id, req.admin!.adminId]);
    if (r.rows.length === 0) throw Errors.notFound('No pending grade-change request');
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','student.grade_change.rejected','student',$2)`, [req.admin!.adminId, id]);
    return { status: 'rejected' };
  });

  // Aggregated pending requests across every kind the caller is authorised to act on — powers the
  // admin notification bell and the Students-directory row highlighting. Each kind is gated by its own
  // permission (super_admin holds all, since its permission set is the full catalog). Sorted newest-first.
  app.get('/v1/admin/notifications', guard, async (req) => {
    const perms = req.admin!.permissions;
    const out: Array<{ kind: string; id: string; student_id: string; student_name: string; created_at: string; summary: string }> = [];
    if (perms.has('student.update')) {
      const g = await db.query(
        `select r.id, r.student_id, s.display_name as student_name, r.created_at,
                cg.grade_number as current_grade_number, rg.grade_number as requested_grade_number
           from ccat.grade_change_requests r
           join ccat.students s on s.id=r.student_id
           join ccat.grades cg on cg.id=r.current_grade_id
           join ccat.grades rg on rg.id=r.requested_grade_id
          where r.status='pending'`);
      for (const x of g.rows) out.push({ kind: 'grade_change', id: x.id, student_id: x.student_id, student_name: x.student_name, created_at: x.created_at, summary: `Grade ${x.current_grade_number} → Grade ${x.requested_grade_number}` });
    }
    if (perms.has('deletion.support')) {
      const d = await db.query(
        `select dr.id, dr.student_id, s.display_name as student_name, dr.created_at, dr.reference
           from ccat.deletion_requests dr
           join ccat.students s on s.id=dr.student_id
          where dr.state='pending_deletion'`);
      for (const x of d.rows) out.push({ kind: 'deletion', id: x.id, student_id: x.student_id, student_name: x.student_name, created_at: x.created_at, summary: 'Account deletion — 30-day window' + (x.reference ? ` (${x.reference})` : '') });
    }
    if (perms.has('device.break_glass')) {
      const b = await db.query(
        `select r.id, r.student_id, s.display_name as student_name, r.created_at
           from ccat.student_break_glass_requests r
           join ccat.students s on s.id=r.student_id
          where r.status='pending'`);
      for (const x of b.rows) out.push({ kind: 'break_glass', id: x.id, student_id: x.student_id, student_name: x.student_name, created_at: x.created_at, summary: 'Break-glass device co-sign' });
    }
    out.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return { items: out, count: out.length };
  });

  // Break-glass device enrollment (§5.2) — bypasses guardian OTP, so it needs a Super-Admin signature.
  // Super signs directly; a non-super holder of device.break_glass files a co-sign request instead.
  const bgSchema = z.object({
    platform: z.string().optional(),
    device_hash: z.string().min(6),
    verification_note: z.string().min(10),
    reference: z.string().optional(),
  });
  app.post('/v1/admin/students/:id/device/break-glass', guard, async (req) => {
    requirePermission(req, 'device.break_glass');
    const id = (req.params as any).id;
    const b = bgSchema.parse(req.body ?? {});
    const s = await db.query('select id from ccat.students where id=$1', [id]);
    if (s.rows.length === 0) throw Errors.notFound('Student not found');
    if (req.admin!.role === 'super_admin') {
      const deviceId = await withTransaction(db, async (c) => {
        const did = await breakGlassEnroll(c, id, b.platform ?? null, b.device_hash);
        await auditLog(c, req.admin!.adminId, 'device.break_glass.enrolled', 'device', did, b.verification_note);
        return did;
      });
      return { enrolled: true, device_id: deviceId };
    }
    // Non-super: record a co-sign request for a Super-Admin to approve. Nothing is enrolled yet.
    const r = await withTransaction(db, async (c) => {
      const rr = await c.query(
        `insert into ccat.student_break_glass_requests(student_id,requested_by,platform,device_hash,verification_note,reference)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [id, req.admin!.adminId, b.platform ?? null, b.device_hash, b.verification_note, b.reference ?? null]);
      await auditLog(c, req.admin!.adminId, 'device.break_glass.requested', 'student', id, b.verification_note);
      return rr.rows[0]!.id as string;
    });
    return { status: 'pending_cosign', request_id: r };
  });

  // Super-Admin co-signs (approves) a pending break-glass request → performs the enrollment.
  app.post('/v1/admin/students/:id/device/break-glass/:reqId/approve', guard, async (req) => {
    requireSuperAdmin(req);
    const id = (req.params as any).id; const reqId = (req.params as any).reqId;
    const rq = await db.query(`select id, platform, device_hash from ccat.student_break_glass_requests where id=$1 and student_id=$2 and status='pending'`, [reqId, id]);
    if (rq.rows.length === 0) throw Errors.notFound('No pending break-glass request');
    const deviceId = await withTransaction(db, async (c) => {
      const did = await breakGlassEnroll(c, id, rq.rows[0]!.platform, rq.rows[0]!.device_hash);
      await c.query(`update ccat.student_break_glass_requests set status='approved', decided_by=$2, decided_at=now() where id=$1`, [reqId, req.admin!.adminId]);
      await auditLog(c, req.admin!.adminId, 'device.break_glass.approved', 'device', did, null);
      return did;
    });
    return { enrolled: true, device_id: deviceId };
  });

  // Super-Admin denies a pending break-glass request.
  app.post('/v1/admin/students/:id/device/break-glass/:reqId/deny', guard, async (req) => {
    requireSuperAdmin(req);
    const id = (req.params as any).id; const reqId = (req.params as any).reqId;
    const r = await db.query(`update ccat.student_break_glass_requests set status='denied', decided_by=$3, decided_at=now() where id=$1 and student_id=$2 and status='pending' returning id`, [reqId, id, req.admin!.adminId]);
    if (r.rows.length === 0) throw Errors.notFound('No pending break-glass request');
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','device.break_glass.denied','student',$2)`, [req.admin!.adminId, id]);
    return { denied: true };
  });

  // Revoke the student's enrolled device (§5) — also revokes app sessions.
  app.post('/v1/admin/students/:id/device/revoke', guard, async (req) => {
    requirePermission(req, 'device.revoke');
    const id = (req.params as any).id;
    const b = z.object({ reason: z.string().min(1) }).parse(req.body ?? {});
    const n = await withTransaction(db, async (c) => {
      const d = await c.query(`update ccat.student_devices set status='revoked', revoked_at=now(), revoked_reason=$2 where student_id=$1 and status='active' returning id`, [id, b.reason]);
      await c.query(`update ccat.auth_sessions set revoked_at=now(), revoked_reason='admin_device_revoke' where student_id=$1 and revoked_at is null`, [id]);
      if (d.rows.length > 0) await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value,reason) values ($1,'admin','device.revoked','device',$2,$3,$4,$5)`, [req.admin!.adminId, d.rows[0]!.id, JSON.stringify({ status: 'active' }), JSON.stringify({ status: 'revoked' }), b.reason]);
      return d.rows.length;
    });
    if (n === 0) throw Errors.validation('No active device to revoke');
    return { revoked: true };
  });

  // Reset a student's 4-digit login PIN (Blueprint §4.4, admin-assisted). Sets a new PIN, clears any
  // lockout, and revokes live sessions so the next sign-in uses the new PIN. Guardians can also
  // self-serve via /v1/recovery/pin. The plaintext PIN is never logged.
  app.post('/v1/admin/students/:id/reset-pin', guard, async (req) => {
    requirePermission(req, 'student.update');
    const id = (req.params as any).id;
    const b = z.object({ new_pin: z.string().regex(/^\d{4}$/), reference: z.string().optional() }).parse(req.body ?? {});
    const s = await db.query('select id from ccat.students where id=$1', [id]);
    if (s.rows.length === 0) throw Errors.notFound('Student not found');
    const pinHash = await hashSecret(b.new_pin, cfg.pinPepper);
    await withTransaction(db, async (c) => {
      const u = await c.query(`update ccat.student_credentials set pin_hash=$2, failed_attempts=0, locked_until=null where student_id=$1 returning student_id`, [id, pinHash]);
      if (u.rows.length === 0) await c.query(`insert into ccat.student_credentials(student_id, pin_hash) values ($1,$2)`, [id, pinHash]);
      await c.query(`update ccat.auth_sessions set revoked_at=now(), revoked_reason='admin_pin_reset' where student_id=$1 and revoked_at is null`, [id]);
      await auditLog(c, req.admin!.adminId, 'student.pin.reset', 'student', id, b.reference ?? null);
    });
    return { reset: true };
  });

  // Deletion support (§7) — guardian-authorized default; here admin records the request.
  app.post('/v1/admin/students/:id/deletion', guard, async (req) => {
    requirePermission(req, 'deletion.support');
    const id = (req.params as any).id;
    const b = z.object({ reference: z.string().optional() }).parse(req.body ?? {});
    const prev = await db.query('select status from ccat.students where id=$1', [id]);
    if (prev.rows.length === 0) throw Errors.notFound('Student not found');
    const r = await db.query(`insert into ccat.deletion_requests(student_id,requested_by_kind,actor_admin_id,reference,restore_deadline)
        values ($1,'admin_override',$2,$3, now() + interval '30 days') returning id`, [id, req.admin!.adminId, b.reference ?? null]);
    await db.query('update ccat.students set status=$2, version=version+1 where id=$1', [id, 'pending_deletion']);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value,reference) values ($1,'admin','student.deletion.requested','student',$2,$3,$4,$5)`, [req.admin!.adminId, id, JSON.stringify({ status: prev.rows[0]!.status }), JSON.stringify({ status: 'pending_deletion' }), b.reference ?? null]);
    return { id: r.rows[0]!.id, state: 'pending_deletion' };
  });

  // Cancel a pending deletion — restore the account to active within the 30-day window. Same authority
  // as recording a deletion (deletion.support). Errors if the account is not pending_deletion.
  app.post('/v1/admin/students/:id/restore', guard, async (req) => {
    requirePermission(req, 'deletion.support');
    const id = (req.params as any).id;
    const out = await withTransaction(db, async (c) => {
      const s = await c.query('select status from ccat.students where id=$1 for update', [id]);
      if (s.rows.length === 0) throw Errors.notFound('Student not found');
      if (s.rows[0]!.status !== 'pending_deletion') throw Errors.validation('Account is not pending deletion');
      await c.query('update ccat.students set status=$2, version=version+1, updated_at=now() where id=$1', [id, 'active']);
      const dr = await c.query(`update ccat.deletion_requests set state='restored', restored_at=now() where student_id=$1 and state='pending_deletion' returning id`, [id]);
      await c.query(
        `insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value)
         values ($1,'admin','student.deletion.cancelled','student',$2,'{"status":"pending_deletion"}'::jsonb,'{"status":"active"}'::jsonb)`,
        [req.admin!.adminId, id]);
      return { deletionRequestId: dr.rows[0]?.id ?? null };
    });
    return { status: 'active', restored: true, deletionRequestId: out.deletionRequestId };
  });

  // Purge / finalize deletion (§7.2 override path) — ADMIN-2.
  // A true hard-DELETE of the student row is IMPOSSIBLE by design: xp_transactions, coin_transactions,
  // student_achievements, student_status_events and consents are append-only (tg_forbid_mutation) yet
  // reference students(id) ON DELETE CASCADE, so deleting the row would attempt a DELETE on those rows
  // and the trigger raises. Erasure is therefore done by ANONYMIZE + TOMBSTONE: scrub reversible PII
  // from the mutable tables, keep the immutable ledger/audit history keyed by the (now opaque) UUID.
  // Irreversible → gated on the stronger `student.deletion.override` authority, not `deletion.support`.
  app.post('/v1/admin/students/:id/purge', guard, async (req) => {
    requirePermission(req, 'student.deletion.override');
    const id = (req.params as any).id;
    const b = z.object({ reference: z.string().optional() }).parse(req.body ?? {});
    const result = await withTransaction(db, async (c) => {
      const s = await c.query(`select status from ccat.students where id=$1 for update`, [id]);
      if (s.rows.length === 0) throw Errors.notFound('Student not found');
      if (s.rows[0]!.status !== 'pending_deletion')
        throw Errors.validation('Student must be in pending_deletion (request deletion first) before purge');

      // Guardians linked to this student — captured before we drop the linkage, so we can scrub any
      // that become orphaned (a guardian shared with another live student is left untouched).
      const guardians = (await c.query(`select guardian_id from ccat.student_guardians where student_id=$1`, [id])).rows.map((r) => r.guardian_id);

      // 1) Anonymize + tombstone the student row itself. Username tombstone stays unique (derived from id).
      await c.query(`update ccat.students set
          display_name='[deleted student]',
          username_normalized=('deleted_'||replace(id::text,'-',''))::citext,
          birth_month=1, birth_year=2000,
          active_avatar_stage_id=null, active_theme_id=null,
          status='purged', version=version+1
        where id=$1`, [id]);

      // 2) Drop reversible auth material + linkage (all mutable, no append-only trigger).
      await c.query(`update ccat.auth_sessions set revoked_at=now(), revoked_reason='student_purged' where student_id=$1 and revoked_at is null`, [id]);
      await c.query(`delete from ccat.auth_sessions where student_id=$1`, [id]);
      await c.query(`delete from ccat.student_devices where student_id=$1`, [id]);
      await c.query(`delete from ccat.student_credentials where student_id=$1`, [id]);
      await c.query(`delete from ccat.verification_challenges where student_id=$1`, [id]);
      await c.query(`delete from ccat.student_guardians where student_id=$1`, [id]);
      await c.query(`update ccat.data_export_requests set artifact_ref=null where student_id=$1`, [id]);

      // 3) Scrub guardian contacts that are no longer linked to ANY student. The check constraint
      //    requires email OR phone, so a non-PII tombstone email is set and phone is nulled.
      if (guardians.length)
        await c.query(`update ccat.guardian_contacts g set
            email=('deleted+'||g.id||'@invalid.local')::citext, phone=null,
            email_verified_at=null, phone_verified_at=null
          where g.id = any($1::uuid[])
            and not exists (select 1 from ccat.student_guardians sg where sg.guardian_id=g.id)`, [guardians]);

      // 4) Record the transition on the append-only history (INSERT is allowed; only UPDATE/DELETE are not).
      await c.query(`insert into ccat.student_status_events(student_id,from_status,to_status,reason_code,actor_admin_id,actor_kind,reference)
          values ($1,'pending_deletion','purged','deletion.purged',$2,'admin',$3)`, [id, req.admin!.adminId, b.reference ?? null]);

      // 5) Close the deletion request.
      const dr = await c.query(`update ccat.deletion_requests set state='purged', purged_at=now() where student_id=$1 and state='pending_deletion' returning id`, [id]);

      // 6) Audit — no PII in old/new_value.
      await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value,reference)
          values ($1,'admin','student.purged','student',$2,'{"status":"pending_deletion"}'::jsonb,'{"status":"purged"}'::jsonb,$3)`, [req.admin!.adminId, id, b.reference ?? null]);
      return { deletionRequestId: dr.rows[0]?.id ?? null };
    });
    return { purged: true, status: 'purged', deletionRequestId: result.deletionRequestId };
  });
}
