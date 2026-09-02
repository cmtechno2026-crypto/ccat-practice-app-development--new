import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors, AppError } from '../errors.js';
import { createStorage } from '../services/storage.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';

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

// Canonical avatar image spec (§20). Avatar art must be a SQUARE PNG at exactly 512×512 so it renders
// crisply at every avatar size on the student website without distortion. Enforced server-side (below);
// the admin UI applies the same rule client-side for a friendly message.
const AVATAR_PX = 512;
const AVATAR_MAX_BYTES = 3 * 1024 * 1024; // 3 MB — generous for a 512² PNG, blocks accidental huge uploads
// Question / option figures: PNG, JPG, or WEBP only (SVG disallowed — no sanitizer), capped at 2 MB.
const QIMAGE_MAX_BYTES = 2 * 1024 * 1024;
const QIMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// Bulk-add batch upload (many figures in ONE request). Named, tunable limits — the admin splits large
// uploads into ~8 MB chunks client-side; the work is per-image storage round-trips, so uploads run with
// BOUNDED concurrency and the content_assets rows land in ONE multi-row insert.
const BATCH_MAX_IMAGES = 400;                    // images per request
const BATCH_MAX_IMAGE_BYTES = 3 * 1024 * 1024;   // ≤ 3 MB per image (png/jpg/jpeg/webp)
const BATCH_TOTAL_MAX_BYTES = 50 * 1024 * 1024;  // ≤ 50 MB decoded per request
const STORAGE_UPLOAD_CONCURRENCY = 10;           // bounded concurrent storage puts (avoid rate-limiting)

// Run `fn` over `items` with at most `limit` promises in flight at once (bounded concurrency). Order preserved.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

// PNG signature + IHDR width/height. Returns null when the bytes are not a valid PNG.
function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null;
  // First chunk must be IHDR ('IHDR' = 49 48 44 52 at offset 12).
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function registerAdminContentRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };
  // Asset storage driver (local disk for dev; Supabase Storage in prod so uploads survive Render's
  // ephemeral disk). Selected by cfg.storageDriver; see services/storage.ts.
  const storage = createStorage({
    driver: cfg.storageDriver,
    uploadsDir: cfg.uploadsDir,
    supabaseUrl: cfg.supabaseUrl,
    supabaseServiceKey: cfg.supabaseServiceKey,
    storageBucket: cfg.storageBucket,
  });

  // Upload a content asset (avatar art, question images). Body: base64 payload + mime. When
  // constraint='avatar_512' the image is held to the canonical avatar spec (PNG, square 512×512).
  // The object is written to persistent storage and a content_asset row is created carrying a stable
  // public URL (absolute for Supabase; the Gateway's own /v1/assets/:id route for local disk).
  const assetSchema = z.object({
    mime_type: z.string().min(1),
    data_base64: z.string().min(1),
    alt_text: z.string().max(500).optional(),
    constraint: z.enum(['avatar_512']).optional(),
  });
  app.post('/v1/admin/content/assets', guard, async (req) => {
    const b = assetSchema.parse(req.body);
    const isAvatar = b.constraint === 'avatar_512';
    // Avatar art is managed under avatar.manage; other content images under content.create.
    requirePermission(req, isAvatar ? 'avatar.manage' : 'content.create');

    // Decode (tolerate an accidental data: URL prefix from a client).
    const raw = b.data_base64.includes(',') ? b.data_base64.slice(b.data_base64.indexOf(',') + 1) : b.data_base64;
    let bytes: Buffer;
    try { bytes = Buffer.from(raw, 'base64'); } catch { throw Errors.validation('Image data is not valid base64'); }
    if (bytes.length === 0) throw Errors.validation('Image data is empty');

    let width: number | null = null;
    let height: number | null = null;
    if (isAvatar) {
      if (b.mime_type !== 'image/png') throw Errors.validation('Avatar art must be a PNG image');
      if (bytes.length > AVATAR_MAX_BYTES) throw Errors.validation('Avatar image is too large (max 3 MB)');
      const dim = pngDimensions(bytes);
      if (!dim) throw Errors.validation('Avatar art must be a valid PNG file');
      if (dim.width !== AVATAR_PX || dim.height !== AVATAR_PX)
        throw Errors.validation(`Avatar art must be exactly ${AVATAR_PX}×${AVATAR_PX} px (got ${dim.width}×${dim.height})`);
      width = dim.width; height = dim.height;
    } else {
      // Question stem / option figures. Strict allow-list (no SVG — it can carry script and we don't
      // sanitize it) and a small size cap; the same rule the admin editor applies client-side.
      if (!QIMAGE_TYPES.has(b.mime_type)) throw Errors.validation('Image must be a PNG, JPG, or WEBP file');
      if (bytes.length > QIMAGE_MAX_BYTES) throw Errors.validation('Image is too large (max 2 MB)');
      const dim = pngDimensions(bytes); // best-effort; non-PNG returns null and leaves dims empty
      if (dim) { width = dim.width; height = dim.height; }
    }

    const checksum = createHash('sha256').update(bytes).digest('hex');
    const ext = b.mime_type === 'image/png' ? 'png' : (b.mime_type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
    const key = `${isAvatar ? 'avatars' : 'content'}/${randomUUID()}.${ext}`;

    // Persist the bytes first; only record the row if the object actually landed. A storage failure
    // (e.g. wrong STORAGE_DRIVER / bucket name / missing service key) is surfaced as a clear 502 with the
    // underlying reason instead of a bare 500 stack, so misconfiguration is obvious in the admin.
    try {
      await storage.put(key, bytes, b.mime_type);
    } catch (e) {
      throw new AppError(502, 'STORAGE_UPLOAD_FAILED', `Image storage failed (driver "${storage.driver}"): ${(e as Error).message}`);
    }

    const ins = await db.query(
      `insert into ccat.content_assets(storage_key,mime_type,byte_size,checksum_sha256,width,height,alt_text,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [key, b.mime_type, bytes.length, checksum, width, height, b.alt_text ?? null, req.admin!.adminId],
    );
    const id = ins.rows[0]!.id as string;
    // Public URL: absolute for Supabase (bucket is public-read); the Gateway asset route for local disk.
    const url = storage.publicUrl(key) ?? `/v1/assets/${id}`;
    await db.query('update ccat.content_assets set public_url=$2 where id=$1', [id, url]);
    await audit(db, req, 'content.asset.uploaded', 'content_asset', id, b.constraint ?? b.mime_type);
    return { id, url };
  });

  // BATCH upload content figures — for bulk-add with figures (up to BATCH_MAX_IMAGES per request; the admin
  // sends size-bounded chunks). Same StorageService path + content_assets schema as the single endpoint:
  //   1) validate + decode EVERY image first — over any limit → reject BEFORE any upload (nothing half-lands);
  //   2) de-dupe identical bytes by checksum — each unique blob is stored + inserted once, reused by all refs;
  //   3) upload the unique blobs to storage with BOUNDED concurrency (STORAGE_UPLOAD_CONCURRENCY);
  //   4) insert all rows in ONE multi-row insert, then set public_url in one statement (atomic in a txn);
  //   5) if any storage put fails, fail the whole request and report which images — never a half-imported set.
  const assetBatchSchema = z.object({
    images: z.array(z.object({
      mime_type: z.string().min(1),
      data_base64: z.string().min(1),
      alt_text: z.string().max(500).optional(),
    })).min(1).max(BATCH_MAX_IMAGES),
  });
  app.post('/v1/admin/content/assets/batch', guard, async (req) => {
    const t0 = Date.now();
    const b = assetBatchSchema.parse(req.body);
    requirePermission(req, 'content.create');

    type Prep = { key: string; bytes: Buffer; mime: string; checksum: string; width: number | null; height: number | null; alt: string | null; label: string };
    const preps: Prep[] = [];
    let total = 0;
    b.images.forEach((img, i) => {
      const label = img.alt_text?.trim() || `#${i + 1}`;
      if (!QIMAGE_TYPES.has(img.mime_type)) throw Errors.validation(`Image ${label} must be a PNG, JPG, or WEBP file`);
      const rawB64 = img.data_base64.includes(',') ? img.data_base64.slice(img.data_base64.indexOf(',') + 1) : img.data_base64;
      let bytes: Buffer;
      try { bytes = Buffer.from(rawB64, 'base64'); } catch { throw Errors.validation(`Image ${label} is not valid base64`); }
      if (bytes.length === 0) throw Errors.validation(`Image ${label} is empty`);
      if (bytes.length > BATCH_MAX_IMAGE_BYTES) throw Errors.validation(`Image ${label} is too large (max 3 MB)`);
      total += bytes.length;
      const checksum = createHash('sha256').update(bytes).digest('hex');
      const dim = pngDimensions(bytes);
      const ext = img.mime_type === 'image/png' ? 'png' : (img.mime_type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
      preps.push({ key: `content/${randomUUID()}.${ext}`, bytes, mime: img.mime_type, checksum, width: dim?.width ?? null, height: dim?.height ?? null, alt: img.alt_text ?? null, label });
    });
    if (total > BATCH_TOTAL_MAX_BYTES) throw Errors.validation('Max 400 images / 50 MB per upload — split into more zips.');

    const uniqueByChecksum = new Map<string, Prep>();
    for (const p of preps) if (!uniqueByChecksum.has(p.checksum)) uniqueByChecksum.set(p.checksum, p);
    const uniqueList = [...uniqueByChecksum.values()];

    const failures: string[] = [];
    await mapPool(uniqueList, STORAGE_UPLOAD_CONCURRENCY, async (p) => {
      try { await storage.put(p.key, p.bytes, p.mime); }
      catch (e) { failures.push(`${p.label}: ${(e as Error).message}`); }
    });
    if (failures.length)
      throw new AppError(502, 'STORAGE_UPLOAD_FAILED',
        `${failures.length} image(s) failed to store (driver "${storage.driver}"): ${failures.slice(0, 10).join('; ')}${failures.length > 10 ? ` …and ${failures.length - 10} more` : ''}`);

    const assetByChecksum = new Map<string, { id: string; url: string }>();
    await withTransaction(db, async (c) => {
      const params: unknown[] = [];
      const rowsSql = uniqueList.map((p, i) => {
        const o = i * 8;
        params.push(p.key, p.mime, p.bytes.length, p.checksum, p.width, p.height, p.alt, req.admin!.adminId);
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`;
      }).join(',');
      const ins = await c.query(
        `insert into ccat.content_assets(storage_key,mime_type,byte_size,checksum_sha256,width,height,alt_text,created_by)
         values ${rowsSql} returning id, storage_key`, params);
      const idByKey = new Map<string, string>();
      for (const r of ins.rows) idByKey.set(r.storage_key as string, r.id as string);
      const ids: string[] = [], urls: string[] = [];
      for (const p of uniqueList) {
        const id = idByKey.get(p.key)!;
        const url = storage.publicUrl(p.key) ?? `/v1/assets/${id}`;
        assetByChecksum.set(p.checksum, { id, url });
        ids.push(id); urls.push(url);
      }
      await c.query(
        `update ccat.content_assets a set public_url = v.url
           from unnest($1::uuid[], $2::text[]) as v(id, url) where a.id = v.id`, [ids, urls]);
    });

    const assets = preps.map(p => assetByChecksum.get(p.checksum)!);
    const elapsedMs = Date.now() - t0;
    await audit(db, req, 'content.asset.batch_uploaded', 'content_asset', assets[0]!.id,
      `${assets.length} images (${uniqueList.length} unique), ${elapsedMs}ms`);
    req.log.info({ count: assets.length, unique: uniqueList.length, elapsed_ms: elapsedMs }, 'bulk asset batch imported');
    return { assets, count: assets.length, unique: uniqueList.length, elapsed_ms: elapsedMs };
  });

  // PUBLIC asset serve (no auth — <img> tags can't send a bearer token). Redirects to the absolute
  // public URL when the object lives in cloud storage (Supabase); otherwise streams the bytes from the
  // local-disk driver. Safe to expose: assets are non-secret art/images referenced by public URL anyway.
  app.get('/v1/assets/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Errors.notFound('Asset not found');
    const r = await db.query('select storage_key, mime_type, public_url from ccat.content_assets where id=$1', [id]);
    if (r.rows.length === 0) throw Errors.notFound('Asset not found');
    const row = r.rows[0]!;
    // If a stored absolute URL points elsewhere (cloud storage), redirect the browser straight to it.
    if (typeof row.public_url === 'string' && /^https?:\/\//i.test(row.public_url))
      return reply.redirect(row.public_url, 302);
    const obj = await storage.get(row.storage_key);
    if (!obj) throw Errors.notFound('Asset not found');
    reply.header('content-type', obj.contentType || row.mime_type || 'application/octet-stream');
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(obj.bytes);
  });

  // Taxonomy (for pickers)
  app.get('/v1/admin/content/taxonomy', guard, async () => {
    const cats = await db.query('select id,key,name from ccat.categories where active order by display_order');
    const subs = await db.query('select id,category_id,key,name,coalesce(max_questions_per_set,15) as max_questions_per_set from ccat.subcategories where active order by display_order');
    const diffs = await db.query('select id,key,name,weight from ccat.difficulties order by display_order');
    const grades = await db.query('select id,grade_number,name from ccat.grades where active and retired_at is null order by display_order');
    return { categories: cats.rows, subcategories: subs.rows, difficulties: diffs.rows, grades: grades.rows };
  });

  // Questions list (filter by state / grade / category)
  app.get('/v1/admin/content/questions', guard, async (req) => {
    requirePermission(req, 'content.create');
    const q = req.query as { state?: string; grade_id?: string; category_id?: string; limit?: string };
    const limit = Math.min(Number(q.limit ?? 100), 200);
    const rows = await db.query(
      `select qv.id, qv.question_type, qv.state, qv.version_number, qv.published_at, qv.created_at,
              qv.prompt_blocks, cat.name category, cat.key category_key, sub.name subcategory, d.key difficulty, g.grade_number,
              (qv.provenance->>'origin') origin
         from ccat.question_versions qv
         join ccat.logical_questions lq on lq.id = qv.logical_question_id
         join ccat.categories cat on cat.id = lq.category_id
         join ccat.subcategories sub on sub.id = lq.subcategory_id
         join ccat.difficulties d on d.id = qv.difficulty_id
         join ccat.grades g on g.id = qv.grade_id
        where ($1::text is null or qv.state::text = $1)
          and ($2::uuid is null or qv.grade_id = $2)
          and ($3::uuid is null or lq.category_id = $3)
        order by qv.created_at desc limit $4`,
      [q.state ?? null, q.grade_id ?? null, q.category_id ?? null, limit],
    );
    return { items: rows.rows.map(r => ({ ...r, preview: preview(r.prompt_blocks) })) };
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
    return { ...r.rows[0], reviews: reviews.rows };
  });

  // Create a draft question (human-authored)
  app.post('/v1/admin/content/questions', guard, async (req) => {
    requirePermission(req, 'content.create');
    const b = createQuestionSchema.parse(req.body);
    // structural validation (schema §17): correct ids must exist among options
    const optIds = new Set(b.option_blocks.map(o => o.option_id));
    if (!b.correct_option_ids.every(c => optIds.has(c))) throw Errors.validation('correct_option_ids must reference option ids');
    const lq = await db.query('insert into ccat.logical_questions(category_id,subcategory_id,created_by) values ($1,$2,$3) returning id',
      [b.category_id, b.subcategory_id, req.admin!.adminId]);
    const qv = await db.query(
      `insert into ccat.question_versions(logical_question_id,version_number,grade_id,difficulty_id,question_type,prompt_blocks,option_blocks,correct_option_ids,explanation_blocks,state,provenance,created_by)
       values ($1,1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10) returning id`,
      [lq.rows[0]!.id, b.grade_id, b.difficulty_id, b.question_type, JSON.stringify(b.prompt_blocks), JSON.stringify(b.option_blocks), b.correct_option_ids, b.explanation_blocks ? JSON.stringify(b.explanation_blocks) : null, JSON.stringify({ origin: 'human' }), req.admin!.adminId]);
    await audit(db, req, 'content.question.created', 'question_version', qv.rows[0]!.id, b.question_type);
    return { id: qv.rows[0]!.id, state: 'draft' };
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
    await db.query(`update ccat.question_versions set state='retired', retired_at=now() where id=$1 and state='published'`, [id]);
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
        -- Canonical set order (SAME as the student catalog): active sets first (state != 'retired'),
        -- oldest→newest by created_at (a newly published set lands at the BOTTOM of the active list),
        -- then retired sets last. Never sort by qs.name (numeric/editable → lexical 1,10,11,2). Grouped
        -- by category/subcategory so each subcategory's block is correctly ordered.
        order by cat.display_order, sub.display_order, (sv.state = 'retired'), sv.created_at asc, sv.id asc
        limit 400`);
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
  // Retire a published set — same effect as /unpublish (published → 'retired'), but gated on the
  // content.retire permission so the Admin "Retire" action works for retire-only admins. Retiring
  // removes the set from the student catalog (which filters state='published'); the row + student
  // play-history are kept. §8.1 immutability still holds (published may only move to 'retired').
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
    const src = await db.query(`select sv.id, sv.question_count, sv.allowed_practice, sv.allowed_exam, sv.difficulty_id,
        qs.grade_id, qs.category_id, qs.subcategory_id, qs.name
        from ccat.question_set_versions sv join ccat.question_sets qs on qs.id=sv.question_set_id where sv.id=$1`, [id]);
    if (src.rows.length === 0) throw Errors.notFound('Set not found');
    const s = src.rows[0]!;
    const newId = await withTransaction(db, async (c) => {
      const nqs = await c.query(`insert into ccat.question_sets(grade_id,category_id,subcategory_id,name,created_by)
          values ($1,$2,$3,$4,$5) returning id`, [s.grade_id, s.category_id, s.subcategory_id, `${s.name} (copy)`, req.admin!.adminId]);
      const nsv = await c.query(`insert into ccat.question_set_versions(question_set_id,version_number,difficulty_id,question_count,allowed_practice,allowed_exam,state)
          values ($1,1,$2,$3,$4,$5,'draft') returning id`, [nqs.rows[0]!.id, s.difficulty_id, s.question_count, s.allowed_practice, s.allowed_exam]);
      await c.query(`insert into ccat.set_version_questions(set_version_id,question_version_id,position)
          select $1, question_version_id, position from ccat.set_version_questions where set_version_id=$2`, [nsv.rows[0]!.id, id]);
      return nsv.rows[0]!.id;
    });
    await audit(db, req, 'content.set.copied', 'set_version', newId, `from ${id}`);
    return { id: newId, state: 'draft' };
  });
  // Permanently delete a set version — draft, published, OR retired (hard delete, distinct from Retire).
  //
  //   Retire  → keeps the row; flips state to 'retired'. The record and any student play-history stay
  //             intact; the catalog (which filters state='published') simply stops showing it.
  //   Delete  → removes the row outright. No retire step is required first.
  //
  // Scoped strictly to the one :id. We delete ONLY records directly owned by this set and required by a
  // foreign key: its membership rows (set_version_questions), the set-version row itself, and — only if
  // this was the set's last version — the parent question_set plus its learning-plan eligibility rows
  // (learning_plan_sets). We NEVER delete questions, taxonomy, grades, students, or any unrelated set;
  // member question_versions stay in the pool. There is no bulk/purge path.
  //
  // Hard delete is allowed only when NO student has ever played the set. ccat.sessions.set_version_id is
  // a RESTRICT foreign key (0003), and sessions + their results/submissions/events are append-only
  // (tg_forbid_mutation) — so a played set cannot be removed without destroying authoritative student
  // score/audit history, which we must never do. A played set is refused (SET_HAS_ACTIVITY) and must be
  // retired instead. (The published-immutability trigger is BEFORE UPDATE only, so it does not fire on
  // DELETE; no trigger bypass is needed.)
  //
  // Effect on the student website is immediate and leaves no stale reference: /v1/catalog is a live join
  // on the row's existence + state='published', and session-start 404s when the set_version row is gone.
  app.delete('/v1/admin/content/sets/:id', guard, async (req) => {
    requirePermission(req, 'content.create');
    const id = (req.params as any).id;
    const cur = await db.query('select state, question_set_id from ccat.question_set_versions where id=$1', [id]);
    if (cur.rows.length === 0) throw Errors.notFound('Set not found');
    const questionSetId = cur.rows[0]!.question_set_id as string;

    // Refuse hard-delete when the set carries student attempt history (append-only; permanent removal
    // would destroy student sessions/results). The admin retires such a set instead.
    const played = await db.query('select 1 from ccat.sessions where set_version_id=$1 limit 1', [id]);
    if (played.rows.length > 0)
      throw Errors.conflict('SET_HAS_ACTIVITY',
        'This set has student attempt history and cannot be permanently deleted. Retire it instead to remove it from the student catalog.');

    await withTransaction(db, async (c) => {
      // Membership of THIS version only (FK: set_version_questions.set_version_id).
      await c.query('delete from ccat.set_version_questions where set_version_id=$1', [id]);
      // The version row itself. DELETE does not fire the BEFORE UPDATE immutability trigger.
      await c.query('delete from ccat.question_set_versions where id=$1', [id]);
      // Drop the parent logical set only when no versions remain, clearing its plan-eligibility rows
      // first (FK: learning_plan_sets.question_set_id). No set_completions can reference it here — every
      // completion requires a session, and a set with any session was already refused above.
      const left = await c.query('select count(*)::int n from ccat.question_set_versions where question_set_id=$1', [questionSetId]);
      if (left.rows[0]!.n === 0) {
        await c.query('delete from ccat.learning_plan_sets where question_set_id=$1', [questionSetId]);
        await c.query('delete from ccat.question_sets where id=$1', [questionSetId]);
      }
    });
    await audit(db, req, 'content.set.deleted', 'set_version', id, cur.rows[0]!.state);
    return { deleted: true };
  });
  app.post('/v1/admin/content/sets/:id/publish', guard, async (req) => {
    requirePermission(req, 'content.publish');
    const id = (req.params as any).id;
    const cur = await db.query('select state, question_count from ccat.question_set_versions where id=$1', [id]);
    if (cur.rows.length === 0) throw Errors.notFound('Set not found');
    const cnt = await db.query('select count(*)::int n, count(*) filter (where active)::int a from ccat.set_version_questions where set_version_id=$1', [id]);
    if (cnt.rows[0]!.n !== cur.rows[0]!.question_count) throw Errors.validation('Set membership does not match question_count');
    if (cnt.rows[0]!.a < 5) throw Errors.validation('A set needs at least 5 active questions before it can be published (§18)');
    // Enforce this subcategory's max questions per set (45 for Combine, 15 otherwise) at publish, too.
    const capRow = await db.query(
      `select coalesce(sub.max_questions_per_set, 15) as maxq
         from ccat.question_set_versions sv
         join ccat.question_sets qs on qs.id = sv.question_set_id
         join ccat.subcategories sub on sub.id = qs.subcategory_id
        where sv.id = $1`, [id]);
    const maxq = Number(capRow.rows[0]?.maxq ?? 15);
    if (cnt.rows[0]!.n > maxq) throw Errors.validation(`This subcategory allows up to ${maxq} questions per set`, { code: 'SET_TOO_LARGE' });
    // Validate every ACTIVE member card is complete before publish (blocks an invalid publish):
    // a stem, ≥2 options, ≥1 correct answer, no empty option content.
    const memberQs = await db.query(
      `select qv.id, qv.state, qv.prompt_blocks, qv.option_blocks, qv.correct_option_ids
         from ccat.set_version_questions svq join ccat.question_versions qv on qv.id=svq.question_version_id
        where svq.set_version_id=$1 and svq.active=true`, [id]);
    const blockText = (blocks: any): string => Array.isArray(blocks)
      ? blocks.map((x: any) => (x?.type === 'text' || x?.type === 'rich_text' || x?.type === 'math' ? String(x.value ?? '') : (x?.type === 'image' ? '[img]' : ''))).join(' ').trim() : '';
    for (const q of memberQs.rows) {
      const opts = (q.option_blocks as any[]) || [];
      if (!blockText(q.prompt_blocks)) throw Errors.validation('Every question needs a stem before publish');
      if (opts.length < 2) throw Errors.validation('Every question needs at least 2 options before publish');
      if (opts.some((o: any) => !blockText(o.content))) throw Errors.validation('Options cannot be empty');
      if (((q.correct_option_ids as string[]) || []).length < 1) throw Errors.validation('Every question needs a marked correct answer before publish');
    }
    await withTransaction(db, async (c) => {
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
      await c.query(`update ccat.question_set_versions set state='published', published_at=now() where id=$1`, [id]);
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
