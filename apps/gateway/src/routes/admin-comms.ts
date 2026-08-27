import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';
import { checkPushPii } from '../lib/comms.js';
import { isAllowlistedRetailerUrl, RETAILER_ALLOWLIST } from '../lib/books.js';

// Announcements, push campaigns, Book Store management (Blueprint §21, §26).
const annSchema = z.object({
  title: z.string().min(1), body_text: z.string().min(1),
  target_grade_ids: z.array(z.string().uuid()).optional(),
  channel: z.enum(['carousel', 'carousel_push']).default('carousel'),
  scheduled_at: z.string().datetime().optional(), // start time; a future value → 'scheduled'
  ends_at: z.string().datetime().optional(),       // optional window end; carousel drops it after
});
const pushSchema = z.object({
  title: z.string().min(1), message: z.string().min(1),
  scheduled_at: z.string().datetime().optional(),
  audience_grade_ids: z.array(z.string().uuid()).optional(),
});
const bookSchema = z.object({ title: z.string().min(1), author: z.string().optional(), description: z.string().optional(),
  price_cents: z.number().int().nonnegative().optional(), subject: z.string().optional(), grade_ids: z.array(z.string().uuid()).optional(),
  retailer: z.string().min(1), url: z.string().url() });
const bookPatchSchema = z.object({
  title: z.string().min(1).optional(), author: z.string().nullable().optional(),
  description: z.string().nullable().optional(), active: z.boolean().optional(),
  price_cents: z.number().int().nonnegative().nullable().optional(), subject: z.string().nullable().optional(),
  grade_ids: z.array(z.string().uuid()).nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });
const linkSchema = z.object({ retailer: z.string().min(1), url: z.string().url(), kind: z.string().optional(), display_order: z.number().int().min(0).optional() });
const linkPatchSchema = z.object({
  retailer: z.string().min(1).optional(), url: z.string().url().optional(), kind: z.string().nullable().optional(),
  active: z.boolean().optional(), display_order: z.number().int().min(0).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

export function registerAdminCommsRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };

  // Announcements — the unified communications surface (carousel + optional push, §26.1).
  app.get('/v1/admin/announcements', guard, async () => {
    const rows = await db.query(`select a.id,a.title,a.body_blocks,a.state,a.channel,a.carousel_order,
        a.published_at,a.scheduled_at,a.starts_at,a.ends_at,a.stopped_at,a.target_grades,a.version,a.created_at,
        a.push_campaign_id, pc.state push_state
        from ccat.announcements a
        left join ccat.push_campaigns pc on pc.id = a.push_campaign_id
        order by a.created_at desc`);
    return { items: rows.rows };
  });
  app.post('/v1/admin/announcements', guard, async (req) => {
    requirePermission(req, 'announcement.manage');
    const b = annSchema.parse(req.body);
    // A future start (scheduled_at) → 'scheduled' (a worker publishes it when due); else draft.
    const scheduled = b.scheduled_at && new Date(b.scheduled_at).getTime() > Date.now();
    if (b.scheduled_at && !scheduled) throw Errors.validation('Start time must be in the future');
    const state = scheduled ? 'scheduled' : 'draft';
    // carousel_push also queues a push campaign (requested → Super-Admin approves, §26.1). The push
    // body reuses the announcement text and is PII-checked exactly like a standalone push.
    let pushId: string | null = null;
    if (b.channel === 'carousel_push') {
      const pii = checkPushPii(b.body_text);
      if (!pii.safe) throw Errors.validation(pii.reason!);
      const payload = { title: b.title, body: b.body_text, pii_safe: true };
      const target = b.target_grade_ids?.length ? { grade_ids: b.target_grade_ids } : { all: true };
      const pc = await db.query(`insert into ccat.push_campaigns(title,payload,target_query,state,requested_by,scheduled_at) values ($1,$2,$3,'requested',$4,$5) returning id`,
        [b.title, JSON.stringify(payload), JSON.stringify(target), req.admin!.adminId, scheduled ? b.scheduled_at : null]);
      pushId = pc.rows[0]!.id;
    }
    const r = await db.query(`insert into ccat.announcements(title,body_blocks,state,channel,target_grades,scheduled_at,starts_at,ends_at,push_campaign_id,created_by)
        values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9) returning id`,
      [b.title, JSON.stringify([{ type: 'text', value: b.body_text }]), state, b.channel, b.target_grade_ids ?? null,
       scheduled ? b.scheduled_at : null, b.ends_at ?? null, pushId, req.admin!.adminId]);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','announcement.created','announcement',$2)`, [req.admin!.adminId, r.rows[0]!.id]);
    return { id: r.rows[0]!.id, state, push_campaign_id: pushId };
  });
  app.post('/v1/admin/announcements/:id/publish', guard, async (req) => {
    requirePermission(req, 'announcement.publish');
    const id = (req.params as any).id;
    const prev = await db.query('select state from ccat.announcements where id=$1', [id]);
    if (prev.rows.length === 0) throw Errors.notFound('Announcement not found');
    const max = await db.query(`select coalesce(max(carousel_order),-1)+1 n from ccat.announcements where state='published'`);
    await db.query(`update ccat.announcements set state='published', published_at=now(), starts_at=coalesce(starts_at,now()), stopped_at=null, carousel_order=$2, version=version+1 where id=$1 returning id`, [id, max.rows[0]!.n]);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value) values ($1,'admin','announcement.published','announcement',$2,$3,$4)`, [req.admin!.adminId, id, JSON.stringify({ state: prev.rows[0]!.state }), JSON.stringify({ state: 'published' })]);
    return { state: 'published' };
  });
  // Stop a live/scheduled announcement (pulls it from the carousel). Restart re-publishes it.
  app.post('/v1/admin/announcements/:id/stop', guard, async (req) => {
    requirePermission(req, 'announcement.manage');
    const id = (req.params as any).id;
    const prev = await db.query('select state from ccat.announcements where id=$1', [id]);
    const r = await db.query(`update ccat.announcements set state='stopped', stopped_at=now(), version=version+1 where id=$1 and state in ('published','scheduled') returning id`, [id]);
    if (r.rows.length === 0) throw Errors.conflict('BAD_STATE', 'Only a live or scheduled announcement can be stopped');
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value) values ($1,'admin','announcement.stopped','announcement',$2,$3,$4)`, [req.admin!.adminId, id, JSON.stringify({ state: prev.rows[0]!.state }), JSON.stringify({ state: 'stopped' })]);
    return { state: 'stopped' };
  });
  // Restart / Run again: re-publish a stopped OR ended(archived) announcement as a fresh live run.
  app.post('/v1/admin/announcements/:id/restart', guard, async (req) => {
    requirePermission(req, 'announcement.publish');
    const id = (req.params as any).id;
    const prev = await db.query('select state from ccat.announcements where id=$1', [id]);
    const max = await db.query(`select coalesce(max(carousel_order),-1)+1 n from ccat.announcements where state='published'`);
    const r = await db.query(`update ccat.announcements set state='published', published_at=now(), starts_at=now(), stopped_at=null, carousel_order=$2, version=version+1 where id=$1 and state in ('stopped','archived') returning id`, [id, max.rows[0]!.n]);
    if (r.rows.length === 0) throw Errors.conflict('BAD_STATE', 'Only a stopped or ended announcement can be run again');
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value) values ($1,'admin','announcement.restarted','announcement',$2,$3,$4)`, [req.admin!.adminId, id, JSON.stringify({ state: prev.rows[0]!.state }), JSON.stringify({ state: 'published' })]);
    return { state: 'published' };
  });
  app.post('/v1/admin/announcements/:id/archive', guard, async (req) => {
    requirePermission(req, 'announcement.manage');
    const id = (req.params as any).id;
    const prev = await db.query('select state from ccat.announcements where id=$1', [id]);
    if (prev.rows.length === 0) throw Errors.notFound('Announcement not found');
    await db.query(`update ccat.announcements set state='archived', version=version+1 where id=$1`, [id]);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value) values ($1,'admin','announcement.archived','announcement',$2,$3,$4)`, [req.admin!.adminId, id, JSON.stringify({ state: prev.rows[0]!.state }), JSON.stringify({ state: 'archived' })]);
    return { state: 'archived' };
  });

  // Duplicate an announcement as a fresh draft (title/body/channel/grades copied; no live state,
  // no push campaign) — the mockup's "Duplicate" (ANN-1).
  app.post('/v1/admin/announcements/:id/duplicate', guard, async (req) => {
    requirePermission(req, 'announcement.manage');
    const id = (req.params as any).id;
    const src = await db.query('select title, body_blocks, channel, target_grades from ccat.announcements where id=$1', [id]);
    if (src.rows.length === 0) throw Errors.notFound('Announcement not found');
    const s = src.rows[0]!;
    const r = await db.query(
      `insert into ccat.announcements(title,body_blocks,state,channel,target_grades,created_by)
       values ($1,$2,'draft','carousel',$3,$4) returning id`,
      [`${s.title} (copy)`, JSON.stringify(s.body_blocks), s.target_grades, req.admin!.adminId]);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','announcement.duplicated','announcement',$2)`, [req.admin!.adminId, r.rows[0]!.id]);
    return { id: r.rows[0]!.id, state: 'draft' };
  });

  // Extend (later ends_at) / Reschedule (future scheduled_at) — ANN-1.
  app.patch('/v1/admin/announcements/:id', guard, async (req) => {
    requirePermission(req, 'announcement.manage');
    const id = (req.params as any).id;
    const b = z.object({ ends_at: z.string().datetime().nullable().optional(), scheduled_at: z.string().datetime().optional() })
      .refine((x) => x.ends_at !== undefined || x.scheduled_at !== undefined, { message: 'Nothing to update' }).parse(req.body ?? {});
    const cur = await db.query('select state from ccat.announcements where id=$1', [id]);
    if (cur.rows.length === 0) throw Errors.notFound('Announcement not found');
    const sets: string[] = []; const vals: any[] = [id]; let i = 2;
    if (b.ends_at !== undefined) { sets.push(`ends_at=$${i++}`); vals.push(b.ends_at); }
    if (b.scheduled_at !== undefined) {
      if (new Date(b.scheduled_at).getTime() <= Date.now()) throw Errors.validation('Scheduled time must be in the future');
      sets.push(`scheduled_at=$${i++}`); vals.push(b.scheduled_at);
      // Rescheduling a draft/stopped/archived announcement moves it to 'scheduled'.
      if (['draft', 'stopped', 'archived'].includes(cur.rows[0]!.state)) sets.push(`state='scheduled'`);
    }
    sets.push('version=version+1');
    await db.query(`update ccat.announcements set ${sets.join(',')} where id=$1`, vals);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','announcement.rescheduled','announcement',$2)`, [req.admin!.adminId, id]);
    return { updated: true };
  });

  // Push campaigns
  app.get('/v1/admin/push/campaigns', guard, async () => {
    const rows = await db.query(`select pc.id,pc.title,pc.state,pc.created_at,pc.scheduled_at,pc.payload,pc.target_query,
        (select display_name from ccat.admin_profiles ap where ap.id=pc.requested_by) requested_by,
        (select display_name from ccat.admin_profiles ap where ap.id=pc.approved_by) approved_by
        from ccat.push_campaigns pc order by pc.created_at desc`);
    return { items: rows.rows };
  });
  // Live PII check for the composer (no write) — lets the UI show "no identifiable people ✓".
  app.post('/v1/admin/push/pii-check', guard, async (req) => {
    requirePermission(req, 'push.request');
    const b = z.object({ message: z.string() }).parse(req.body ?? {});
    return checkPushPii(b.message);
  });
  app.post('/v1/admin/push/campaigns', guard, async (req) => {
    requirePermission(req, 'push.request');
    const b = pushSchema.parse(req.body);
    // PII guard (§26.1): reject bodies that would interpolate a child's name/score.
    const pii = checkPushPii(b.message);
    if (!pii.safe) throw Errors.validation(pii.reason!);
    const scheduled = b.scheduled_at && new Date(b.scheduled_at).getTime() > Date.now() ? b.scheduled_at : null;
    const payload = { title: b.title, body: b.message, pii_safe: true };
    const target = b.audience_grade_ids?.length ? { grade_ids: b.audience_grade_ids } : { all: true };
    const r = await db.query(`insert into ccat.push_campaigns(title,payload,target_query,state,requested_by,scheduled_at) values ($1,$2,$3,'requested',$4,$5) returning id`,
      [b.title, JSON.stringify(payload), JSON.stringify(target), req.admin!.adminId, scheduled]);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','push.requested','push',$2)`, [req.admin!.adminId, r.rows[0]!.id]);
    return { id: r.rows[0]!.id, state: 'requested', pii_safe: true };
  });
  app.post('/v1/admin/push/campaigns/:id/approval', guard, async (req) => {
    requirePermission(req, 'push.approve'); // SA-only per catalog
    const id = (req.params as any).id;
    const b = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().optional() }).parse(req.body);
    const state = b.decision === 'approved' ? 'approved' : 'rejected';
    const r = await db.query(`update ccat.push_campaigns set state=$2, approved_by=$3, updated_at=now() where id=$1 and state='requested' returning id`, [id, state, req.admin!.adminId]);
    if (r.rows.length === 0) throw Errors.conflict('BAD_STATE', 'Campaign is not awaiting approval');
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,reason) values ($1,'admin',$2,'push',$3,$4)`,
      [req.admin!.adminId, b.decision === 'approved' ? 'push.approved' : 'push.rejected', id, b.reason ?? null]);
    return { state };
  });

  // Book store management (§21). External retailer links only; each book can carry multiple
  // per-platform buy links. Destinations must be HTTPS + on the retailer allowlist.
  app.get('/v1/admin/books', guard, async () => {
    const rows = await db.query(`select b.id,b.title,b.author,b.description,b.active,b.price_cents,b.subject,b.grade_ids,
        coalesce(json_agg(json_build_object('id',l.id,'retailer',l.retailer,'url',l.destination_url,'kind',l.kind,'active',l.active,'display_order',l.display_order) order by l.display_order,l.retailer) filter (where l.id is not null),'[]') retailers
        from ccat.books b left join ccat.book_retailer_links l on l.book_id=b.id group by b.id order by b.title`);
    return { items: rows.rows };
  });
  // The allowlisted retailer platforms, surfaced so the UI can offer a picker + explain rejections.
  app.get('/v1/admin/books/retailers', guard, async () => {
    return { platforms: RETAILER_ALLOWLIST.map((p) => ({ key: p.key, label: p.label, domains: p.domains })) };
  });
  app.post('/v1/admin/books', guard, async (req) => {
    requirePermission(req, 'book.manage');
    const b = bookSchema.parse(req.body);
    const chk = isAllowlistedRetailerUrl(b.url);
    if (!chk.ok) throw Errors.validation(chk.reason!);
    const book = await db.query('insert into ccat.books(title,author,description,price_cents,subject,grade_ids,active,created_by) values ($1,$2,$3,$4,$5,$6,true,$7) returning id',
      [b.title, b.author ?? null, b.description ?? null, b.price_cents ?? null, b.subject ?? null, b.grade_ids ?? null, req.admin!.adminId]);
    await db.query('insert into ccat.book_retailer_links(book_id,retailer,destination_url,display_order,active) values ($1,$2,$3,0,true)',
      [book.rows[0]!.id, b.retailer, b.url]);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','book.created','book',$2)`, [req.admin!.adminId, book.rows[0]!.id]);
    return { id: book.rows[0]!.id };
  });
  app.patch('/v1/admin/books/:id', guard, async (req) => {
    requirePermission(req, 'book.manage');
    const id = (req.params as any).id;
    const b = bookPatchSchema.parse(req.body);
    const fields = ['title', 'author', 'description', 'active', 'price_cents', 'subject', 'grade_ids'] as const;
    const before = await db.query(`select ${fields.join(',')} from ccat.books where id=$1`, [id]);
    if (before.rows.length === 0) throw Errors.notFound('Book not found');
    const sets: string[] = []; const vals: any[] = [id]; let i = 2;
    const oldVal: any = {}; const newVal: any = {};
    for (const k of fields) {
      if (b[k] !== undefined) { sets.push(`${k}=$${i++}`); vals.push(b[k]); oldVal[k] = before.rows[0]![k]; newVal[k] = b[k]; }
    }
    await db.query(`update ccat.books set ${sets.join(',')} where id=$1 returning id`, vals);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value) values ($1,'admin','book.updated','book',$2,$3,$4)`, [req.admin!.adminId, id, JSON.stringify(oldVal), JSON.stringify(newVal)]);
    return { id };
  });
  // Per-platform buy link management.
  app.post('/v1/admin/books/:id/links', guard, async (req) => {
    requirePermission(req, 'book.manage');
    const id = (req.params as any).id;
    const b = linkSchema.parse(req.body);
    const chk = isAllowlistedRetailerUrl(b.url);
    if (!chk.ok) throw Errors.validation(chk.reason!);
    const book = await db.query('select id from ccat.books where id=$1', [id]);
    if (book.rows.length === 0) throw Errors.notFound('Book not found');
    const ord = b.display_order ?? (await db.query('select coalesce(max(display_order),-1)+1 n from ccat.book_retailer_links where book_id=$1', [id])).rows[0]!.n;
    const r = await db.query('insert into ccat.book_retailer_links(book_id,retailer,destination_url,kind,display_order,active) values ($1,$2,$3,$4,$5,true) returning id',
      [id, b.retailer, b.url, b.kind ?? null, ord]);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','book.link.added','book',$2)`, [req.admin!.adminId, id]);
    return { id: r.rows[0]!.id };
  });
  app.patch('/v1/admin/books/:id/links/:linkId', guard, async (req) => {
    requirePermission(req, 'book.manage');
    const { id, linkId } = req.params as any;
    const b = linkPatchSchema.parse(req.body);
    if (b.url !== undefined) { const chk = isAllowlistedRetailerUrl(b.url); if (!chk.ok) throw Errors.validation(chk.reason!); }
    const sets: string[] = []; const vals: any[] = [linkId, id]; let i = 3;
    if (b.retailer !== undefined) { sets.push(`retailer=$${i++}`); vals.push(b.retailer); }
    if (b.url !== undefined) { sets.push(`destination_url=$${i++}`); vals.push(b.url); }
    if (b.active !== undefined) { sets.push(`active=$${i++}`); vals.push(b.active); }
    if (b.kind !== undefined) { sets.push(`kind=$${i++}`); vals.push(b.kind); }
    if (b.display_order !== undefined) { sets.push(`display_order=$${i++}`); vals.push(b.display_order); }
    const r = await db.query(`update ccat.book_retailer_links set ${sets.join(',')} where id=$1 and book_id=$2 returning id`, vals);
    if (r.rows.length === 0) throw Errors.notFound('Retailer link not found');
    return { id: linkId };
  });
  app.delete('/v1/admin/books/:id/links/:linkId', guard, async (req) => {
    requirePermission(req, 'book.manage');
    const { id, linkId } = req.params as any;
    const r = await db.query('delete from ccat.book_retailer_links where id=$1 and book_id=$2 returning id', [linkId, id]);
    if (r.rows.length === 0) throw Errors.notFound('Retailer link not found');
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id) values ($1,'admin','book.link.removed','book',$2)`, [req.admin!.adminId, id]);
    return { deleted: true };
  });
}
