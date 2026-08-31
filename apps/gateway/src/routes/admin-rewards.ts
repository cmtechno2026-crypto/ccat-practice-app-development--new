import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { withTransaction } from '../db.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';

// Rewards management (Blueprint §19, §20): achievements/avatars/themes read + create;
// compensating reward adjustments (§19.3).
const achSchema = z.object({
  key: z.string().min(1), name: z.string().min(1),
  criteria: z.object({ type: z.string(), threshold: z.number().optional() }),
  xp: z.number().int().optional(), coins: z.number().int().optional(),
});
const adjustSchema = z.object({
  student_id: z.string().uuid(), kind: z.enum(['xp', 'coins']), delta: z.number().int(),
  reason: z.string().min(1), reference: z.string().min(1),
});

export function registerAdminRewardsRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };

  app.get('/v1/admin/rewards/achievements', guard, async () => {
    const rows = await db.query(`select a.key, a.name, av.id version_id, av.version_number, av.active, av.criteria,
        coalesce(json_agg(json_build_object('kind',ar.reward_kind,'xp',ar.xp_amount,'coins',ar.coin_amount))
          filter (where ar.id is not null),'[]') rewards,
        (select count(*) from ccat.student_achievements sa where sa.achievement_version_id=av.id)::int earned_count
        from ccat.achievement_versions av
        join ccat.achievements a on a.id=av.achievement_id
        left join ccat.achievement_rewards ar on ar.achievement_version_id=av.id
        group by a.key,a.name,av.id,av.version_number,av.active,av.criteria order by a.name`);
    return { items: rows.rows };
  });

  app.post('/v1/admin/rewards/achievements', guard, async (req) => {
    requirePermission(req, 'achievement.manage');
    const b = achSchema.parse(req.body);
    const result = await withTransaction(db, async (c) => {
      const a = await c.query('insert into ccat.achievements(key,name) values ($1,$2) returning id', [b.key, b.name]);
      const av = await c.query('insert into ccat.achievement_versions(achievement_id,version_number,criteria,active) values ($1,1,$2,true) returning id',
        [a.rows[0]!.id, JSON.stringify(b.criteria)]);
      if (b.xp) await c.query('insert into ccat.achievement_rewards(achievement_version_id,reward_kind,xp_amount) values ($1,$2,$3)', [av.rows[0]!.id, 'xp', b.xp]);
      if (b.coins) await c.query('insert into ccat.achievement_rewards(achievement_version_id,reward_kind,coin_amount) values ($1,$2,$3)', [av.rows[0]!.id, 'coins', b.coins]);
      return av.rows[0]!.id;
    }).catch((e: any) => { if (e?.code === '23505') throw Errors.conflict('KEY_TAKEN', 'Achievement key already exists'); throw e; });
    return { version_id: result };
  });

  // Avatars: 7 categories × 7 XP-gated stages. A family goes "live" only when all 7 stages are
  // active; deactivating a stage keeps existing owners (grants are immutable). owner_count per
  // stage surfaces that (§20).
  app.get('/v1/admin/rewards/avatars', guard, async () => {
    const rows = await db.query(`select f.id family_id, f.key family_key, f.name family_name, f.active,
        coalesce(json_agg(json_build_object('id',s.id,'stage_number',s.stage_number,'name',s.name,
            'required_xp',s.required_xp,'active',s.active,'asset_id',s.asset_id,'image_url',ca.public_url,
            'owner_count',(select count(*) from ccat.student_avatar_grants g where g.avatar_stage_id=s.id))
          order by s.stage_number) filter (where s.id is not null),'[]') stages,
        count(*) filter (where s.active)::int active_stages,
        count(s.*)::int stage_count,
        (count(*) filter (where s.active) = 7) live,
        (select count(*) from ccat.student_avatar_grants g join ccat.avatar_stages s2 on s2.id=g.avatar_stage_id where s2.family_id=f.id)::int owner_total
        from ccat.avatar_families f
        left join ccat.avatar_stages s on s.family_id=f.id
        left join ccat.content_assets ca on ca.id=s.asset_id
        group by f.id order by f.display_order`);
    return { items: rows.rows };
  });

  const stagePatch = z.object({ active: z.boolean().optional(), required_xp: z.number().int().nonnegative().optional(), name: z.string().min(1).optional(), asset_id: z.string().uuid().nullable().optional() });
  app.patch('/v1/admin/rewards/avatars/stages/:id', guard, async (req) => {
    requirePermission(req, 'avatar.manage');
    const id = (req.params as any).id;
    const b = stagePatch.parse(req.body ?? {});
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    for (const [k, v] of Object.entries(b)) { sets.push(`${k}=$${i++}`); vals.push(v); }
    if (sets.length === 0) return { updated: false };
    vals.push(id);
    const r = await db.query(`update ccat.avatar_stages set ${sets.join(',')} where id=$${i} returning family_id`, vals);
    if (r.rows.length === 0) throw Errors.notFound('Stage not found');
    await audit(db, req, 'avatar.stage.updated', 'avatar_stage', id, Object.keys(b).join(','));
    return { updated: true };
  });

  const stageCreate = z.object({ family_id: z.string().uuid(), stage_number: z.number().int().min(1).max(7), name: z.string().min(1), required_xp: z.number().int().nonnegative().default(0), active: z.boolean().default(false), asset_id: z.string().uuid().optional() });
  app.post('/v1/admin/rewards/avatars/stages', guard, async (req) => {
    requirePermission(req, 'avatar.manage');
    const b = stageCreate.parse(req.body);
    const r = await db.query(`insert into ccat.avatar_stages(family_id,stage_number,name,required_xp,active,asset_id) values ($1,$2,$3,$4,$5,$6) returning id`,
      [b.family_id, b.stage_number, b.name, b.required_xp, b.active, b.asset_id ?? null])
      .catch((e: any) => { if (e?.code === '23505') throw Errors.conflict('STAGE_EXISTS', 'That stage number already exists for this family'); throw e; });
    await audit(db, req, 'avatar.stage.created', 'avatar_stage', r.rows[0]!.id, `stage ${b.stage_number}`);
    return { id: r.rows[0]!.id };
  });

  // Create a family + its 7 draft stages (inactive, default XP ladder). Goes live when activated.
  const XP_LADDER = [0, 50, 120, 220, 350, 520, 750];
  app.post('/v1/admin/rewards/avatars/families', guard, async (req) => {
    requirePermission(req, 'avatar.manage');
    const b = z.object({ key: z.string().min(1), name: z.string().min(1) }).parse(req.body);
    const fam = await withTransaction(db, async (c) => {
      const ord = await c.query('select coalesce(max(display_order),0)+1 n from ccat.avatar_families');
      const f = await c.query('insert into ccat.avatar_families(key,name,display_order,active) values ($1,$2,$3,false) returning id',
        [b.key, b.name, ord.rows[0]!.n]);
      for (let s = 1; s <= 7; s++) {
        await c.query('insert into ccat.avatar_stages(family_id,stage_number,name,required_xp,active) values ($1,$2,$3,$4,false)',
          [f.rows[0]!.id, s, `${b.name} · Stage ${s}`, XP_LADDER[s - 1]]);
      }
      return f.rows[0]!.id;
    }).catch((e: any) => { if (e?.code === '23505') throw Errors.conflict('KEY_TAKEN', 'Family key already exists'); throw e; });
    await audit(db, req, 'avatar.family.created', 'avatar_family', fam, b.name);
    return { id: fam };
  });

  app.patch('/v1/admin/rewards/avatars/families/:id', guard, async (req) => {
    requirePermission(req, 'avatar.manage');
    const id = (req.params as any).id;
    const b = z.object({ active: z.boolean().optional(), name: z.string().min(1).optional() }).parse(req.body ?? {});
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    for (const [k, v] of Object.entries(b)) { sets.push(`${k}=$${i++}`); vals.push(v); }
    if (sets.length === 0) return { updated: false };
    vals.push(id);
    const r = await db.query(`update ccat.avatar_families set ${sets.join(',')} where id=$${i} returning id`, vals);
    if (r.rows.length === 0) throw Errors.notFound('Family not found');
    await audit(db, req, 'avatar.family.updated', 'avatar_family', id, Object.keys(b).join(','));
    return { updated: true };
  });

  app.get('/v1/admin/rewards/themes', guard, async () => {
    const rows = await db.query(`select t.id, t.key, t.name, t.active, t.palette, t.is_default,
        (select rule_expr from ccat.theme_unlock_rules r where r.theme_id=t.id and r.active order by version_number desc limit 1) rule,
        (select count(*) from ccat.student_theme_grants g where g.theme_id=t.id)::int owner_count
        from ccat.themes t order by t.name`);
    return { items: rows.rows };
  });

  // Edit a theme: active state, display name, and the palette (GAM-2).
  app.patch('/v1/admin/rewards/themes/:id', guard, async (req) => {
    requirePermission(req, 'theme.manage');
    const id = (req.params as any).id;
    const b = z.object({ active: z.boolean().optional(), name: z.string().min(1).optional(), palette: z.record(z.string()).optional() }).parse(req.body ?? {});
    if (b.active === undefined && b.name === undefined && b.palette === undefined) return { updated: false };
    const before = await db.query('select active, name, palette from ccat.themes where id=$1', [id]);
    if (before.rows.length === 0) throw Errors.notFound('Theme not found');
    const old0 = before.rows[0]!;
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    const oldVal: any = {}; const newVal: any = {};
    if (b.active !== undefined) { sets.push(`active=$${i++}`); vals.push(b.active); oldVal.active = old0.active; newVal.active = b.active; }
    if (b.name !== undefined) { sets.push(`name=$${i++}`); vals.push(b.name); oldVal.name = old0.name; newVal.name = b.name; }
    if (b.palette !== undefined) { sets.push(`palette=$${i++}`); vals.push(JSON.stringify(b.palette)); oldVal.palette = old0.palette; newVal.palette = b.palette; }
    vals.push(id);
    await db.query(`update ccat.themes set ${sets.join(',')} where id=$${i} returning id`, vals);
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value) values ($1,'admin','theme.updated','theme',$2,$3,$4)`, [req.admin!.adminId, id, JSON.stringify(oldVal), JSON.stringify(newVal)]);
    return { updated: true };
  });

  // Make a theme the single brand default (used when a child has no theme equipped) — GAM-3.
  app.post('/v1/admin/rewards/themes/:id/make-default', guard, async (req) => {
    requirePermission(req, 'theme.manage');
    const id = (req.params as any).id;
    await withTransaction(db, async (c) => {
      const t = await c.query('select 1 from ccat.themes where id=$1', [id]);
      if (t.rows.length === 0) throw Errors.notFound('Theme not found');
      await c.query('update ccat.themes set is_default=false where is_default');
      await c.query('update ccat.themes set is_default=true, active=true where id=$1', [id]);
      await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value) values ($1,'admin','theme.default.set','theme',$2,$3,$4)`, [req.admin!.adminId, id, JSON.stringify({ is_default: false }), JSON.stringify({ is_default: true })]);
    });
    return { is_default: true };
  });

  // Edit an achievement version (§19.4): active state, display name, and XP/coin rewards (GAM-2).
  app.patch('/v1/admin/rewards/achievements/versions/:id', guard, async (req) => {
    requirePermission(req, 'achievement.manage');
    const id = (req.params as any).id;
    const b = z.object({
      active: z.boolean().optional(),
      name: z.string().min(1).optional(),
      xp: z.number().int().nonnegative().nullable().optional(),
      coins: z.number().int().nonnegative().nullable().optional(),
    }).parse(req.body ?? {});
    const oldVal: any = {}; const newVal: any = {};
    await withTransaction(db, async (c) => {
      const ver = await c.query(
        `select av.achievement_id, av.active, a.name,
                (select xp_amount from ccat.achievement_rewards where achievement_version_id=av.id and reward_kind='xp') xp,
                (select coin_amount from ccat.achievement_rewards where achievement_version_id=av.id and reward_kind='coins') coins
           from ccat.achievement_versions av join ccat.achievements a on a.id=av.achievement_id where av.id=$1`, [id]);
      if (ver.rows.length === 0) throw Errors.notFound('Achievement version not found');
      const prev = ver.rows[0]!;
      if (b.active !== undefined) { oldVal.active = prev.active; newVal.active = b.active; }
      if (b.name !== undefined) { oldVal.name = prev.name; newVal.name = b.name; }
      if (b.xp !== undefined) { oldVal.xp = prev.xp == null ? null : Number(prev.xp); newVal.xp = b.xp; }
      if (b.coins !== undefined) { oldVal.coins = prev.coins == null ? null : Number(prev.coins); newVal.coins = b.coins; }
      if (b.active !== undefined) await c.query('update ccat.achievement_versions set active=$2 where id=$1', [id, b.active]);
      if (b.name !== undefined) await c.query('update ccat.achievements set name=$2 where id=$1', [ver.rows[0]!.achievement_id, b.name]);
      // Rewards are edited by replace: clear the kind, then re-insert when a positive amount is given.
      if (b.xp !== undefined) {
        await c.query(`delete from ccat.achievement_rewards where achievement_version_id=$1 and reward_kind='xp'`, [id]);
        if (b.xp) await c.query(`insert into ccat.achievement_rewards(achievement_version_id,reward_kind,xp_amount) values ($1,'xp',$2)`, [id, b.xp]);
      }
      if (b.coins !== undefined) {
        await c.query(`delete from ccat.achievement_rewards where achievement_version_id=$1 and reward_kind='coins'`, [id]);
        if (b.coins) await c.query(`insert into ccat.achievement_rewards(achievement_version_id,reward_kind,coin_amount) values ($1,'coins',$2)`, [id, b.coins]);
      }
    });
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,old_value,new_value) values ($1,'admin','achievement.updated','achievement_version',$2,$3,$4)`, [req.admin!.adminId, id, JSON.stringify(oldVal), JSON.stringify(newVal)]);
    return { updated: true };
  });

  // Compensating reward adjustment (§19.3) — append-only, never overwrite.
  app.post('/v1/admin/rewards/adjust', guard, async (req) => {
    requirePermission(req, 'reward.adjust');
    const b = adjustSchema.parse(req.body);
    await withTransaction(db, async (c) => {
      const s = await c.query('select 1 from ccat.students where id=$1', [b.student_id]);
      if (s.rows.length === 0) throw Errors.notFound('Student not found');
      const table = b.kind === 'xp' ? 'xp_transactions' : 'coin_transactions';
      const cacheCol = b.kind === 'xp' ? 'cached_xp_total' : 'cached_coin_balance';
      const adjId = 'adj_' + Date.now() + '_' + Math.floor(req.id ? 0 : 0);
      await c.query(`insert into ccat.${table}(student_id,delta,source_kind,source_id,reason,actor_admin_id) values ($1,$2,'admin_adjustment',$3,$4,$5)`,
        [b.student_id, b.delta, `${req.admin!.adminId}:${b.reference}`, b.reason, req.admin!.adminId]);
      await c.query(`update ccat.students set ${cacheCol}=${cacheCol}+$2 where id=$1`, [b.student_id, b.delta]);
      await c.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,reason,reference)
          values ($1,'admin','reward.adjusted','student',$2,$3,$4)`, [req.admin!.adminId, b.student_id, `${b.kind} ${b.delta}: ${b.reason}`, b.reference]);
      void adjId;
    }).catch((e: any) => { if (e?.code === '23505') throw Errors.conflict('DUPLICATE_ADJUSTMENT', 'Adjustment reference already used'); throw e; });
    return { adjusted: true };
  });
}

async function audit(db: DB, req: any, event: string, kind: string, id: string, reason: string | null) {
  await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,reason,request_id)
    values ($1,'admin',$2,$3,$4,$5,$6)`, [req.admin.adminId, event, kind, id, reason, req.id ?? null]);
}
