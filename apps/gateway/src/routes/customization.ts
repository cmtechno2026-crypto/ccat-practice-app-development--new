import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { Errors } from '../errors.js';

// Avatars & themes (Blueprint §20, §32.5). Ownership is server-authoritative: an avatar stage
// is owned if the student holds an explicit grant OR has reached its required XP
// (server-confirmed, §20.1 "evolution depends on server-confirmed XP/explicit grants only").
// Themes use versioned unlock rules with NO premium/payment references (§20.2).

const equipAvatarSchema = z.object({ avatar_stage_id: z.string().uuid() });
const equipThemeSchema = z.object({ theme_id: z.string().uuid() });

async function studentXp(db: DB, studentId: string): Promise<number> {
  const { rows } = await db.query('select coalesce(sum(delta),0)::bigint as v from ccat.xp_transactions where student_id=$1', [studentId]);
  return Number(rows[0]!.v);
}

export function registerCustomizationRoutes(app: FastifyInstance, db: DB) {
  // GET /v1/avatars — families + stages with owned/active/locked state (§20.1)
  app.get('/v1/avatars', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const xp = await studentXp(db, sid);
    const me = await db.query('select active_avatar_stage_id from ccat.students where id=$1', [sid]);
    const activeStage = me.rows[0]!.active_avatar_stage_id as string | null;
    const { rows } = await db.query(
      `select f.id as family_id, f.key as family_key, f.name as family_name, f.display_order,
              s.id as stage_id, s.stage_number, s.name as stage_name, s.required_xp,
              (g.student_id is not null) as granted
         from ccat.avatar_families f
         join ccat.avatar_stages s on s.family_id = f.id and s.active = true
         left join ccat.student_avatar_grants g on g.avatar_stage_id = s.id and g.student_id = $1
        where f.active = true
        order by f.display_order, s.stage_number`,
      [sid],
    );
    const families: Record<string, any> = {};
    for (const r of rows) {
      const owned = r.granted || (r.required_xp != null && xp >= Number(r.required_xp));
      if (!families[r.family_id]) families[r.family_id] = { family_id: r.family_id, key: r.family_key, name: r.family_name, stages: [] };
      families[r.family_id].stages.push({
        stage_id: r.stage_id, stage_number: r.stage_number, name: r.stage_name,
        required_xp: r.required_xp == null ? null : Number(r.required_xp),
        owned, active: r.stage_id === activeStage,
      });
    }
    return { xp_total: xp, families: Object.values(families) };
  });

  // POST /v1/avatars/equip — equip an owned/unlocked stage; auto-grant on XP unlock (§20.1)
  app.post('/v1/avatars/equip', { preHandler: [app.authenticateStudent] }, async (req) => {
    const body = equipAvatarSchema.parse(req.body);
    const sid = req.student!.studentId;
    const s = await db.query('select s.id, s.required_xp, s.active from ccat.avatar_stages s where s.id=$1', [body.avatar_stage_id]);
    if (s.rows.length === 0 || !s.rows[0]!.active) throw Errors.notFound('Avatar stage not found');
    const stage = s.rows[0]!;
    const grant = await db.query('select 1 from ccat.student_avatar_grants where student_id=$1 and avatar_stage_id=$2', [sid, body.avatar_stage_id]);
    let owned = grant.rows.length > 0;
    if (!owned && stage.required_xp != null) {
      const xp = await studentXp(db, sid);
      if (xp >= Number(stage.required_xp)) {
        await db.query(`insert into ccat.student_avatar_grants(student_id, avatar_stage_id, source_kind) values ($1,$2,'xp') on conflict do nothing`, [sid, body.avatar_stage_id]);
        owned = true;
      }
    }
    if (!owned) throw Errors.forbidden('NOT_OWNED', 'This avatar is not unlocked yet');
    await db.query('update ccat.students set active_avatar_stage_id=$2 where id=$1', [sid, body.avatar_stage_id]);
    return { active_avatar_stage_id: body.avatar_stage_id };
  });

  // GET /v1/themes — themes with owned/active state via versioned unlock rules (§20.2)
  app.get('/v1/themes', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const xp = await studentXp(db, sid);
    const me = await db.query('select active_theme_id from ccat.students where id=$1', [sid]);
    const activeTheme = me.rows[0]!.active_theme_id as string | null;
    const { rows } = await db.query(
      `select t.id, t.key, t.name, t.palette,
              (g.student_id is not null) as granted,
              (select rule_expr from ccat.theme_unlock_rules r where r.theme_id=t.id and r.active=true order by version_number desc limit 1) as rule
         from ccat.themes t
         left join ccat.student_theme_grants g on g.theme_id=t.id and g.student_id=$1
        where t.active=true
        order by t.name`,
      [sid],
    );
    return rows.map((r) => ({
      id: r.id, key: r.key, name: r.name,
      // palette is a map of CSS token → hex (e.g. {"--primary":"#8b5cf6"}); {} = base tokens.
      palette: (r.palette && typeof r.palette === 'object') ? r.palette : {},
      owned: r.granted || ruleSatisfied(r.rule, xp),
      active: r.id === activeTheme,
      requirement: ruleLabel(r.rule),
    }));
  });

  // POST /v1/themes/equip — equip an owned/unlocked theme; auto-grant on rule unlock
  app.post('/v1/themes/equip', { preHandler: [app.authenticateStudent] }, async (req) => {
    const body = equipThemeSchema.parse(req.body);
    const sid = req.student!.studentId;
    const t = await db.query('select id, active from ccat.themes where id=$1', [body.theme_id]);
    if (t.rows.length === 0 || !t.rows[0]!.active) throw Errors.notFound('Theme not found');
    const grant = await db.query('select 1 from ccat.student_theme_grants where student_id=$1 and theme_id=$2', [sid, body.theme_id]);
    let owned = grant.rows.length > 0;
    if (!owned) {
      const rule = await db.query('select rule_expr from ccat.theme_unlock_rules where theme_id=$1 and active=true order by version_number desc limit 1', [body.theme_id]);
      const xp = await studentXp(db, sid);
      if (ruleSatisfied(rule.rows[0]?.rule_expr, xp)) {
        await db.query(`insert into ccat.student_theme_grants(student_id, theme_id, source_kind) values ($1,$2,'rule') on conflict do nothing`, [sid, body.theme_id]);
        owned = true;
      }
    }
    if (!owned) throw Errors.forbidden('NOT_OWNED', 'This theme is not unlocked yet');
    await db.query('update ccat.students set active_theme_id=$2 where id=$1', [sid, body.theme_id]);
    return { active_theme_id: body.theme_id };
  });
}

function ruleSatisfied(rule: { type?: string; threshold?: number } | null | undefined, xp: number): boolean {
  if (!rule) return false;
  if (rule.type === 'default') return true;
  if (rule.type === 'xp_total') return typeof rule.threshold === 'number' && xp >= rule.threshold;
  return false;
}
function ruleLabel(rule: { type?: string; threshold?: number } | null | undefined): string {
  if (!rule || rule.type === 'default') return 'Free';
  if (rule.type === 'xp_total') return `Reach ${rule.threshold ?? 0} XP`;
  return 'Locked';
}
