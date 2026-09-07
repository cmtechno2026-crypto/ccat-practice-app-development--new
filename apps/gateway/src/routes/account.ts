import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { AppError, Errors } from '../errors.js';

// Gate 3B: authenticated account self-service — the learner acts on their OWN account directly
// (no guardian OTP, per product decision). Everything is owned-only (scoped to req.student.studentId).
// Editable surface: the learner's display name, their primary guardian's contact (email/phone/
// relationship), and a RECOVERABLE account deletion. Deletion reuses the existing deletion_requests
// model (30-day restore window; admin restore/purge) — no new deletion mechanism, no hard delete here.

const nameSchema = z.object({ display_name: z.string().trim().min(1).max(40) });
const guardianSchema = z.object({
  email: z.string().trim().email().max(200).optional(),
  phone: z.string().trim().min(4).max(40).optional(),
  relationship: z.string().trim().max(40).optional(),
}).refine((b) => b.email !== undefined || b.phone !== undefined || b.relationship !== undefined, {
  message: 'Nothing to update',
});

const gradeChangeSchema = z.object({
  requested_grade_id: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

async function primaryGuardian(db: DB, studentId: string): Promise<{ guardian_id: string; email: string | null; phone: string | null; relationship: string | null } | null> {
  const { rows } = await db.query(
    `select g.id as guardian_id, g.email, g.phone, sg.relationship
       from ccat.student_guardians sg
       join ccat.guardian_contacts g on g.id = sg.guardian_id
      where sg.student_id = $1
      order by sg.is_primary desc, sg.created_at asc
      limit 1`,
    [studentId],
  );
  return rows[0] ?? null;
}

export function registerAccountRoutes(app: FastifyInstance, db: DB) {
  // GET /v1/account — current editable values for the self-service forms (owned-only).
  app.get('/v1/account', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const me = await db.query('select display_name, username_normalized::text as username from ccat.students where id=$1', [sid]);
    if (me.rows.length === 0) throw Errors.notFound('Student not found');
    const g = await primaryGuardian(db, sid);
    return {
      display_name: me.rows[0]!.display_name,
      username: me.rows[0]!.username,
      guardian: g ? { email: g.email, phone: g.phone, relationship: g.relationship } : null,
    };
  });

  // PATCH /v1/account/name — rename self.
  app.patch('/v1/account/name', { preHandler: [app.authenticateStudent] }, async (req) => {
    const body = nameSchema.parse(req.body);
    const sid = req.student!.studentId;
    const prev = await db.query('select display_name from ccat.students where id=$1', [sid]);
    if (prev.rows.length === 0) throw Errors.notFound('Student not found');
    await db.query('update ccat.students set display_name=$2, version=version+1, updated_at=now() where id=$1', [sid, body.display_name]);
    await db.query(
      `insert into ccat.audit_log(actor_kind,event_type,target_kind,target_id,old_value,new_value) values ('student','student.self.name_changed','student',$1,$2,$3)`,
      [sid, JSON.stringify({ display_name: prev.rows[0]!.display_name }), JSON.stringify({ display_name: body.display_name })],
    );
    return { display_name: body.display_name };
  });

  // PATCH /v1/account/guardian — edit the primary guardian's contact + relationship. Changing the
  // email clears its verified flag (the address is now unconfirmed) — honest, and not an OTP gate.
  app.patch('/v1/account/guardian', { preHandler: [app.authenticateStudent] }, async (req) => {
    const body = guardianSchema.parse(req.body);
    const sid = req.student!.studentId;
    const g = await primaryGuardian(db, sid);
    if (!g) throw Errors.notFound('No guardian on file');
    // Guardian contact must always keep at least one channel (DB CHECK): block clearing the last one.
    const nextEmail = body.email !== undefined ? body.email : g.email;
    const nextPhone = body.phone !== undefined ? body.phone : g.phone;
    if (!nextEmail && !nextPhone) throw Errors.validation('Guardian must have an email or a phone.');
    if (body.email !== undefined || body.phone !== undefined) {
      await db.query(
        `update ccat.guardian_contacts
            set email=$2,
                phone=$3,
                email_verified_at = case when $2 is distinct from email then null else email_verified_at end,
                phone_verified_at = case when $3 is distinct from phone then null else phone_verified_at end,
                updated_at=now()
          where id=$1`,
        [g.guardian_id, nextEmail, nextPhone],
      );
    }
    if (body.relationship !== undefined) {
      await db.query('update ccat.student_guardians set relationship=$3 where student_id=$1 and guardian_id=$2', [sid, g.guardian_id, body.relationship]);
    }
    await db.query(
      `insert into ccat.audit_log(actor_kind,event_type,target_kind,target_id,new_value) values ('student','student.self.guardian_changed','student',$1,$2)`,
      [sid, JSON.stringify({ email: nextEmail, phone: nextPhone, relationship: body.relationship ?? g.relationship })],
    );
    return { email: nextEmail, phone: nextPhone, relationship: body.relationship ?? g.relationship };
  });

  // POST /v1/account/deletion — recoverable self-deletion. Sets the account to pending_deletion and
  // records a deletion_requests row with a 30-day restore window (admins can restore/purge). The
  // learner's next authenticated request will be rejected (ACCOUNT_NOT_ACTIVE), so the client signs
  // out after this returns. Idempotent: a second request while already pending returns the same state.
  app.post('/v1/account/deletion', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const s = await db.query('select status from ccat.students where id=$1', [sid]);
    if (s.rows.length === 0) throw Errors.notFound('Student not found');
    if (s.rows[0]!.status === 'pending_deletion') {
      const existing = await db.query(
        `select reference, restore_deadline from ccat.deletion_requests where student_id=$1 and state='pending_deletion' order by created_at desc limit 1`, [sid]);
      return { state: 'pending_deletion', reference: existing.rows[0]?.reference ?? null, restore_deadline: existing.rows[0]?.restore_deadline ?? null, already: true };
    }
    const refRow = await db.query(`select 'DEL-' || upper(substr(md5(gen_random_uuid()::text),1,6)) as ref`);
    const reference = refRow.rows[0]!.ref as string;
    const ins = await db.query(
      `insert into ccat.deletion_requests(student_id,requested_by_kind,reference,restore_deadline)
       values ($1,'self',$2, now() + interval '30 days') returning restore_deadline`,
      [sid, reference],
    );
    await db.query('update ccat.students set status=$2, version=version+1, updated_at=now() where id=$1', [sid, 'pending_deletion']);
    await db.query(
      `insert into ccat.audit_log(actor_kind,event_type,target_kind,target_id,old_value,new_value,reference) values ('student','student.self.deletion_requested','student',$1,$2,$3,$4)`,
      [sid, JSON.stringify({ status: s.rows[0]!.status }), JSON.stringify({ status: 'pending_deletion' }), reference],
    );
    return { state: 'pending_deletion', reference, restore_deadline: ins.rows[0]!.restore_deadline, already: false };
  });

  // GET /v1/account/grade-change — the learner's current grade-change request status (owned-only).
  // Returns the newest request (pending takes priority for display) plus the student's current grade,
  // so the web Profile can render "Pending", "Approved", or "Rejected" and gate a new submission.
  app.get('/v1/account/grade-change', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const me = await db.query(
      `select s.grade_id, g.grade_number as current_grade_number
         from ccat.students s join ccat.grades g on g.id = s.grade_id
        where s.id=$1`, [sid]);
    if (me.rows.length === 0) throw Errors.notFound('Student not found');
    const r = await db.query(
      `select r.id, r.status, r.reason, r.created_at, r.decided_at,
              cg.grade_number as current_grade_number,
              rg.grade_number as requested_grade_number
         from ccat.grade_change_requests r
         join ccat.grades cg on cg.id = r.current_grade_id
         join ccat.grades rg on rg.id = r.requested_grade_id
        where r.student_id=$1
        order by (r.status='pending') desc, r.created_at desc
        limit 1`, [sid]);
    return {
      current_grade_id: me.rows[0]!.grade_id,
      current_grade_number: me.rows[0]!.current_grade_number,
      request: r.rows[0] ?? null,
    };
  });

  // POST /v1/account/grade-change — the learner files a grade-change request. No direct grade update:
  // this records a pending request that an admin holding `student.update` reviews. Duplicate pending
  // requests are blocked (both here and by a partial unique index). Audited as an actor_kind='student'
  // event. Grade itself is untouched until an admin approves — progress/history are never affected.
  app.post('/v1/account/grade-change', { preHandler: [app.authenticateStudent] }, async (req) => {
    const body = gradeChangeSchema.parse(req.body);
    const sid = req.student!.studentId;
    const me = await db.query('select grade_id, status from ccat.students where id=$1', [sid]);
    if (me.rows.length === 0) throw Errors.notFound('Student not found');
    if (me.rows[0]!.status !== 'active') throw Errors.validation('Account is not active.');
    const currentGradeId = me.rows[0]!.grade_id as string;
    if (body.requested_grade_id === currentGradeId) {
      throw Errors.validation('Requested grade matches your current grade.');
    }
    const dup = await db.query(
      `select id from ccat.grade_change_requests where student_id=$1 and status='pending' limit 1`, [sid]);
    if (dup.rows.length > 0) {
      throw new AppError(409, 'GRADE_REQUEST_PENDING', 'You already have a grade-change request awaiting review.');
    }
    const g = await db.query('select id from ccat.grades where id=$1 and active = true and retired_at is null', [body.requested_grade_id]);
    if (g.rows.length === 0) throw Errors.validation('That grade is not available.');
    let ins;
    try {
      ins = await db.query(
        `insert into ccat.grade_change_requests(student_id,current_grade_id,requested_grade_id,reason)
         values ($1,$2,$3,$4)
         returning id, status, reason, created_at`,
        [sid, currentGradeId, body.requested_grade_id, body.reason ?? null],
      );
    } catch (e) {
      // Partial unique index (one pending per student) — race with a concurrent submit.
      if ((e as any)?.code === '23505') {
        throw new AppError(409, 'GRADE_REQUEST_PENDING', 'You already have a grade-change request awaiting review.');
      }
      throw e;
    }
    const row = ins.rows[0]!;
    await db.query(
      `insert into ccat.audit_log(actor_kind,event_type,target_kind,target_id,old_value,new_value)
       values ('student','student.self.grade_change_requested','student',$1,$2,$3)`,
      [sid,
       JSON.stringify({ grade_id: currentGradeId }),
       JSON.stringify({ requested_grade_id: body.requested_grade_id, request_id: row.id })],
    );
    return { id: row.id, status: row.status, reason: row.reason, created_at: row.created_at };
  });
}
