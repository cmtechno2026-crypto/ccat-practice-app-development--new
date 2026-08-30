import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';
import { signContentBlocks } from '../lib/assets.js';

// Content management (Blueprint §17, §18): questions + review + publish, sets, learning plans.
// Enforces the content state machine and the content.publish permission.

const blockArr = z.array(z.record(z.any()));
const createQuestionSchema = z.object({
  category_id: z.string().uuid(),
  subcategory_id: z.string().uuid(),
  grade_id: z.string().uuid(),
  difficulty_id: z.string().uuid(),
  question_type: z.string().min(1),
  prompt_blocks: blockArr.min(1),
  option_blocks: z.array(z.object({ option_id: z.string(), content: z.array(z.any()) })).min(2),
  correct_option_ids: z.array(z.string()).min(1),
  explanation_blocks: blockArr.optional(),
});
const reviewSchema = z.object({ decision: z.enum(['approved', 'rejected', 'changes_requested']), feedback: z.string().optional() });

export function registerAdminContentRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };

  // Taxonomy (for pickers)
  app.get('/v1/admin/content/taxonomy', guard, async () => {
    const cats = await db.query('select id,key,name from ccat.categories where active order by display_order');
    const subs = await db.query('select id,category_id,key,name from ccat.subcategories where active order by display_order');
    const diffs = await db.query('select id,key,name,weight from ccat.difficulties order by display_order');
    const grades = await db.query('select id,grade_number,name from ccat.grades where active and retired_at is null order by display_order');
    return { categories: cats.rows, subcategories: subs.rows, difficulties: diffs.rows, grades: grades.rows };
  });

  // Questions list (filter by state / grade / category)
  app.get('/v1/admin/content/questions', guard, async (req) => {
    requirePermission(req, 'content.create');
    const q = req.query as { state?: string; grade_id?: string; category_id?: string; search?: string; limit?: string; cursor?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 200);
    const offset = Math.max(Number(q.cursor ?? 0), 0);
    const search = q.search?.trim() ? `%${q.search.trim()}%` : null;
    const rows = await db.query(
      `select qv.id, qv.question_type, qv.state, qv.version_number, qv.published_at, qv.created_at,
              qv.prompt_blocks, cat.name category, cat.key category_key, sub.name subcategory, d.key difficulty, g.grade_number,
              (qv.provenance->>'origin') origin, count(*) over()::int matched
         from ccat.question_versions qv
         join ccat.logical_questions lq on lq.id = qv.logical_question_id
         join ccat.categories cat on cat.id = lq.category_id
         join ccat.subcategories sub on sub.id = lq.subcategory_id
         join ccat.difficulties d on d.id = qv.difficulty_id
         join ccat.grades g on g.id = qv.grade_id
        where ($1::text is null or qv.state::text = $1)
          and ($2::uuid is null or qv.grade_id = $2)
          and ($3::uuid is null or lq.category_id = $3)
          and ($4::text is null or qv.question_type ilike $4 or cat.name ilike $4 or sub.name ilike $4
               or qv.prompt_blocks::text ilike $4)
        order by qv.created_at desc limit $5 offset $6`,
      [q.state ?? null, q.grade_id ?? null, q.category_id ?? null, search, limit, offset],
    );
    const matched = rows.rows[0]?.matched ?? 0;
    return {
      matched,
      items: rows.rows.map(({ matched: _matched, ...r }) => ({ ...r, preview: preview(r.prompt_blocks) })),
      next_cursor: rows.rows.length === limit ? String(offset + limit) : null,
    };
  });

  app.get('/v1/admin/content/questions/:id', guard, async (req) => {
    requirePermission(req, 'content.create');
    const id = (req.params as any).id;
    const r = await db.query(`select qv.*, cat.name category, sub.name subcategory, d.key difficulty, g.grade_number
        from ccat.question_versions qv
        join ccat.logical_questions lq on lq.id=qv.logical_question_id
        join ccat.categories cat on cat.id=lq.category_id
        join ccat.subcategories sub on sub.id=lq.subcategory_id
        join ccat.difficulties d on d.id=qv.difficulty_id
        join ccat.grades g on g.id=qv.grade_id where qv.id=$1`, [id]);
    if (r.rows.length === 0) throw Errors.notFound('Question not found');
    const reviews = await db.query(`select review_stage, decision, feedback, created_at,
        (select display_name from ccat.admin_profiles ap where ap.id=cr.reviewer_id) reviewer
        from ccat.content_reviews cr where target_kind='question_version' and target_id=$1 order by created_at`, [id]);
    return {
      ...r.rows[0],
      prompt_blocks: signContentBlocks(r.rows[0]!.prompt_blocks, cfg.publicUrl, cfg.hmacSecret),
      option_blocks: Array.isArray(r.rows[0]!.option_blocks)
        ? r.rows[0]!.option_blocks.map((o: any) => ({ ...o, content: signContentBlocks(o.content, cfg.publicUrl, cfg.hmacSecret) }))
        : r.rows[0]!.option_blocks,
      explanation_blocks: signContentBlocks(r.rows[0]!.explanation_blocks, cfg.publicUrl, cfg.hmacSecret),
      reviews: reviews.rows,
    };
  });

  // Create a draft question (human-authored)
  app.post('/v1/admin/content/questions', guard, async (req) => {
    requirePermission(req, 'content.create');
    const b = createQuestionSchema.parse(req.body);
    // structural validation (schema §17): correct ids must exist among options
    const optIds = new Set(b.option_blocks.map(o => o.option_id));
    if (optIds.size !== b.option_blocks.length) throw Errors.validation('Option ids must be unique');
    if (!b.correct_option_ids.every(c => optIds.has(c))) throw Errors.validation('correct_option_ids must reference option ids');
    const id = await withTransaction(db, async (c) => {
      const scope = await c.query('select 1 from ccat.subcategories where id=$1 and category_id=$2 and active=true', [b.subcategory_id, b.category_id]);
      if (scope.rows.length === 0) throw Errors.validation('Subcategory does not belong to the selected category');
      const lq = await c.query('insert into ccat.logical_questions(category_id,subcategory_id,created_by) values ($1,$2,$3) returning id',
        [b.category_id, b.subcategory_id, req.admin!.adminId]);
      const qv = await c.query(
        `insert into ccat.question_versions(logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,explanation_blocks,state,provenance,created_by)
         values ($1,1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10) returning id`,
        [lq.rows[0]!.id, b.grade_id, b.difficulty_id, b.question_type, JSON.stringify(b.prompt_blocks), JSON.stringify(b.option_blocks), b.correct_option_ids, b.explanation_blocks ? JSON.stringify(b.explanation_blocks) : null, JSON.stringify({ origin: 'human' }), req.admin!.adminId]);
      return qv.rows[0]!.id as string;
    });
    await audit(db, req, 'content.question.created', 'question_version', id, b.question_type);
    return { id, state: 'draft' };
  });

  // Create the next editable version of an immutable question. Published sets keep their pinned
  // version; an admin deliberately places this new draft into a copied/new set before publishing it.
  app.post('/v1/admin/content/questions/:id/revise', guard, async (req) => {
    requirePermission(req, 'content.edit');
    const sourceId = (req.params as any).id;
    const id = await withTransaction(db, async (c) => {
      const src = await c.query('select * from ccat.question_versions where id=$1 for update', [sourceId]);
      if (src.rows.length === 0) throw Errors.notFound('Question not found');
      if (src.rows[0]!.state === 'draft') throw Errors.conflict('BAD_STATE', 'This question is already an editable draft');
      const next = await c.query('select coalesce(max(version_number),0)+1::int n from ccat.question_versions where logical_question_id=$1', [src.rows[0]!.logical_question_id]);
      const r = await c.query(
        `insert into ccat.question_versions(logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,explanation_blocks,accessibility,state,provenance,created_by)
         select logical_question_id,$2,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,explanation_blocks,accessibility,'draft',
                coalesce(provenance,'{}'::jsonb) || jsonb_build_object('revised_from',$1::text,'origin','human'),$3
           from ccat.question_versions where id=$1::uuid returning id`,
        [sourceId, next.rows[0]!.n, req.admin!.adminId],
      );
      return r.rows[0]!.id as string;
    });
    await audit(db, req, 'content.question.revised', 'question_version', id, `from ${sourceId}`);
    return { id, state: 'draft' };
  });

  // Drafts may be deleted only while unreferenced. Published history is retired, never deleted.
  app.delete('/v1/admin/content/questions/:id', guard, async (req) => {
    requirePermission(req, 'content.edit');
    const id = (req.params as any).id;
    await withTransaction(db, async (c) => {
      const cur = await c.query('select state, logical_question_id from ccat.question_versions where id=$1 for update', [id]);
      if (cur.rows.length === 0) throw Errors.notFound('Question not found');
      if (cur.rows[0]!.state !== 'draft') throw Errors.conflict('BAD_STATE', 'Only unreferenced drafts can be deleted; published questions are retired');
      const refs = await c.query('select 1 from ccat.set_version_questions where question_version_id=$1 limit 1', [id]);
      if (refs.rows.length) throw Errors.conflict('QUESTION_IN_SET', 'Remove the question from its draft set before deleting it');
      await c.query('delete from ccat.content_reviews where target_kind=\'question_version\' and target_id=$1', [id]);
      await c.query('delete from ccat.question_versions where id=$1', [id]);
      const left = await c.query('select 1 from ccat.question_versions where logical_question_id=$1 limit 1', [cur.rows[0]!.logical_question_id]);
      if (left.rows.length === 0) await c.query('delete from ccat.logical_questions where id=$1', [cur.rows[0]!.logical_question_id]);
    });
    await audit(db, req, 'content.question.deleted', 'question_version', id, null);
    return { deleted: true };
  });

  // Record a review decision (question-level or set expert review)
  app.post('/v1/admin/content/questions/:id/review', guard, async (req) => {
    requirePermission(req, 'content.review');
    const id = (req.params as any).id;
    const b = reviewSchema.parse(req.body);
    const cur = await db.query('select state from ccat.question_versions where id=$1', [id]);
    if (cur.rows.length === 0) throw Errors.notFound('Question not found');
    if (cur.rows[0]!.state === 'published' || cur.rows[0]!.state === 'retired') throw Errors.validation('Cannot review a published/retired version');
    await db.query(`insert into ccat.content_reviews(target_kind,target_id,review_stage,reviewer_id,decision,feedback)
        values ('question_version',$1,'question_review',$2,$3,$4)`, [id, req.admin!.adminId, b.decision, b.feedback ?? null]);
    const next = b.decision === 'approved' ? 'approved' : 'draft';
    await db.query('update ccat.question_versions set state=$2 where id=$1', [id, next]);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value,reason) values ($1,'admin','content.review.recorded','question_version',$2,$3,$4,$5)`,
      [req.admin!.adminId, id, JSON.stringify({ state: cur.rows[0]!.state }), JSON.stringify({ state: next }), b.decision]);
    return { state: next };
  });

  // Publish (immutable) — requires content.publish
  app.post('/v1/admin/content/questions/:id/publish', guard, async (req) => {
    requirePermission(req, 'content.publish');
    const id = (req.params as any).id;
    const cur = await db.query('select state from ccat.question_versions where id=$1', [id]);
    if (cur.rows.length === 0) throw Errors.notFound('Question not found');
    if (cur.rows[0]!.state !== 'approved') throw Errors.validation('Question must be approved before publish (§18)');
    await db.query(`update ccat.question_versions set state='published', published_at=now() where id=$1`, [id]);
    await audit(db, req, 'content.published', 'question_version', id, null);
    return { state: 'published' };
  });

  app.post('/v1/admin/content/questions/:id/retire', guard, async (req) => {
    requirePermission(req, 'content.retire');
    const id = (req.params as any).id;
    const referenced = await db.query(
      `select 1 from ccat.set_version_questions svq join ccat.question_set_versions sv on sv.id=svq.set_version_id
        where svq.question_version_id=$1 and svq.active=true and sv.state='published' limit 1`, [id]);
    if (referenced.rows.length) throw Errors.conflict('QUESTION_IN_PUBLISHED_SET', 'Retire the published set before retiring this question');
    const retired = await db.query(`update ccat.question_versions set state='retired', retired_at=now() where id=$1 and state='published' returning id`, [id]);
    if (retired.rows.length === 0) throw Errors.conflict('BAD_STATE', 'Only a published question can be retired');
    await audit(db, req, 'content.retired', 'question_version', id, null);
    return { state: 'retired' };
  });

  // Sets list + publish
  app.get('/v1/admin/content/sets', guard, async (req) => {
    requirePermission(req, 'content.create');
    const rows = await db.query(`select sv.id, qs.id set_id, qs.name, g.grade_number, cat.name category, qs.category_id,
        sub.name subcategory, qs.subcategory_id, d.key difficulty_key, sv.difficulty_id, sv.version_number,
        sv.question_count, sv.duration_minutes, sv.state, sv.allowed_practice, sv.allowed_exam, sv.published_at,
        coalesce(sv.published_at, sv.created_at) updated_at
        from ccat.question_set_versions sv
        join ccat.question_sets qs on qs.id=sv.question_set_id
        join ccat.grades g on g.id=qs.grade_id
        join ccat.categories cat on cat.id=qs.category_id
        join ccat.subcategories sub on sub.id=qs.subcategory_id
        left join ccat.difficulties d on d.id=sv.difficulty_id
        order by sv.created_at desc limit 400`);
    return { items: rows.rows };
  });
  app.post('/v1/admin/content/sets/:id/unpublish', guard, async (req) => {
    requirePermission(req, 'content.publish');
    const id = (req.params as any).id;
    // Take a published set DOWN. §8.1 immutability (enforced by the set_version_immutable trigger): a
    // published set_version may transition ONLY to 'retired' — never back to 'draft', because its
    // content must never change under students who already played it (score/audit integrity).
    // Retiring removes it from the student catalog, which filters state='published'. To put up an
    // edited version, copy the set → new draft → publish (POST /sets/:id/copy).
    const r = await db.query(`update ccat.question_set_versions set state='retired', retired_at=now() where id=$1 and state='published' returning id`, [id]);
    if (r.rows.length === 0) throw Errors.conflict('BAD_STATE', 'Only a published set can be unpublished');
    await audit(db, req, 'content.unpublished', 'set_version', id, null);
    return { state: 'retired' };
  });
  // Explicit retire endpoint used by both Admin set lists. It has the same immutable lifecycle
  // effect as unpublish, but is authorized by content.retire rather than content.publish.
  app.post('/v1/admin/content/sets/:id/retire', guard, async (req) => {
    requirePermission(req, 'content.retire');
    const id = (req.params as any).id;
    const r = await db.query(`update ccat.question_set_versions set state='retired', retired_at=now() where id=$1 and state='published' returning id`, [id]);
    if (r.rows.length === 0) throw Errors.conflict('BAD_STATE', 'Only a published set can be retired');
    await audit(db, req, 'content.retired', 'set_version', id, null);
    return { state: 'retired' };
  });
  // Copy a set → a new question_set (same grade/category/subcategory/difficulty) with a fresh
  // DRAFT version that duplicates the source version's question membership.
  app.post('/v1/admin/content/sets/:id/copy', guard, async (req) => {
    requirePermission(req, 'content.create');
    const id = (req.params as any).id;
    const src = await db.query(`select sv.id, sv.question_count, sv.allowed_practice, sv.allowed_exam, sv.allowed_timers,
        sv.duration_minutes, sv.preserve_order, sv.difficulty_id,
        qs.grade_id, qs.category_id, qs.subcategory_id, qs.name
        from ccat.question_set_versions sv join ccat.question_sets qs on qs.id=sv.question_set_id where sv.id=$1`, [id]);
    if (src.rows.length === 0) throw Errors.notFound('Set not found');
    const s = src.rows[0]!;
    const newId = await withTransaction(db, async (c) => {
      const nqs = await c.query(`insert into ccat.question_sets(grade_id,category_id,subcategory_id,name,created_by)
          values ($1,$2,$3,$4,$5) returning id`, [s.grade_id, s.category_id, s.subcategory_id, `${s.name} (copy)`, req.admin!.adminId]);
      const nsv = await c.query(`insert into ccat.question_set_versions(question_set_id,version_number,difficulty_id,question_count,allowed_practice,allowed_exam,allowed_timers,duration_minutes,preserve_order,state,created_by)
          values ($1,1,$2,$3,$4,$5,$6,$7,$8,'draft',$9) returning id`,
        [nqs.rows[0]!.id, s.difficulty_id, s.question_count, s.allowed_practice, s.allowed_exam, s.allowed_timers, s.duration_minutes, s.preserve_order, req.admin!.adminId]);
      await c.query(`insert into ccat.set_version_questions(set_version_id,question_version_id,position,active)
          select $1, question_version_id, position, active from ccat.set_version_questions where set_version_id=$2`, [nsv.rows[0]!.id, id]);
      return nsv.rows[0]!.id;
    });
    await audit(db, req, 'content.set.copied', 'set_version', newId, `from ${id}`);
    return { id: newId, state: 'draft' };
  });
  // Delete a DRAFT set version (published sets are retired, never deleted, for audit integrity).
  app.delete('/v1/admin/content/sets/:id', guard, async (req) => {
    requirePermission(req, 'content.create');
    const id = (req.params as any).id;
    const cur = await db.query('select state, question_set_id from ccat.question_set_versions where id=$1', [id]);
    if (cur.rows.length === 0) throw Errors.notFound('Set not found');
    if (cur.rows[0]!.state !== 'draft') throw Errors.conflict('BAD_STATE', 'Only a draft set can be deleted; published sets are retired');
    await withTransaction(db, async (c) => {
      await c.query('delete from ccat.set_version_questions where set_version_id=$1', [id]);
      await c.query('delete from ccat.question_set_versions where id=$1', [id]);
      const left = await c.query('select count(*)::int n from ccat.question_set_versions where question_set_id=$1', [cur.rows[0]!.question_set_id]);
      if (left.rows[0]!.n === 0) await c.query('delete from ccat.question_sets where id=$1', [cur.rows[0]!.question_set_id]);
    });
    await audit(db, req, 'content.set.deleted', 'set_version', id, null);
    return { deleted: true };
  });
  app.post('/v1/admin/content/sets/:id/publish', guard, async (req) => {
    requirePermission(req, 'content.publish');
    const id = (req.params as any).id;
    const blockText = (blocks: any): string => Array.isArray(blocks)
      ? blocks.map((x: any) => (x?.type === 'text' || x?.type === 'rich_text' || x?.type === 'math' ? String(x.value ?? '') : (x?.type === 'image' ? '[img]' : ''))).join(' ').trim() : '';
    await withTransaction(db, async (c) => {
      // The row lock serializes publication with membership edits. All checks and the state change
      // happen in the same transaction, so a set cannot be published from a stale membership view.
      const cur = await c.query(
        `select sv.state, sv.question_count, qs.grade_id
           from ccat.question_set_versions sv join ccat.question_sets qs on qs.id=sv.question_set_id
          where sv.id=$1 for update of sv`, [id]);
      if (cur.rows.length === 0) throw Errors.notFound('Set not found');
      if (!['draft', 'approved'].includes(cur.rows[0]!.state)) throw Errors.conflict('BAD_STATE', 'Only a draft or approved set can be published');
      const memberQs = await c.query(
        `select qv.id, qv.state, qv.grade_id, qv.prompt_blocks, qv.option_blocks, qv.correct_option_ids
           from ccat.set_version_questions svq join ccat.question_versions qv on qv.id=svq.question_version_id
          where svq.set_version_id=$1 and svq.active=true order by svq.position`, [id]);
      if (memberQs.rows.length !== cur.rows[0]!.question_count)
        throw Errors.validation('The active membership must exactly match question_count; remove inactive questions or reactivate them');
      if (memberQs.rows.length < 5 || memberQs.rows.length > 20)
        throw Errors.validation('A published set must contain 5–20 active questions (§18)');
      for (const q of memberQs.rows) {
        if (q.grade_id !== cur.rows[0]!.grade_id) throw Errors.validation('Every question must match the set grade');
        if (q.state === 'retired') throw Errors.validation('Retired questions cannot be published in a set');
        const opts = (q.option_blocks as any[]) || [];
        const ids = new Set(opts.map((o: any) => o.option_id));
        if (!blockText(q.prompt_blocks)) throw Errors.validation('Every question needs a stem before publish');
        if (opts.length < 2 || ids.size !== opts.length) throw Errors.validation('Every question needs at least 2 uniquely identified options');
        if (opts.some((o: any) => !blockText(o.content))) throw Errors.validation('Options cannot be empty');
        const correct = ((q.correct_option_ids as string[]) || []);
        if (correct.length < 1 || !correct.every((cid) => ids.has(cid))) throw Errors.validation('Every question needs a valid marked correct answer');
      }
      // Auto-approve on set publish (owner decision): admin-authored draft/approved member questions
      // become published (immutable) together with the set — the publishing admin's action is the
      // approval. Already-published members are left untouched.
      const promoted = await c.query(
        `update ccat.question_versions qv set state='published', published_at=now()
           from ccat.set_version_questions svq
          where svq.set_version_id=$1 and svq.active=true and svq.question_version_id=qv.id and qv.state in ('draft','approved')
          returning qv.id`, [id]);
      for (const r of promoted.rows)
        await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,new_value) values ($1,'admin','content.published','question_version',$2,$3)`,
          [req.admin!.adminId, r.id, JSON.stringify({ state: 'published', via: 'set_publish' })]);
      const invalid = await c.query(
        `select 1 from ccat.set_version_questions svq join ccat.question_versions qv on qv.id=svq.question_version_id
          where svq.set_version_id=$1 and svq.active=true and qv.state<>'published' limit 1`, [id]);
      if (invalid.rows.length) throw Errors.validation('Every active question must be publishable');
      const updated = await c.query(`update ccat.question_set_versions set state='published', published_at=now() where id=$1 and state in ('draft','approved') returning id`, [id]);
      if (updated.rows.length === 0) throw Errors.conflict('BAD_STATE', 'Set state changed while publishing');
      await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value) values ($1,'admin','content.published','set_version',$2,$3,$4)`,
        [req.admin!.adminId, id, JSON.stringify({ state: cur.rows[0]!.state }), JSON.stringify({ state: 'published', questions_promoted: promoted.rows.length })]);
    });
    return { state: 'published' };
  });

  // Learning plans (read)
  app.get('/v1/admin/content/learning-plans', guard, async (req) => {
    requirePermission(req, 'content.create');
    const rows = await db.query(`select lp.id plan_id, lp.name, g.grade_number, lpv.id version_id, lpv.version_number, lpv.is_active,
        (select count(*) from ccat.learning_plan_sets s where s.learning_plan_version_id=lpv.id)::int set_count
        from ccat.learning_plans lp
        join ccat.grades g on g.id=lp.grade_id
        join ccat.learning_plan_versions lpv on lpv.learning_plan_id=lp.id
        order by g.grade_number, lpv.version_number desc`);
    return { items: rows.rows };
  });
}

function preview(blocks: any): string {
  if (!Array.isArray(blocks)) return '';
  const t = blocks.map((b: any) => (b?.type === 'text' || b?.type === 'rich_text' || b?.type === 'math' ? String(b.value ?? '') : '')).join(' ').trim();
  return t.length > 90 ? t.slice(0, 87) + '…' : t;
}
async function audit(db: DB, req: any, event: string, kind: string, id: string, reason: string | null) {
  await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,reason,request_id)
    values ($1,'admin',$2,$3,$4,$5,$6)`, [req.admin.adminId, event, kind, id, reason, req.id ?? null]);
}
