import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';
import { createSecureStorage, type StorageService } from '../services/storage.js';
import { rasterizeSource, sourceKindOf, watermarkPng } from '../lib/studyRender.js';

// Math Olympiad — STUDY MATERIAL admin API. View-only uploaded files (PDF / PPT / PPTX) that the
// curriculum restructure attaches to a chapter (or to none). Program='math', site='math', so it is
// invisible to CCAT/NGAT. Hard-block design (owner decision): the original file and the raw page
// images live only in the PRIVATE 'study-secure' bucket; the gateway rasterizes server-side and
// serves per-page images watermarked with the viewer's identity. Raw bytes never reach the browser.
const PROGRAM = 'math';
const SITE = 'math';

async function audit(db: DB, req: any, event: string, kind: string, id: string, reason: string | null) {
  await db.query(
    `insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,reason,request_id)
     values ($1,'admin',$2,$3,$4,$5,$6)`,
    [req.admin.adminId, event, kind, id, reason, req.id ?? null],
  );
}

function extFor(fileName: string | undefined, kind: 'pdf' | 'pptx'): string {
  const m = (fileName || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  if (m) return m[1]!.replace(/[^a-z0-9]/g, '');
  return kind === 'pdf' ? 'pdf' : 'pptx';
}

// Renders run SERIALLY in-process: LibreOffice is memory-heavy, so a single chain avoids OOM when
// several uploads land together. Each job is self-contained and updates its own row state.
let renderChain: Promise<void> = Promise.resolve();
function enqueueRender(job: () => Promise<void>) {
  renderChain = renderChain.then(job, job);
}

async function mapPool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, n), items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]!); }
  });
  await Promise.all(workers);
}

export function registerAdminStudyMaterialRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };
  const gate = (req: any) => { requirePermission(req, 'content.create'); };

  const secure: StorageService = createSecureStorage({
    driver: cfg.storageDriver,
    uploadsDir: cfg.uploadsDir,
    supabaseUrl: cfg.supabaseUrl,
    supabaseServiceKey: cfg.supabaseServiceKey,
    secureBucket: cfg.secureStorageBucket,
  });

  async function assertChapter(chapterId: string): Promise<void> {
    const r = await db.query(
      `select 1 from ccat.categories where id=$1 and program=$2 and site_id=$3 and track='curriculum' and active`,
      [chapterId, PROGRAM, SITE],
    );
    if (r.rows.length === 0) throw Errors.notFound('Chapter not found');
  }

  // Run the render pipeline for one material: fetch source → rasterize → upload page PNGs → mark ready.
  async function runRender(materialId: string): Promise<void> {
    try {
      const r = await db.query(
        `select sm.id, sm.source_kind, sm.pages_prefix, ca.storage_key
           from ccat.study_materials sm
           left join ccat.content_assets ca on ca.id = sm.asset_id
          where sm.id=$1`, [materialId]);
      const row = r.rows[0] as any;
      if (!row || !row.storage_key) throw new Error('source asset missing');
      const kind = (row.source_kind === 'pptx' ? 'pptx' : 'pdf') as 'pdf' | 'pptx';
      const src = await secure.get(row.storage_key);
      if (!src) throw new Error('source bytes missing from secure storage');
      const { pageCount, pages } = await rasterizeSource(src.bytes, kind);
      const prefix: string = row.pages_prefix || `study-pages/${materialId}/`;
      await mapPool(pages, 6, async (p) => {
        await secure.put(`${prefix}p-${p.index}.png`, p.png, 'image/png');
      });
      await db.query(
        `update ccat.study_materials set render_state='ready', page_count=$2, render_error=null, updated_at=now() where id=$1`,
        [materialId, pageCount]);
      app.log.info({ materialId, pageCount }, 'study-material render ok');
    } catch (e) {
      const msg = (e as Error)?.message?.slice(0, 500) ?? 'render failed';
      await db.query(
        `update ccat.study_materials set render_state='failed', render_error=$2, updated_at=now() where id=$1`,
        [materialId, msg]).catch(() => {});
      app.log.error({ materialId, err: msg }, 'study-material render failed');
    }
  }

  // ---- signed upload URL (prod): browser PUTs the raw file straight to the PRIVATE bucket, so the
  //      multi-MB bytes bypass the gateway's JSON body limit and never transit the student-data boundary.
  const uploadUrlSchema = z.object({
    file_name: z.string().trim().min(1).max(260),
    mime_type: z.string().trim().min(1).max(160),
  });
  app.post('/v1/admin/math/study-materials/upload-url', guard, async (req) => {
    gate(req);
    const b = uploadUrlSchema.parse(req.body);
    const kind = sourceKindOf(b.mime_type, b.file_name);
    if (!kind) throw Errors.validation('Only PDF, PPT, or PPTX files are supported');
    const key = `study-src/${randomUUID()}.${extFor(b.file_name, kind)}`;
    const signed = await secure.createSignedUploadUrl(key).catch(() => null);
    // signed==null → local/dev driver with no direct upload; client falls back to the inline base64 path.
    return { storage_key: key, source_kind: kind, upload_url: signed?.uploadUrl ?? null, mode: signed ? 'signed' : 'inline' };
  });

  // ---- register a material. Prod: pass storage_key from a completed signed upload. Dev/local: pass
  //      data_base64 (capped by the global 16 MB JSON parser). Kicks off async rasterization.
  const createSchema = z.object({
    grade_id: z.string().uuid(),
    chapter_id: z.string().uuid().nullish(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullish(),
    file_name: z.string().trim().min(1).max(260),
    mime_type: z.string().trim().min(1).max(160),
    byte_size: z.number().int().nonnegative().nullish(),
    storage_key: z.string().trim().min(1).max(300).nullish(),
    data_base64: z.string().min(1).nullish(),
  });
  app.post('/v1/admin/math/study-materials', { ...guard, bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    gate(req);
    const b = createSchema.parse(req.body);
    const kind = sourceKindOf(b.mime_type, b.file_name);
    if (!kind) throw Errors.validation('Only PDF, PPT, or PPTX files are supported');
    if (b.chapter_id) await assertChapter(b.chapter_id);

    // Resolve the source into the secure bucket. Signed path: bytes are already there. Inline path:
    // decode and put them now.
    let storageKey: string;
    let byteSize: number | null = b.byte_size ?? null;
    if (b.storage_key) {
      storageKey = b.storage_key;
    } else if (b.data_base64) {
      const raw = b.data_base64.includes(',') ? b.data_base64.slice(b.data_base64.indexOf(',') + 1) : b.data_base64;
      let bytes: Buffer;
      try { bytes = Buffer.from(raw, 'base64'); } catch { throw Errors.validation('File data is not valid base64'); }
      if (bytes.length === 0) throw Errors.validation('File data is empty');
      storageKey = `study-src/${randomUUID()}.${extFor(b.file_name, kind)}`;
      try { await secure.put(storageKey, bytes, b.mime_type); }
      catch (e) { throw Errors.validation(`Secure storage upload failed: ${(e as Error).message}`); }
      byteSize = bytes.length;
    } else {
      throw Errors.validation('Provide storage_key (after a signed upload) or data_base64');
    }

    const materialId = await withTransaction(db, async (c) => {
      const asset = await c.query(
        `insert into ccat.content_assets(storage_key,mime_type,byte_size,created_by)
         values ($1,$2,$3,$4) returning id`,
        [storageKey, b.mime_type, byteSize ?? 0, req.admin!.adminId]);
      const assetId = asset.rows[0]!.id as string;
      const m = await c.query(
        `insert into ccat.study_materials
           (program, site_id, grade_id, chapter_id, title, description, asset_id, file_name, mime_type,
            byte_size, source_kind, state, render_state, display_order, active, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft','processing',
            coalesce((select max(display_order)+1 from ccat.study_materials
                       where program=$1 and site_id=$2 and grade_id=$3),0), true, $12)
         returning id`,
        [PROGRAM, SITE, b.grade_id, b.chapter_id ?? null, b.title, b.description ?? null, assetId,
         b.file_name, b.mime_type, byteSize, kind, req.admin!.adminId]);
      const id = m.rows[0]!.id as string;
      await c.query('update ccat.study_materials set pages_prefix=$2 where id=$1', [id, `study-pages/${id}/`]);
      return id;
    });
    await audit(db, req, 'math.study_material.created', 'study_material', materialId, `${kind}/${b.title}`);
    enqueueRender(() => runRender(materialId));
    reply.code(202);
    return { id: materialId, render_state: 'processing' };
  });

  // ---- list (admin). chapter_id='none' → unassigned only; a uuid → that chapter; absent → all chapters.
  app.get('/v1/admin/math/study-materials', guard, async (req) => {
    gate(req);
    const q = req.query as { grade_id?: string; chapter_id?: string; state?: string };
    const chapterFilter = q.chapter_id === 'none' ? 'none' : (q.chapter_id ?? null);
    const { rows } = await db.query(
      `select sm.id, sm.title, sm.description, sm.chapter_id, c.name as chapter_name, sm.grade_id,
              sm.file_name, sm.mime_type, sm.byte_size, sm.source_kind, sm.page_count,
              sm.render_state, sm.render_error, sm.state, sm.display_order, sm.created_at, sm.updated_at
         from ccat.study_materials sm
         left join ccat.categories c on c.id = sm.chapter_id
        where sm.program=$1 and sm.site_id=$2 and sm.active
          and ($3::uuid is null or sm.grade_id=$3)
          and ( $4::text is null
                or ($4='none' and sm.chapter_id is null)
                or ($4<>'none' and sm.chapter_id = $4::uuid) )
          and ($5::text is null or sm.state=$5)
        order by sm.display_order, sm.created_at desc`,
      [PROGRAM, SITE, q.grade_id ?? null, chapterFilter, q.state ?? null]);
    return { materials: rows };
  });

  // ---- edit metadata / move between chapters (chapter_id: uuid to assign, null to unassign).
  const patchSchema = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullish(),
    chapter_id: z.string().uuid().nullable().optional(),
    display_order: z.number().int().optional(),
  });
  app.patch('/v1/admin/math/study-materials/:id', guard, async (req) => {
    gate(req);
    const id = (req.params as any).id as string;
    const b = patchSchema.parse(req.body);
    const owns = await db.query('select 1 from ccat.study_materials where id=$1 and program=$2 and site_id=$3', [id, PROGRAM, SITE]);
    if (owns.rows.length === 0) throw Errors.notFound('Study material not found');
    if (b.chapter_id) await assertChapter(b.chapter_id);
    const sets: string[] = []; const vals: any[] = [id]; let i = 2;
    if (b.title !== undefined) { sets.push(`title=$${i++}`); vals.push(b.title); }
    if (b.description !== undefined) { sets.push(`description=$${i++}`); vals.push(b.description); }
    if (b.chapter_id !== undefined) { sets.push(`chapter_id=$${i++}`); vals.push(b.chapter_id); }
    if (b.display_order !== undefined) { sets.push(`display_order=$${i++}`); vals.push(b.display_order); }
    if (sets.length === 0) return { id, unchanged: true };
    sets.push('updated_at=now()');
    const r = await db.query(`update ccat.study_materials set ${sets.join(', ')} where id=$1 returning id, title, chapter_id, state`, vals);
    await audit(db, req, 'math.study_material.updated', 'study_material', id, Object.keys(b).join(','));
    return r.rows[0];
  });

  // ---- publish / retire. Publish requires a successful render (page images exist).
  app.post('/v1/admin/math/study-materials/:id/publish', guard, async (req) => {
    gate(req);
    const id = (req.params as any).id as string;
    const r = await db.query(
      `select render_state from ccat.study_materials where id=$1 and program=$2 and site_id=$3 and active`,
      [id, PROGRAM, SITE]);
    if (r.rows.length === 0) throw Errors.notFound('Study material not found');
    if (r.rows[0]!.render_state !== 'ready') throw Errors.conflict('NOT_RENDERED', 'The file is still processing (or failed) — cannot publish yet.');
    await db.query(`update ccat.study_materials set state='published', updated_at=now() where id=$1`, [id]);
    await audit(db, req, 'math.study_material.published', 'study_material', id, null);
    return { id, state: 'published' };
  });
  app.post('/v1/admin/math/study-materials/:id/retire', guard, async (req) => {
    gate(req);
    const id = (req.params as any).id as string;
    const r = await db.query(
      `update ccat.study_materials set state='retired', updated_at=now()
        where id=$1 and program=$2 and site_id=$3 and active returning id`, [id, PROGRAM, SITE]);
    if (r.rows.length === 0) throw Errors.notFound('Study material not found');
    await audit(db, req, 'math.study_material.retired', 'study_material', id, null);
    return { id, state: 'retired' };
  });

  // ---- reprocess (re-run render for a stuck/failed material).
  app.post('/v1/admin/math/study-materials/:id/reprocess', guard, async (req) => {
    gate(req);
    const id = (req.params as any).id as string;
    const r = await db.query(
      `update ccat.study_materials set render_state='processing', render_error=null, updated_at=now()
        where id=$1 and program=$2 and site_id=$3 and active returning id`, [id, PROGRAM, SITE]);
    if (r.rows.length === 0) throw Errors.notFound('Study material not found');
    enqueueRender(() => runRender(id));
    await audit(db, req, 'math.study_material.reprocess', 'study_material', id, null);
    return { id, render_state: 'processing' };
  });

  // ---- delete (soft). Best-effort removal of the secure objects too.
  app.delete('/v1/admin/math/study-materials/:id', guard, async (req) => {
    gate(req);
    const id = (req.params as any).id as string;
    const r = await db.query(
      `select sm.page_count, sm.pages_prefix, ca.storage_key, ca.id as asset_id
         from ccat.study_materials sm left join ccat.content_assets ca on ca.id=sm.asset_id
        where sm.id=$1 and sm.program=$2 and sm.site_id=$3`, [id, PROGRAM, SITE]);
    if (r.rows.length === 0) throw Errors.notFound('Study material not found');
    const row = r.rows[0] as any;
    await db.query(`update ccat.study_materials set active=false, state='retired', updated_at=now() where id=$1`, [id]);
    // Fire-and-forget object cleanup; row removal is authoritative.
    (async () => {
      try {
        if (row.storage_key) await secure.delete(row.storage_key);
        const prefix: string = row.pages_prefix || `study-pages/${id}/`;
        const n = Number(row.page_count || 0);
        for (let p = 1; p <= n; p++) await secure.delete(`${prefix}p-${p}.png`).catch(() => {});
      } catch { /* best-effort */ }
    })();
    await audit(db, req, 'math.study_material.deleted', 'study_material', id, null);
    return { deleted: true };
  });

  // ---- admin page preview (watermarked, same pipeline as the student). Never serves the raw file.
  app.get('/v1/admin/math/study-materials/:id/pages/:n', guard, async (req, reply) => {
    gate(req);
    const id = (req.params as any).id as string;
    const n = Math.max(1, parseInt(String((req.params as any).n), 10) || 1);
    const r = await db.query(
      `select pages_prefix, page_count, render_state from ccat.study_materials
        where id=$1 and program=$2 and site_id=$3 and active`, [id, PROGRAM, SITE]);
    if (r.rows.length === 0) throw Errors.notFound('Study material not found');
    const row = r.rows[0] as any;
    if (row.render_state !== 'ready') throw Errors.conflict('NOT_RENDERED', 'Still processing.');
    if (n > Number(row.page_count || 0)) throw Errors.notFound('Page out of range');
    const prefix: string = row.pages_prefix || `study-pages/${id}/`;
    const obj = await secure.get(`${prefix}p-${n}.png`);
    if (!obj) throw Errors.notFound('Page image missing');
    const marked = await watermarkPng(obj.bytes, `ADMIN PREVIEW · ${String(req.admin!.adminId).slice(0, 8)}`);
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'private, no-store');
    return reply.send(marked);
  });
}
