import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';

// Student-facing help & support (Gate 4A). A student can file a "Report a problem" case, which
// lands in the SAME ccat.support_cases table admins already work from — no per-client store, no new
// backend concept. opened_by is an ADMIN column, so a student-filed case leaves it null and sets
// student_id; the admin console picks these up as open cases. FAQ content is static help text and
// lives in the client (presentation), so there is no FAQ endpoint here.

const reportSchema = z.object({
  category: z.string().trim().max(40).optional(),
  message: z.string().trim().min(4).max(1000),
});

// Human-readable, collision-checked case reference (e.g. SUP-3F9A2C).
async function newReference(db: DB): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const { rows } = await db.query(`select 'SUP-' || upper(substr(md5(gen_random_uuid()::text), 1, 6)) as ref`);
    const ref = rows[0]!.ref as string;
    const clash = await db.query('select 1 from ccat.support_cases where reference=$1', [ref]);
    if (clash.rows.length === 0) return ref;
  }
  throw new Error('Could not allocate a unique support reference');
}

export function registerSupportRoutes(app: FastifyInstance, db: DB) {
  // POST /v1/support/cases — file a problem report. Stored as an open support case owned by the
  // student; summary carries the (optionally category-tagged) report text. Never fabricates a ref.
  app.post('/v1/support/cases', { preHandler: [app.authenticateStudent] }, async (req) => {
    const body = reportSchema.parse(req.body);
    const sid = req.student!.studentId;
    const summary = body.category ? `[${body.category}] ${body.message}` : body.message;
    const reference = await newReference(db);
    const { rows } = await db.query(
      `insert into ccat.support_cases (student_id, opened_by, reference, summary, state)
       values ($1, null, $2, $3, 'open')
       returning reference, state, created_at`,
      [sid, reference, summary],
    );
    return rows[0];
  });

  // GET /v1/support/cases — the student's own submitted reports, newest first (owned-only).
  app.get('/v1/support/cases', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const { rows } = await db.query(
      `select reference, summary, state, created_at
         from ccat.support_cases where student_id=$1
        order by created_at desc limit 20`,
      [sid],
    );
    return rows;
  });
}
