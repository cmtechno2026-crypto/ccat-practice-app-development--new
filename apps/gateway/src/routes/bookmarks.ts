import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { Errors } from '../errors.js';

const putSchema = z.object({ logical_question_id: z.string().uuid(), note: z.string().max(500).optional() });

export function registerBookmarkRoutes(app: FastifyInstance, db: DB) {
  // GET /v1/bookmarks — the student's bookmarked questions with a prompt preview + card metadata
  // (category, subcategory, difficulty, representative set name + question position, date) so a
  // client can render filters and a rich card (§32.4). Data-only; no answer key here.
  app.get('/v1/bookmarks', { preHandler: [app.authenticateStudent] }, async (req) => {
    const { rows } = await db.query(
      `select b.logical_question_id, b.note, b.created_at,
              cat.key as category_key, sub.name as subcategory,
              m.set_name, m.difficulty, m.position,
              (select qv.prompt_blocks from ccat.question_versions qv
                 where qv.logical_question_id = b.logical_question_id and qv.state = 'published'
                 order by qv.version_number desc limit 1) as prompt_blocks
         from ccat.bookmarks b
         join ccat.logical_questions lq on lq.id = b.logical_question_id
         join ccat.categories cat on cat.id = lq.category_id
         join ccat.subcategories sub on sub.id = lq.subcategory_id
         left join lateral (
            select qs.name as set_name, d.key as difficulty, svq.position
              from ccat.question_versions qv2
              join ccat.set_version_questions svq on svq.question_version_id = qv2.id and svq.active = true
              join ccat.question_set_versions sv on sv.id = svq.set_version_id and sv.state = 'published'
              join ccat.question_sets qs on qs.id = sv.question_set_id
              left join ccat.difficulties d on d.id = sv.difficulty_id
             where qv2.logical_question_id = b.logical_question_id and qv2.state = 'published'
             order by svq.position
             limit 1
         ) m on true
        where b.student_id = $1
        order by b.created_at desc`,
      [req.student!.studentId],
    );
    return rows.map((r) => ({
      logical_question_id: r.logical_question_id,
      note: r.note,
      created_at: r.created_at,
      category_key: r.category_key,
      subcategory: r.subcategory,
      difficulty: r.difficulty ?? null,
      set_name: r.set_name ?? null,
      position: r.position ?? null,
      preview: previewOf(r.prompt_blocks),
    }));
  });

  // GET /v1/bookmarks/:logicalQuestionId/review — the full published question payload for a
  // bookmarked question so the client can render an in-list review player that reveals the
  // correct answer + explanation. This deliberately EXPOSES correct_option_ids (unlike the
  // session flow) because review is post-hoc study, not a graded attempt — and it is gated to the
  // student's OWN bookmarks only (ownership check on ccat.bookmarks). Client-agnostic; mobile too.
  app.get('/v1/bookmarks/:logicalQuestionId/review', { preHandler: [app.authenticateStudent] }, async (req) => {
    const lqid = (req.params as { logicalQuestionId: string }).logicalQuestionId;
    const owns = await db.query(
      'select 1 from ccat.bookmarks where student_id = $1 and logical_question_id = $2',
      [req.student!.studentId, lqid],
    );
    if (owns.rows.length === 0) throw Errors.notFound('Bookmark not found');
    const q = await db.query(
      `select qv.question_type, qv.prompt_blocks, qv.option_blocks, qv.correct_option_ids, qv.explanation_blocks,
              cat.key as category_key, sub.name as subcategory,
              m.set_name, m.difficulty, m.position
         from ccat.question_versions qv
         join ccat.logical_questions lq on lq.id = qv.logical_question_id
         join ccat.categories cat on cat.id = lq.category_id
         join ccat.subcategories sub on sub.id = lq.subcategory_id
         left join lateral (
            select qs.name as set_name, d.key as difficulty, svq.position
              from ccat.set_version_questions svq
              join ccat.question_set_versions sv on sv.id = svq.set_version_id and sv.state = 'published'
              join ccat.question_sets qs on qs.id = sv.question_set_id
              left join ccat.difficulties d on d.id = sv.difficulty_id
             where svq.question_version_id = qv.id and svq.active = true
             order by svq.position limit 1
         ) m on true
        where qv.logical_question_id = $1 and qv.state = 'published'
        order by qv.version_number desc
        limit 1`,
      [lqid],
    );
    if (q.rows.length === 0) throw Errors.notFound('Question not found');
    const r = q.rows[0]!;
    return {
      logical_question_id: lqid,
      question_type: r.question_type,
      prompt_blocks: r.prompt_blocks,
      option_blocks: Array.isArray(r.option_blocks) ? r.option_blocks : [],
      correct_option_ids: r.correct_option_ids ?? [],
      explanation_blocks: r.explanation_blocks ?? null,
      category_key: r.category_key,
      subcategory: r.subcategory,
      difficulty: r.difficulty ?? null,
      set_name: r.set_name ?? null,
      position: r.position ?? null,
    };
  });

  // PUT /v1/bookmarks — add/update a bookmark (idempotent)
  app.put('/v1/bookmarks', { preHandler: [app.authenticateStudent] }, async (req) => {
    const body = putSchema.parse(req.body);
    // Guard: only bookmark a real logical question.
    const exists = await db.query('select 1 from ccat.logical_questions where id = $1', [body.logical_question_id]);
    if (exists.rows.length === 0) throw Errors.notFound('Question not found');
    await db.query(
      `insert into ccat.bookmarks(student_id, logical_question_id, note) values ($1,$2,$3)
       on conflict (student_id, logical_question_id) do update set note = excluded.note`,
      [req.student!.studentId, body.logical_question_id, body.note ?? null],
    );
    return { bookmarked: true, logical_question_id: body.logical_question_id };
  });

  // DELETE /v1/bookmarks?logical_question_id=...
  app.delete('/v1/bookmarks', { preHandler: [app.authenticateStudent] }, async (req, reply) => {
    const q = (req.query as { logical_question_id?: string }).logical_question_id;
    if (!q) throw Errors.validation('logical_question_id required');
    await db.query('delete from ccat.bookmarks where student_id = $1 and logical_question_id = $2', [req.student!.studentId, q]);
    reply.code(204);
    return null;
  });
}

function previewOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const text = blocks
    .map((b: any) => (b?.type === 'text' || b?.type === 'rich_text' || b?.type === 'math' ? String(b.value ?? '') : ''))
    .join(' ')
    .trim();
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
