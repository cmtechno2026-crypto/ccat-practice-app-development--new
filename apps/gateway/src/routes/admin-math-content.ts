import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';

// Math Olympiad — ADMIN-MANAGED content taxonomy (D2). Math content is its own program ('math')
// AND site ('math'); every row here is created with program='math', site_id='math', so it is
// invisible to all CCAT/NGAT queries. The admin builds the tree themselves: three TRACKS
// (curriculum | quiz | test), and under each, per GRADE, FOLDERS (categories) + SUBFOLDERS
// (subcategories) + SETS (question_sets). Gated requireSite('math') + content permissions.
const PROGRAM = 'math';
const SITE = 'math';
const TRACKS = ['curriculum', 'quiz', 'test'] as const;

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'folder';
}
function rand(n = 4): string { return Math.random().toString(36).slice(2, 2 + n); }

async function audit(db: DB, req: any, event: string, kind: string, id: string, reason: string | null) {
  await db.query(
    `insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,reason,request_id)
     values ($1,'admin',$2,$3,$4,$5,$6)`,
    [req.admin.adminId, event, kind, id, reason, req.id ?? null],
  );
}

export function registerAdminMathContentRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };
  // Math is a PROGRAM (like NGAT): gated by the content permission, no per-site grant required.
  const gate = (req: any) => { requirePermission(req, 'content.create'); };

  // Grades available to Math (shared grade table).
  app.get('/v1/admin/math/grades', guard, async (req) => {
    gate(req);
    const r = await db.query(
      `select id, grade_number, name from ccat.grades where active and retired_at is null order by display_order, grade_number`,
    );
    return { grades: r.rows };
  });

  // The Math content tree for one track + grade: folders -> subfolders + sets.
  app.get('/v1/admin/math/tree', guard, async (req) => {
    gate(req);
    const q = req.query as { track?: string; grade_id?: string };
    const track = (TRACKS as readonly string[]).includes(q.track ?? '') ? q.track! : 'curriculum';
    const gradeId = q.grade_id ?? null;
    // Tests & Quiz are FLAT in the admin (no folder panel): ensure one default
    // category per grade so Bulk add / Upload always have a target. Curriculum keeps real folders.
    if (gradeId && (track === 'test' || track === 'quiz')) {
      const defName = track === 'test' ? 'All test papers' : 'All quizzes';
      const existing = await db.query(
        `select 1 from ccat.categories where program=$1 and site_id=$2 and track=$3 and grade_id=$4 and active limit 1`,
        [PROGRAM, SITE, track, gradeId],
      );
      if (existing.rows.length === 0) {
        await db.query(
          `insert into ccat.categories (key, name, program, site_id, track, grade_id, display_order, active)
           values ($1,$2,$3,$4,$5,$6,0,true)`,
          [`math-${track}-all-${gradeId}`, defName, PROGRAM, SITE, track, gradeId],
        );
      }
    }
    // Run the three tree reads in parallel — one trans-Pacific round trip instead of three serial ones.
    const [cats, subs, sets] = await Promise.all([
      db.query(
        `select c.id, c.name, c.display_order,
                (select count(*) from ccat.subcategories s where s.category_id = c.id and s.active)::int subfolder_count
           from ccat.categories c
          where c.program = $1 and c.site_id = $2 and c.track = $3 and c.active
            and ($4::uuid is null or c.grade_id = $4)
          order by c.display_order, c.name`,
        [PROGRAM, SITE, track, gradeId],
      ),
      db.query(
        `select s.id, s.category_id, s.name, s.display_order
           from ccat.subcategories s
           join ccat.categories c on c.id = s.category_id
          where c.program = $1 and c.site_id = $2 and c.track = $3 and s.active
            and ($4::uuid is null or c.grade_id = $4)
          order by s.display_order, s.name`,
        [PROGRAM, SITE, track, gradeId],
      ),
      db.query(
        `select sv.id set_version_id, qs.id set_id, qs.name, qs.category_id, qs.subcategory_id,
                sv.state, sv.question_count, sv.allowed_practice, sv.allowed_exam,
                coalesce(sv.published_at, sv.created_at) updated_at
           from ccat.question_sets qs
           join ccat.question_set_versions sv on sv.question_set_id = qs.id
           join ccat.categories c on c.id = qs.category_id
          where c.program = $1 and c.site_id = $2 and c.track = $3
            and ($4::uuid is null or qs.grade_id = $4)
          order by (sv.state = 'retired'), sv.created_at asc`,
        [PROGRAM, SITE, track, gradeId],
      ),
    ]);
    const subsByCat: Record<string, any[]> = {};
    for (const s of subs.rows) (subsByCat[s.category_id] ??= []).push(s);
    const setsByCat: Record<string, any[]> = {};
    for (const s of sets.rows) (setsByCat[s.category_id] ??= []).push(s);
    const folders = cats.rows.map((c) => ({
      ...c,
      subfolders: subsByCat[c.id] ?? [],
      sets: setsByCat[c.id] ?? [],
    }));
    return { track, grade_id: gradeId, folders };
  });

  // Create a FOLDER (category) under a track + grade.
  const folderSchema = z.object({
    track: z.enum(TRACKS),
    grade_id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
  });
  app.post('/v1/admin/math/folders', guard, async (req) => {
    gate(req);
    const b = folderSchema.parse(req.body);
    const key = `math-${b.track}-${slug(b.name)}-${rand()}`;
    const r = await db.query(
      `insert into ccat.categories (key, name, program, site_id, track, grade_id, display_order, active)
       values ($1,$2,$3,$4,$5,$6, coalesce((select max(display_order)+1 from ccat.categories
                where program=$3 and site_id=$4 and track=$5 and grade_id=$6),0), true)
       returning id, name`,
      [key, b.name, PROGRAM, SITE, b.track, b.grade_id],
    );
    await audit(db, req, 'math.folder.created', 'category', r.rows[0]!.id, `${b.track}/${b.name}`);
    return r.rows[0];
  });

  // Create a SUBFOLDER (subcategory) under a folder.
  const subfolderSchema = z.object({ name: z.string().trim().min(1).max(120) });
  app.post('/v1/admin/math/folders/:categoryId/subfolders', guard, async (req) => {
    gate(req);
    const categoryId = (req.params as any).categoryId;
    const b = subfolderSchema.parse(req.body);
    const owns = await db.query('select 1 from ccat.categories where id=$1 and program=$2 and site_id=$3', [categoryId, PROGRAM, SITE]);
    if (owns.rows.length === 0) throw Errors.notFound('Folder not found');
    const key = `${slug(b.name)}-${rand()}`;
    const r = await db.query(
      `insert into ccat.subcategories (category_id, key, name, site_id, display_order, active)
       values ($1,$2,$3,$4, coalesce((select max(display_order)+1 from ccat.subcategories where category_id=$1),0), true)
       returning id, name, category_id`,
      [categoryId, key, b.name, SITE],
    );
    await audit(db, req, 'math.subfolder.created', 'subcategory', r.rows[0]!.id, b.name);
    return r.rows[0];
  });

  // Rename folder / subfolder.
  app.patch('/v1/admin/math/folders/:id', guard, async (req) => {
    gate(req);
    const id = (req.params as any).id;
    const b = subfolderSchema.parse(req.body);
    const r = await db.query(
      `update ccat.categories set name=$2, updated_at=now() where id=$1 and program=$3 and site_id=$4 returning id, name`,
      [id, b.name, PROGRAM, SITE]);
    if (r.rows.length === 0) throw Errors.notFound('Folder not found');
    await audit(db, req, 'math.folder.renamed', 'category', id, b.name);
    return r.rows[0];
  });
  app.patch('/v1/admin/math/subfolders/:id', guard, async (req) => {
    gate(req);
    const id = (req.params as any).id;
    const b = subfolderSchema.parse(req.body);
    const r = await db.query(
      `update ccat.subcategories s set name=$2, updated_at=now()
         from ccat.categories c where s.id=$1 and c.id=s.category_id and c.program=$3 and c.site_id=$4
       returning s.id, s.name`,
      [id, b.name, PROGRAM, SITE]);
    if (r.rows.length === 0) throw Errors.notFound('Subfolder not found');
    await audit(db, req, 'math.subfolder.renamed', 'subcategory', id, b.name);
    return r.rows[0];
  });

  // Delete an EMPTY folder / subfolder (no sets, no subfolders). Safe: refuses if non-empty.
  app.delete('/v1/admin/math/folders/:id', guard, async (req) => {
    gate(req);
    const id = (req.params as any).id;
    const owns = await db.query('select 1 from ccat.categories where id=$1 and program=$2 and site_id=$3', [id, PROGRAM, SITE]);
    if (owns.rows.length === 0) throw Errors.notFound('Folder not found');
    const hasSets = await db.query('select 1 from ccat.question_sets where category_id=$1 limit 1', [id]);
    const hasSubs = await db.query('select 1 from ccat.subcategories where category_id=$1 and active limit 1', [id]);
    if (hasSets.rows.length || hasSubs.rows.length)
      throw Errors.conflict('FOLDER_NOT_EMPTY', 'Move or delete its sets and subfolders first.');
    await db.query('update ccat.categories set active=false, updated_at=now() where id=$1', [id]);
    await audit(db, req, 'math.folder.deleted', 'category', id, null);
    return { deleted: true };
  });
  app.delete('/v1/admin/math/subfolders/:id', guard, async (req) => {
    gate(req);
    const id = (req.params as any).id;
    const owns = await db.query(
      `select 1 from ccat.subcategories s join ccat.categories c on c.id=s.category_id
        where s.id=$1 and c.program=$2 and c.site_id=$3`, [id, PROGRAM, SITE]);
    if (owns.rows.length === 0) throw Errors.notFound('Subfolder not found');
    const hasSets = await db.query('select 1 from ccat.question_sets where subcategory_id=$1 limit 1', [id]);
    if (hasSets.rows.length) throw Errors.conflict('SUBFOLDER_NOT_EMPTY', 'Move or delete its sets first.');
    await db.query('update ccat.subcategories set active=false, updated_at=now() where id=$1', [id]);
    await audit(db, req, 'math.subfolder.deleted', 'subcategory', id, null);
    return { deleted: true };
  });

  // Create an empty draft SET under a folder/subfolder. Questions are added later via the content
  // editor (same pipeline). quiz->practice, test->exam, curriculum->practice by default.
  const setSchema = z.object({
    grade_id: z.string().uuid(),
    category_id: z.string().uuid(),
    subcategory_id: z.string().uuid().nullish(),
    name: z.string().trim().min(1).max(160),
    track: z.enum(TRACKS),
  });
  app.post('/v1/admin/math/sets', guard, async (req) => {
    gate(req);
    const b = setSchema.parse(req.body);
    const cat = await db.query('select 1 from ccat.categories where id=$1 and program=$2 and site_id=$3', [b.category_id, PROGRAM, SITE]);
    if (cat.rows.length === 0) throw Errors.notFound('Folder not found');
    const isExam = b.track === 'test';
    const newId = await withTransaction(db, async (c) => {
      const qs = await c.query(
        `insert into ccat.question_sets (grade_id, category_id, subcategory_id, name, created_by, site_id)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [b.grade_id, b.category_id, b.subcategory_id ?? null, b.name, req.admin!.adminId, SITE]);
      const sv = await c.query(
        `insert into ccat.question_set_versions
           (question_set_id, version_number, difficulty_id, allowed_practice, allowed_exam, allowed_timers,
            question_count, duration_minutes, state, created_by, site_id)
         values ($1, 1, null, $2, $3, '[]'::jsonb, 0, null, 'draft', $4, $5) returning id`,
        [qs.rows[0]!.id, !isExam, isExam, req.admin!.adminId, SITE]);
      return sv.rows[0]!.id as string;
    });
    await audit(db, req, 'math.set.created', 'set_version', newId, `${b.track}/${b.name}`);
    return { id: newId, state: 'draft' };
  });
}
