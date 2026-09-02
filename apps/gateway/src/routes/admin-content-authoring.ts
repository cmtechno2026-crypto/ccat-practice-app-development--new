import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';
import { createStorage } from '../services/storage.js';

// Content authoring extensions (Blueprint §17–§19): image assets, draft editing, version history,
// question-set authoring (create + membership + exam papers) and image asset upload. These
// complete the console's Content section on top of the existing question lifecycle routes.

async function audit(db: DB, req: any, event: string, kind: string, id: string | null, reason: string | null) {
  await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,reason,request_id)
    values ($1,'admin',$2,$3,$4,$5,$6)`, [req.admin.adminId, event, kind, id, reason, req.id ?? null]);
}

export function registerAdminContentAuthoringRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };
  const storage = createStorage({ driver: cfg.storageDriver, uploadsDir: cfg.uploadsDir });

  // ---- image assets ----------------------------------------------------------------------------
  // Assets back both content images and avatar/theme art, so either content.create or avatar.manage
  // may READ them (a super-admin holds all). The asset WRITE route (POST /v1/admin/content/assets)
  // is defined ONCE, in admin-content.ts (the canonical implementation: public_url + avatar_512
  // validation). It must NOT be duplicated here — a second declaration makes Fastify throw
  // FST_ERR_DUPLICATED_ROUTE at startup, which crashes the gateway before it can bind a port.
  const requireAssetAccess = (req: any) => {
    if (req.admin!.role === 'super_admin' || req.admin!.permissions.has('content.create') || req.admin!.permissions.has('avatar.manage')) return;
    throw Errors.forbidden('FORBIDDEN', 'Requires content.create or avatar.manage');
  };

  app.get('/v1/admin/content/assets/:id', guard, async (req, reply) => {
    requireAssetAccess(req);
    const id = (req.params as any).id;
    const r = await db.query('select storage_key, mime_type from ccat.content_assets where id=$1', [id]);
    if (r.rows.length === 0) throw Errors.notFound('Asset not found');
    const obj = await storage.get(r.rows[0]!.storage_key);
    if (!obj) throw Errors.notFound('Asset bytes missing');
    reply.header('content-type', r.rows[0]!.mime_type);
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(obj.bytes);
  });

  // ---- draft editing + version history ---------------------------------------------------------
  const editSchema = z.object({
    grade_id: z.string().uuid().optional(),
    difficulty_id: z.string().uuid().optional(),
    question_type: z.string().min(1).optional(),
    prompt_blocks: z.array(z.record(z.any())).min(1).optional(),
    option_blocks: z.array(z.object({ option_id: z.string(), content: z.array(z.any()) })).min(2).optional(),
    correct_option_ids: z.array(z.string()).min(1).optional(),
    explanation_blocks: z.array(z.record(z.any())).optional(),
  });
  app.patch('/v1/admin/content/questions/:id', guard, async (req) => {
    requirePermission(req, 'content.edit'); // editorial split (owner decision 3-a)
    const id = (req.params as any).id;
    const b = editSchema.parse(req.body ?? {});
    const cur = await db.query('select state, option_blocks, correct_option_ids from ccat.question_versions where id=$1', [id]);
    if (cur.rows.length === 0) throw Errors.notFound('Question not found');
    if (cur.rows[0]!.state !== 'draft') throw Errors.validation('Only draft questions can be edited. Approved/published versions are immutable — create a new version instead.');
    const opts = b.option_blocks ?? cur.rows[0]!.option_blocks;
    const correct = b.correct_option_ids ?? cur.rows[0]!.correct_option_ids;
    const optIds = new Set((opts as any[]).map((o: any) => o.option_id));
    if (!(correct as string[]).every((c) => optIds.has(c))) throw Errors.validation('correct_option_ids must reference option ids');
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    for (const [k, v] of Object.entries(b)) {
      sets.push(`${k}=$${i++}`);
      vals.push(k === 'correct_option_ids' ? (v as string[]) : (Array.isArray(v) ? JSON.stringify(v) : v));
    }
    if (sets.length === 0) return { updated: false };
    vals.push(id);
    await db.query(`update ccat.question_versions set ${sets.join(',')} where id=$${i}`, vals);
    await audit(db, req, 'content.question.edited', 'question_version', id, null);
    return { updated: true };
  });

  app.get('/v1/admin/content/questions/:id/versions', guard, async (req) => {
    requirePermission(req, 'content.create');
    const id = (req.params as any).id;
    const lq = await db.query('select logical_question_id from ccat.question_versions where id=$1', [id]);
    if (lq.rows.length === 0) throw Errors.notFound('Question not found');
    const rows = await db.query(
      `select qv.id, qv.version_number, qv.state, qv.created_at, qv.published_at,
              (select display_name from ccat.admin_profiles ap where ap.id=qv.created_by) author
         from ccat.question_versions qv where qv.logical_question_id=$1 order by qv.version_number desc`,
      [lq.rows[0]!.logical_question_id],
    );
    return { items: rows.rows };
  });

  // ---- question-set authoring (practice sets + exam papers) -------------------------------------
  // Set versions carry a hard 5–20 question bound at all times (schema constraint
  // set_versions_size_hard_bounds), so a set is created atomically with its questions — there is no
  // empty-draft state. Membership edits stay within 5–20 too.
  const createSetSchema = z.object({
    name: z.string().min(1),
    grade_id: z.string().uuid(),
    category_id: z.string().uuid(),
    subcategory_id: z.string().uuid(),
    difficulty_id: z.string().uuid().optional(),
    allowed_practice: z.boolean().default(true),
    allowed_exam: z.boolean().default(false),
    allowed_timers: z.array(z.string()).optional(),
    // Exam papers may start empty (built up per section). Static ceiling = 45 (Battery Combine); the
    // real per-subcategory limit is enforced at runtime below.
    question_version_ids: z.array(z.string().uuid()).max(45).default([]),
    duration_minutes: z.number().int().min(1).max(180).optional(), // exam papers only
  });
  app.post('/v1/admin/content/sets', guard, async (req) => {
    requirePermission(req, 'content.create');
    const b = createSetSchema.parse(req.body);
    // Enforce the target subcategory's max questions per set (45 for Combine, 15 otherwise).
    const capRow = await db.query('select coalesce(max_questions_per_set, 15) as maxq from ccat.subcategories where id = $1', [b.subcategory_id]);
    const maxq = Number(capRow.rows[0]?.maxq ?? 15);
    if (b.question_version_ids.length > maxq)
      throw Errors.validation(`This subcategory allows up to ${maxq} questions per set`, { code: 'SET_TOO_LARGE' });
    const timers = b.allowed_timers ?? (b.allowed_exam ? ['timed'] : ['untimed']);
    const setVersionId = await withTransaction(db, async (c) => {
      const qs = await c.query(
        `insert into ccat.question_sets(grade_id, category_id, subcategory_id, name, created_by)
         values ($1,$2,$3,$4,$5) returning id`,
        [b.grade_id, b.category_id, b.subcategory_id, b.name, req.admin!.adminId],
      );
      const sv = await c.query(
        `insert into ccat.question_set_versions(question_set_id, version_number, difficulty_id, allowed_practice, allowed_exam, allowed_timers, question_count, duration_minutes, state, created_by)
         values ($1,1,$2,$3,$4,$5,$6,$7,'draft',$8) returning id`,
        [qs.rows[0]!.id, b.difficulty_id ?? null, b.allowed_practice, b.allowed_exam, JSON.stringify(timers), b.question_version_ids.length, b.duration_minutes ?? null, req.admin!.adminId],
      );
      let pos = 1;
      for (const qvid of b.question_version_ids) {
        await c.query('insert into ccat.set_version_questions(set_version_id, question_version_id, position) values ($1,$2,$3)', [sv.rows[0]!.id, qvid, pos++]);
      }
      return sv.rows[0]!.id as string;
    });
    await audit(db, req, 'content.set.created', 'set_version', setVersionId, b.name);
    return { set_version_id: setVersionId, state: 'draft' };
  });

  app.get('/v1/admin/content/sets/:id', guard, async (req) => {
    requirePermission(req, 'content.create');
    const id = (req.params as any).id;
    const sv = await db.query(
      `select sv.id, sv.version_number, sv.state, sv.allowed_practice, sv.allowed_exam, sv.allowed_timers,
              sv.question_count, sv.duration_minutes, sv.preserve_order, sv.published_at, qs.grade_id, qs.name, g.grade_number,
              qs.category_id, qs.subcategory_id, cat.name category, sub.name subcategory
         from ccat.question_set_versions sv
         join ccat.question_sets qs on qs.id=sv.question_set_id
         join ccat.grades g on g.id=qs.grade_id
         join ccat.categories cat on cat.id=qs.category_id
         join ccat.subcategories sub on sub.id=qs.subcategory_id where sv.id=$1`, [id]);
    if (sv.rows.length === 0) throw Errors.notFound('Set not found');
    const qs = await db.query(
      `select q.question_version_id as id, q.position, q.active, qv.state, qv.prompt_blocks, d.key difficulty,
              c.name category, c.key category_key
         from ccat.set_version_questions q
         join ccat.question_versions qv on qv.id=q.question_version_id
         join ccat.difficulties d on d.id=qv.difficulty_id
         join ccat.logical_questions lq on lq.id=qv.logical_question_id
         join ccat.categories c on c.id=lq.category_id
        where q.set_version_id=$1 order by q.position`, [id]);
    return { ...sv.rows[0], questions: qs.rows.map((r) => ({ id: r.id, position: r.position, active: r.active, state: r.state, difficulty: r.difficulty, category: r.category, category_key: r.category_key, preview: previewText(r.prompt_blocks) })) };
  });

  // Patch a set/exam paper's editable header fields (name, exam duration, order policy).
  // name/duration are draft-agnostic; preserve_order changes student-facing serving order, so it is
  // draft-only (a published set version is immutable per §8.1 — clone to change it).
  app.patch('/v1/admin/content/sets/:id', guard, async (req) => {
    requirePermission(req, 'content.create');
    const id = (req.params as any).id;
    const b = z.object({
      name: z.string().min(1).optional(),
      duration_minutes: z.number().int().min(1).max(180).nullable().optional(),
      preserve_order: z.boolean().optional(),
    }).parse(req.body ?? {});
    const sv = await db.query('select question_set_id, state from ccat.question_set_versions where id=$1', [id]);
    if (sv.rows.length === 0) throw Errors.notFound('Set not found');
    if (b.preserve_order !== undefined && sv.rows[0]!.state !== 'draft')
      throw Errors.validation('Question order can only be changed while the set is a draft (§8.1)');
    if (b.duration_minutes !== undefined) await db.query('update ccat.question_set_versions set duration_minutes=$2 where id=$1', [id, b.duration_minutes]);
    if (b.preserve_order !== undefined) await db.query('update ccat.question_set_versions set preserve_order=$2 where id=$1', [id, b.preserve_order]);
    if (b.name !== undefined) await db.query('update ccat.question_sets set name=$2 where id=$1', [sv.rows[0]!.question_set_id, b.name]);
    await audit(db, req, 'content.set.updated', 'set_version', id, b.name ?? null);
    return { id };
  });

  // Toggle a single question's active flag within a draft set. Inactive members stay in the set list
  // but are excluded from new sessions and do not count toward the publish minimum.
  app.patch('/v1/admin/content/sets/:id/questions/:qid', guard, async (req) => {
    requirePermission(req, 'content.create');
    const id = (req.params as any).id;
    const qid = (req.params as any).qid;
    const b = z.object({ active: z.boolean() }).parse(req.body ?? {});
    const sv = await db.query('select state from ccat.question_set_versions where id=$1', [id]);
    if (sv.rows.length === 0) throw Errors.notFound('Set not found');
    if (sv.rows[0]!.state !== 'draft') throw Errors.validation('Only draft sets can change question activation');
    const r = await db.query('update ccat.set_version_questions set active=$3 where set_version_id=$1 and question_version_id=$2 returning question_version_id', [id, qid, b.active]);
    if (r.rows.length === 0) throw Errors.notFound('Question is not a member of this set');
    await audit(db, req, 'content.set.question.active', 'set_version', id, b.active ? 'activated' : 'deactivated');
    return { id: qid, active: b.active };
  });

  // Static ceiling = the largest allowed set (Battery Combine = 45); the real per-subcategory limit
  // (15 default, 45 for *_battery_combine) is enforced at runtime below against max_questions_per_set.
  const membershipSchema = z.object({ question_version_ids: z.array(z.string().uuid()).min(0).max(45) });
  app.post('/v1/admin/content/sets/:id/questions', guard, async (req) => {
    requirePermission(req, 'content.create');
    const id = (req.params as any).id;
    const b = membershipSchema.parse(req.body);
    const cur = await db.query('select state from ccat.question_set_versions where id=$1', [id]);
    if (cur.rows.length === 0) throw Errors.notFound('Set not found');
    if (cur.rows[0]!.state !== 'draft') throw Errors.validation('Only draft sets can change membership');
    // Enforce this subcategory's max questions per set (45 for Combine, 15 otherwise).
    const capRow = await db.query(
      `select coalesce(sub.max_questions_per_set, 15) as maxq
         from ccat.question_set_versions sv
         join ccat.question_sets qs on qs.id = sv.question_set_id
         join ccat.subcategories sub on sub.id = qs.subcategory_id
        where sv.id = $1`, [id]);
    const maxq = Number(capRow.rows[0]?.maxq ?? 15);
    if (b.question_version_ids.length > maxq)
      throw Errors.validation(`This subcategory allows up to ${maxq} questions per set`, { code: 'SET_TOO_LARGE' });
    await withTransaction(db, async (c) => {
      // Preserve per-question active flags across a membership edit: a question toggled inactive must
      // stay inactive when another question is added/removed (the mockup keeps that state).
      const prev = await c.query('select question_version_id from ccat.set_version_questions where set_version_id=$1 and active=false', [id]);
      const inactive = new Set(prev.rows.map((r) => r.question_version_id as string));
      // update count first so the hard bound is satisfied before rows change
      await c.query('update ccat.question_set_versions set question_count=$2 where id=$1', [id, b.question_version_ids.length]);
      await c.query('delete from ccat.set_version_questions where set_version_id=$1', [id]);
      let pos = 1;
      for (const qvid of b.question_version_ids) {
        await c.query('insert into ccat.set_version_questions(set_version_id, question_version_id, position, active) values ($1,$2,$3,$4)', [id, qvid, pos++, !inactive.has(qvid)]);
      }
    });
    await audit(db, req, 'content.set.membership', 'set_version', id, `${b.question_version_ids.length} questions`);
    return { question_count: b.question_version_ids.length };
  });

  // ---- Google-Forms-style batch authoring (CONTENT editor) --------------------------------------
  // One panel pass collects ONE or MANY question cards and saves them together. Creates new draft
  // questions and/or edits existing draft members, then rewrites membership + order + active flags in
  // a single transaction. Draft-set only. RBAC content.create, audited.
  //
  // scope_category_id: for an EXAM set the editor authors one BATTERY (= one CCAT category) at a time;
  // when set, only that category's members are replaced and the other two batteries are preserved. For
  // a practice set it is omitted and the whole membership is replaced.
  const authorCardSchema = z.object({
    id: z.string().uuid().optional(), // existing DRAFT member to update; omit to create a new draft
    category_id: z.string().uuid(),
    subcategory_id: z.string().uuid(),
    grade_id: z.string().uuid(),
    difficulty_id: z.string().uuid(),
    question_type: z.string().min(1),
    prompt_blocks: z.array(z.any()).min(1),
    option_blocks: z.array(z.object({ option_id: z.string().min(1), content: z.array(z.any()) })).min(2).max(6),
    correct_option_ids: z.array(z.string().min(1)).min(1),
    explanation_blocks: z.array(z.any()).nullable().optional(),
    active: z.boolean().default(true),
  });
  const authorSchema = z.object({ questions: z.array(authorCardSchema).min(1).max(60), scope_category_id: z.string().uuid().optional() });

  app.post('/v1/admin/content/sets/:id/author', guard, async (req) => {
    requirePermission(req, 'content.create');
    const id = (req.params as any).id;
    const b = authorSchema.parse(req.body);
    const sv = await db.query('select state from ccat.question_set_versions where id=$1', [id]);
    if (sv.rows.length === 0) throw Errors.notFound('Set not found');
    if (sv.rows[0]!.state !== 'draft') throw Errors.validation('Only draft sets can be authored — publish creates an immutable version (§8.1); copy to a new draft to change a published set.');
    // Structural validation per card: the answer key must reference existing option ids.
    for (const q of b.questions) {
      const ids = new Set(q.option_blocks.map((o) => o.option_id));
      if (!q.correct_option_ids.every((cid) => ids.has(cid))) throw Errors.validation('correct_option_ids must reference option ids on the same card');
    }
    const out = await withTransaction(db, async (c) => {
      const authored: string[] = []; const authoredActive: boolean[] = [];
      // NEW cards are batched (ids generated here so we don't depend on RETURNING order); EXISTING draft
      // cards (q.id) are updated individually (usually none in bulk). This turns ~3 round-trips PER question
      // into ~2 statements TOTAL — a 45-question set went from ~135 sequential queries (~21 s) to a handful,
      // so a 12-set bulk create finishes in seconds instead of minutes (and no longer outlives the token).
      const newCards: { lqId: string; qvId: string; q: typeof b.questions[number] }[] = [];
      for (const q of b.questions) {
        if (q.id) {
          const cur = await c.query('select state from ccat.question_versions where id=$1', [q.id]);
          if (cur.rows.length === 0) throw Errors.notFound('Question not found');
          if (cur.rows[0]!.state !== 'draft') throw Errors.validation('Only draft questions can be edited; a published version is immutable (create a new version).');
          await c.query(`update ccat.question_versions set grade_id=$2,difficulty_id=$3,question_type=$4,prompt_blocks=$5,option_blocks=$6,correct_option_ids=$7,explanation_blocks=$8 where id=$1`,
            [q.id, q.grade_id, q.difficulty_id, q.question_type, JSON.stringify(q.prompt_blocks), JSON.stringify(q.option_blocks), q.correct_option_ids, q.explanation_blocks ? JSON.stringify(q.explanation_blocks) : null]);
          authored.push(q.id); authoredActive.push(q.active);
        } else {
          const lqId = randomUUID(); const qvId = randomUUID();
          newCards.push({ lqId, qvId, q });
          authored.push(qvId); authoredActive.push(q.active);
        }
      }

      // Batch-insert the new logical questions, then their draft versions — one multi-row statement each.
      if (newCards.length) {
        const lqParams: unknown[] = [];
        const lqVals = newCards.map((n, i) => { const o = i * 4; lqParams.push(n.lqId, n.q.category_id, n.q.subcategory_id, req.admin!.adminId); return `($${o + 1},$${o + 2},$${o + 3},$${o + 4})`; }).join(',');
        await c.query(`insert into ccat.logical_questions(id,category_id,subcategory_id,created_by) values ${lqVals}`, lqParams);

        const qvParams: unknown[] = [];
        const qvVals = newCards.map((n, i) => {
          const o = i * 11;
          qvParams.push(n.qvId, n.lqId, n.q.grade_id, n.q.difficulty_id, n.q.question_type,
            JSON.stringify(n.q.prompt_blocks), JSON.stringify(n.q.option_blocks), n.q.correct_option_ids,
            n.q.explanation_blocks ? JSON.stringify(n.q.explanation_blocks) : null,
            JSON.stringify({ origin: 'human' }), req.admin!.adminId);
          return `($${o + 1},1,$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6}::jsonb,$${o + 7}::jsonb,$${o + 8}::text[],$${o + 9}::jsonb,'draft',$${o + 10}::jsonb,$${o + 11})`;
        }).join(',');
        await c.query(`insert into ccat.question_versions(id,version_number,logical_question_id,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,explanation_blocks,state,provenance,created_by) values ${qvVals}`, qvParams);
      }

      // Preserve other batteries when authoring a single one (exam papers).
      let keepIds: string[] = []; let keepActive: boolean[] = [];
      if (b.scope_category_id) {
        const existing = await c.query(
          `select svq.question_version_id id, svq.active from ccat.set_version_questions svq
             join ccat.question_versions qv on qv.id=svq.question_version_id
             join ccat.logical_questions lq on lq.id=qv.logical_question_id
            where svq.set_version_id=$1 and lq.category_id <> $2 order by svq.position`, [id, b.scope_category_id]);
        keepIds = existing.rows.map((r) => r.id as string); keepActive = existing.rows.map((r) => r.active as boolean);
      }
      const finalIds = [...keepIds, ...authored]; const finalActive = [...keepActive, ...authoredActive];
      await c.query('update ccat.question_set_versions set question_count=$2 where id=$1', [id, finalIds.length]);
      await c.query('delete from ccat.set_version_questions where set_version_id=$1', [id]);
      if (finalIds.length) {
        const svqParams: unknown[] = [];
        const svqVals = finalIds.map((qid, i) => { const o = i * 4; svqParams.push(id, qid, i + 1, finalActive[i]); return `($${o + 1},$${o + 2},$${o + 3},$${o + 4})`; }).join(',');
        await c.query(`insert into ccat.set_version_questions(set_version_id,question_version_id,position,active) values ${svqVals}`, svqParams);
      }
      return { authored, count: finalIds.length };
    });
    await audit(db, req, 'content.set.authored', 'set_version', id, `${b.questions.length} card(s), ${out.count} total`);
    return { set_version_id: id, question_version_ids: out.authored, question_count: out.count };
  });

  // ---- Scoped bulk import (CSV carries scope) ----------------------------------------------------
  // Import many practice questions in one call; EACH ROW names its own scope by NAME:
  //   grade (number), battery (Verbal/Quantitative/Non-verbal), category (subcategory under the
  //   battery), difficulty (Easy/Medium/Hard). The server resolves names -> ids against the LIVE
  //   taxonomy (never trusts client ids for scope), rejects rows whose scope can't be resolved or
  //   that are structurally invalid (with reasons), groups the good rows by scope, and creates fresh
  //   DRAFT practice set(s) per scope (split at the 20-question set cap). Nothing publishes — the
  //   admin publishes each draft from Content. RBAC content.create, audited. Manual only (no AI).
  const importRowSchema = z.object({
    grade: z.union([z.string(), z.number()]),
    battery: z.string(),
    category: z.string(),
    difficulty: z.string(),
    stem: z.string(),
    question_type: z.string().optional(),
    options: z.array(z.object({ text: z.string(), correct: z.boolean() })).min(1).max(6),
    explanation: z.string().optional(),
  });
  const importSchema = z.object({ rows: z.array(importRowSchema).min(1).max(500) });
  const SET_CAP = 20;

  app.post('/v1/admin/content/import', guard, async (req) => {
    requirePermission(req, 'content.create');
    const b = importSchema.parse(req.body);
    const norm = (s: string) => String(s ?? '').trim().toLowerCase();
    const key = (s: string) => norm(s).replace(/[\s-]+/g, '_'); // "Non-verbal" -> "non_verbal"
    const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

    // Live taxonomy for name resolution (scope is authoritative on the server).
    const grades = (await db.query(`select id, grade_number, lower(name) name from ccat.grades where active and retired_at is null`)).rows as any[];
    const cats = (await db.query(`select id, lower(key) key, lower(name) name from ccat.categories where active`)).rows as any[];
    const subs = (await db.query(`select id, category_id, lower(key) key, lower(name) name from ccat.subcategories where active`)).rows as any[];
    const diffs = (await db.query(`select id, lower(key) key, lower(name) name from ccat.difficulties`)).rows as any[];

    type Ready = { grade: any; cat: any; sub: any; diff: any; row: any; filled: { text: string; correct: boolean }[] };
    const rejected: { index: number; reasons: string[] }[] = [];
    const ready: Ready[] = [];
    b.rows.forEach((row, index) => {
      const reasons: string[] = [];
      const gnum = Number(String(row.grade).replace(/[^0-9]/g, ''));
      const grade = grades.find(g => g.grade_number === gnum || g.name === norm(String(row.grade)));
      if (!grade) reasons.push(`unknown grade "${row.grade}"`);
      const cat = cats.find(c => c.key === key(row.battery) || c.name === norm(row.battery));
      if (!cat) reasons.push(`unknown battery "${row.battery}"`);
      const sub = cat ? subs.find(s => s.category_id === cat.id && (s.key === key(row.category) || s.name === norm(row.category))) : null;
      if (cat && !sub) reasons.push(`unknown category "${row.category}" under ${row.battery}`);
      const diff = diffs.find(d => d.key === norm(row.difficulty) || d.name === norm(row.difficulty));
      if (!diff) reasons.push(`unknown difficulty "${row.difficulty}"`);
      const filled = row.options.filter(o => o.text.trim());
      if (!row.stem.trim()) reasons.push('missing stem');
      if (filled.length < 2) reasons.push('needs ≥2 options');
      if (!filled.some(o => o.correct)) reasons.push('needs a correct answer');
      if (reasons.length) rejected.push({ index, reasons });
      else ready.push({ grade, cat, sub, diff, row, filled });
    });

    // Group ready rows by resolved scope.
    const groups = new Map<string, Ready[]>();
    for (const r of ready) {
      const k = `${r.grade.id}|${r.cat.id}|${r.sub.id}|${r.diff.id}`;
      (groups.get(k) ?? (groups.set(k, []), groups.get(k)!)).push(r);
    }

    const out = await withTransaction(db, async (c) => {
      const sets: any[] = []; let imported = 0;
      for (const rows of groups.values()) {
        const { grade, cat, sub, diff } = rows[0]!;
        // Split into draft sets sized to THIS subcategory's max (45 for Combine, 15 otherwise), not a
        // hard-coded cap. Falls back to SET_CAP when the column is unavailable.
        const capRow = await c.query('select coalesce(max_questions_per_set, $2) as maxq from ccat.subcategories where id=$1', [sub.id, SET_CAP]);
        const grpCap = Math.max(1, Number(capRow.rows[0]?.maxq ?? SET_CAP));
        for (let start = 0; start < rows.length; start += grpCap) {
          const batch = rows.slice(start, start + grpCap);
          const part = Math.floor(start / grpCap);
          const name = `${cap(sub.name)} · ${cap(diff.name)}${part > 0 ? ` (part ${part + 1})` : ''}`;
          const qs = await c.query(
            `insert into ccat.question_sets(grade_id, category_id, subcategory_id, name, created_by)
             values ($1,$2,$3,$4,$5) returning id`,
            [grade.id, cat.id, sub.id, name, req.admin!.adminId]);
          const sv = await c.query(
            `insert into ccat.question_set_versions(question_set_id, version_number, difficulty_id, allowed_practice, allowed_exam, allowed_timers, question_count, state, created_by)
             values ($1,1,$2,true,false,'[{"type":"untimed"}]'::jsonb,$3,'draft',$4) returning id`,
            [qs.rows[0]!.id, diff.id, batch.length, req.admin!.adminId]);
          const setVersionId = sv.rows[0]!.id as string;
          let pos = 0;
          for (const r of batch) {
            const optionBlocks = r.filled.map((o, i) => ({ option_id: 'abcdef'[i], content: [{ type: 'text', value: o.text.trim() }] }));
            const correct = r.filled.map((o, i) => ({ o, id: 'abcdef'[i]! })).filter(z2 => z2.o.correct).map(z2 => z2.id);
            const lq = await c.query('insert into ccat.logical_questions(category_id,subcategory_id,created_by) values ($1,$2,$3) returning id', [cat.id, sub.id, req.admin!.adminId]);
            const qv = await c.query(
              `insert into ccat.question_versions(logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,explanation_blocks,state,provenance,created_by)
               values ($1,1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10) returning id`,
              [lq.rows[0]!.id, grade.id, diff.id, (r.row.question_type?.trim() || cat.key),
               JSON.stringify([{ type: 'text', value: r.row.stem.trim() }]),
               JSON.stringify(optionBlocks), correct,
               r.row.explanation?.trim() ? JSON.stringify([{ type: 'text', value: r.row.explanation.trim() }]) : null,
               JSON.stringify({ origin: 'human', via: 'bulk_import' }), req.admin!.adminId]);
            await c.query('insert into ccat.set_version_questions(set_version_id,question_version_id,position,active) values ($1,$2,$3,true)', [setVersionId, qv.rows[0]!.id, ++pos]);
            imported++;
          }
          sets.push({ set_version_id: setVersionId, name, grade: grade.grade_number, battery: cat.key, category: sub.name, difficulty: diff.key, question_count: batch.length });
        }
      }
      return { imported, sets };
    });
    await audit(db, req, 'content.bulk_import', 'set_version', null, `${out.imported} question(s) into ${out.sets.length} draft set(s); ${rejected.length} rejected`);
    return { imported: out.imported, sets: out.sets, rejected };
  });

  // Ensure a grade has its starter set of 3 empty DRAFT exam papers (Content FIX 2). Idempotent:
  // creates papers only up to 3 and only when the grade currently has NONE (so admin deletions are
  // respected — deleting down to 2 does not re-top-up). Admins can add more via createSet and delete
  // freely. Empty drafts carry no immutability constraint. RBAC content.create, audited.
  app.post('/v1/admin/content/exam-papers/scaffold', guard, async (req) => {
    requirePermission(req, 'content.create');
    const b = z.object({ grade_id: z.string().uuid() }).parse(req.body);
    const created = await withTransaction(db, async (c) => {
      const grade = await c.query('select id from ccat.grades where id=$1 and active and retired_at is null', [b.grade_id]);
      if (grade.rows.length === 0) throw Errors.notFound('Grade not found');
      const existing = await c.query(
        `select count(*)::int n from ccat.question_set_versions sv
           join ccat.question_sets qs on qs.id=sv.question_set_id
          where qs.grade_id=$1 and sv.allowed_exam=true`, [b.grade_id]);
      if (existing.rows[0]!.n > 0) return 0; // already has exam papers; nothing to scaffold
      const cat = await c.query(`select id from ccat.categories where key='verbal' and active limit 1`);
      const anchorCat = cat.rows[0]?.id ?? (await c.query('select id from ccat.categories order by display_order limit 1')).rows[0]?.id;
      const sub = await c.query('select id from ccat.subcategories where category_id=$1 order by display_order limit 1', [anchorCat]);
      if (!anchorCat || sub.rows.length === 0) throw Errors.validation('Taxonomy not ready — add a category/subcategory first');
      for (const label of ['A', 'B', 'C']) {
        const qs = await c.query('insert into ccat.question_sets(grade_id,category_id,subcategory_id,name,created_by) values ($1,$2,$3,$4,$5) returning id',
          [b.grade_id, anchorCat, sub.rows[0]!.id, `Exam Paper ${label}`, req.admin!.adminId]);
        await c.query(`insert into ccat.question_set_versions(question_set_id,version_number,difficulty_id,question_count,allowed_practice,allowed_exam,allowed_timers,duration_minutes,state,created_by)
           values ($1,1,null,0,false,true,'["timed"]'::jsonb,30,'draft',$2)`, [qs.rows[0]!.id, req.admin!.adminId]);
      }
      return 3;
    });
    if (created > 0) await audit(db, req, 'content.exam.scaffolded', 'grade', b.grade_id, `${created} starter exam papers`);
    return { created };
  });
}

function previewText(blocks: any): string {
  if (!Array.isArray(blocks)) return '';
  const t = blocks.map((b: any) => (b?.type === 'text' || b?.type === 'rich_text' || b?.type === 'math' ? String(b.value ?? '') : '')).join(' ').trim();
  return t.length > 90 ? t.slice(0, 87) + '…' : t;
}
