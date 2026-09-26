import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { z } from 'zod';
import { makeAuthenticateAdmin, requirePermission, requireSite } from '../plugins/adminAuth.js';
import { AppError, Errors } from '../errors.js';
import { withTransaction } from '../db.js';

// Web Admin — Training management for the TeacherHub site. CRUD over public.ta_training_modules,
// which lives in the SEPARATE TeacherHub Supabase project reached through the teacher pool
// (TEACHER_DATABASE_URL). The TeacherHub app reads active modules; this admin surface authors them.
// Every route is gated by requirePermission('teacher.*') AND requireSite('teacher').
export function registerAdminTrainingRoutes(app: FastifyInstance, db: DB, cfg: Config, teacherDb: DB | null) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  function tdb(): DB {
    if (!teacherDb) throw new AppError(503, 'SITE_NOT_CONFIGURED', 'TeacherHub database is not configured (set TEACHER_DATABASE_URL).');
    return teacherDb;
  }

  // One quiz question: prompt, 2–6 options, a 0-based correct index that must point at a real option.
  const quizQuestion = z.object({
    q: z.string().trim().min(1).max(500),
    opts: z.array(z.string().trim().min(1).max(300)).min(2).max(6),
    answer: z.number().int().min(0),
  }).refine(v => v.answer < v.opts.length, { message: 'answer index out of range for opts', path: ['answer'] });
  const quizSchema = z.array(quizQuestion).max(20);

  const moduleBase = {
    title: z.string().trim().min(1).max(200),
    icon: z.string().trim().max(16).optional().nullable(),
    duration_mins: z.number().int().min(0).max(600).optional().nullable(),
    description: z.string().trim().max(1000).optional().nullable(),
    body_html: z.string().max(200000).optional().nullable(),
    quiz: quizSchema.optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
    active: z.boolean().optional(),
  };
  const createSchema = z.object(moduleBase);
  const updateSchema = z.object({
    title: moduleBase.title.optional(),
    icon: moduleBase.icon,
    duration_mins: moduleBase.duration_mins,
    description: moduleBase.description,
    body_html: moduleBase.body_html,
    quiz: quizSchema.optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
    active: z.boolean().optional(),
  });

  const SELECT = `select id, title, icon, duration_mins, description, body_html, quiz, sort_order, active,
                         created_at, updated_at, coalesce(jsonb_array_length(quiz), 0) as question_count
                    from public.ta_training_modules`;

  // List ALL modules (active + inactive) for the admin, ordered as teachers would see them.
  app.get('/v1/admin/training/modules', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.directory');
    requireSite(req, 'teacher');
    const { rows } = await tdb().query(`${SELECT} order by sort_order asc, id asc`);
    return { modules: rows };
  });

  // Create one module. sort_order defaults to the end of the list.
  app.post('/v1/admin/training/modules', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const b = createSchema.parse(req.body ?? {});
    let sort = b.sort_order;
    if (sort == null) {
      const { rows } = await tdb().query(`select coalesce(max(sort_order), -1) + 1 as next from public.ta_training_modules`);
      sort = rows[0]?.next ?? 0;
    }
    const { rows } = await tdb().query(
      `insert into public.ta_training_modules (title, icon, duration_mins, description, body_html, quiz, sort_order, active)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       returning id, title, icon, duration_mins, description, body_html, quiz, sort_order, active, created_at, updated_at`,
      [b.title, b.icon ?? '📘', b.duration_mins ?? 10, b.description ?? '', b.body_html ?? '',
       JSON.stringify(b.quiz ?? []), sort, b.active ?? true]);
    return { module: rows[0] };
  });

  // Update a module (any subset of fields).
  app.patch('/v1/admin/training/modules/:id', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw Errors.validation('Invalid module id');
    const b = updateSchema.parse(req.body ?? {});
    const sets: string[] = []; const vals: unknown[] = []; let i = 1;
    const put = (col: string, val: unknown, cast = '') => { sets.push(`${col} = $${i}${cast}`); vals.push(val); i++; };
    if (b.title !== undefined) put('title', b.title);
    if (b.icon !== undefined) put('icon', b.icon ?? '📘');
    if (b.duration_mins !== undefined) put('duration_mins', b.duration_mins ?? 10);
    if (b.description !== undefined) put('description', b.description ?? '');
    if (b.body_html !== undefined) put('body_html', b.body_html ?? '');
    if (b.quiz !== undefined) put('quiz', JSON.stringify(b.quiz), '::jsonb');
    if (b.sort_order !== undefined) put('sort_order', b.sort_order);
    if (b.active !== undefined) put('active', b.active);
    if (sets.length === 0) throw Errors.validation('No fields to update');
    vals.push(id);
    const { rows } = await tdb().query(
      `update public.ta_training_modules set ${sets.join(', ')} where id = $${i}
       returning id, title, icon, duration_mins, description, body_html, quiz, sort_order, active, created_at, updated_at`, vals);
    if (rows.length === 0) throw Errors.notFound('Module not found');
    return { module: rows[0] };
  });

  // Delete a module (progress rows cascade via FK ON DELETE CASCADE).
  app.delete('/v1/admin/training/modules/:id', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw Errors.validation('Invalid module id');
    const { rowCount } = await tdb().query(`delete from public.ta_training_modules where id = $1`, [id]);
    if (!rowCount) throw Errors.notFound('Module not found');
    return { deleted: id };
  });

  // Reorder: body { ids: [id,...] } in the desired display order → sets sort_order = position.
  const reorderSchema = z.object({ ids: z.array(z.number().int()).min(1).max(1000) });
  app.post('/v1/admin/training/modules/reorder', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const { ids } = reorderSchema.parse(req.body ?? {});
    await tdb().query(
      `update public.ta_training_modules m set sort_order = x.ord
         from (select unnest($1::int[]) as id, generate_subscripts($1::int[], 1) - 1 as ord) x
        where m.id = x.id`, [ids]);
    const { rows } = await tdb().query(`${SELECT} order by sort_order asc, id asc`);
    return { modules: rows };
  });

  // Bulk create (from the parsed .txt import). All-or-nothing in one transaction.
  const bulkSchema = z.object({ modules: z.array(createSchema).min(1).max(200) });
  app.post('/v1/admin/training/modules/bulk', { preHandler: [authenticateAdmin] }, async (req) => {
    requirePermission(req, 'teacher.slots.manage');
    requireSite(req, 'teacher');
    const { modules } = bulkSchema.parse(req.body ?? {});
    const created = await withTransaction(tdb(), async (client) => {
      const { rows } = await client.query(`select coalesce(max(sort_order), -1) + 1 as next from public.ta_training_modules`);
      let sort = rows[0]?.next ?? 0;
      const out: unknown[] = [];
      for (const m of modules) {
        const r = await client.query(
          `insert into public.ta_training_modules (title, icon, duration_mins, description, body_html, quiz, sort_order, active)
           values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) returning id, title, sort_order, active`,
          [m.title, m.icon ?? '📘', m.duration_mins ?? 10, m.description ?? '', m.body_html ?? '',
           JSON.stringify(m.quiz ?? []), m.sort_order ?? sort, m.active ?? true]);
        if (m.sort_order == null) sort++;
        out.push(r.rows[0]);
      }
      return out;
    });
    return { created: created.length, modules: created };
  });
}
