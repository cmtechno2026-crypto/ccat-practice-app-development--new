import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';
import { loadEconomyConfig, ECONOMY_DEFAULTS } from '../lib/economyConfig.js';

// Coins & XP config + Economy integrity (Blueprint §19, §30). The config is versioned
// (config_versions, domain='economy', append-only). Integrity compares cached balances to the
// authoritative ledgers; recompute rebuilds caches from the ledger (caches are derived, so this
// is safe and non-destructive to the ledger).
export function registerAdminEconomyRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };

  app.get('/v1/admin/rewards/economy', guard, async () => {
    const config = await loadEconomyConfig(db);
    const meta = await db.query(`select version_label, effective_at, published_at from ccat.config_versions
        where domain='economy' and is_active=true order by effective_at desc limit 1`);
    const xpBad = await db.query(
      `select s.id, s.username_normalized::text username, s.cached_xp_total::bigint cached,
              coalesce((select sum(delta) from ccat.xp_transactions x where x.student_id=s.id),0)::bigint ledger
         from ccat.students s
        where s.cached_xp_total <> coalesce((select sum(delta) from ccat.xp_transactions x where x.student_id=s.id),0)
        order by abs(s.cached_xp_total - coalesce((select sum(delta) from ccat.xp_transactions x where x.student_id=s.id),0)) desc
        limit 10`);
    const coinBad = await db.query(
      `select s.id, s.username_normalized::text username, s.cached_coin_balance::bigint cached,
              coalesce((select sum(delta) from ccat.coin_transactions c where c.student_id=s.id),0)::bigint ledger
         from ccat.students s
        where s.cached_coin_balance <> coalesce((select sum(delta) from ccat.coin_transactions c where c.student_id=s.id),0)
        order by abs(s.cached_coin_balance - coalesce((select sum(delta) from ccat.coin_transactions c where c.student_id=s.id),0)) desc
        limit 10`);
    const counts = await db.query(
      `select
         (select count(*) from ccat.students s where s.cached_xp_total <> coalesce((select sum(delta) from ccat.xp_transactions x where x.student_id=s.id),0))::int xp_mismatch,
         (select count(*) from ccat.students s where s.cached_coin_balance <> coalesce((select sum(delta) from ccat.coin_transactions c where c.student_id=s.id),0))::int coin_mismatch,
         (select coalesce(sum(delta),0) from ccat.xp_transactions)::bigint xp_ledger_total,
         (select coalesce(sum(delta),0) from ccat.coin_transactions)::bigint coin_ledger_total,
         (select count(*) from ccat.coin_transactions where source_kind='streak_milestone')::int streak_bonuses,
         (select count(*) from ccat.coin_transactions where source_kind='admin_adjustment')::int admin_adjustments`);
    const c = counts.rows[0]!;
    return {
      config, defaults: ECONOMY_DEFAULTS,
      config_meta: meta.rows[0] ?? null,
      integrity: {
        xp_mismatch_count: c.xp_mismatch, coin_mismatch_count: c.coin_mismatch,
        xp_ledger_total: Number(c.xp_ledger_total), coin_ledger_total: Number(c.coin_ledger_total),
        streak_bonuses: c.streak_bonuses, admin_adjustments: c.admin_adjustments,
        xp_samples: xpBad.rows.map((r) => ({ ...r, cached: Number(r.cached), ledger: Number(r.ledger) })),
        coin_samples: coinBad.rows.map((r) => ({ ...r, cached: Number(r.cached), ledger: Number(r.ledger) })),
        healthy: c.xp_mismatch === 0 && c.coin_mismatch === 0,
      },
    };
  });

  // Publish a new economy config version (append-only). Super-Admin / config.global.
  const numMap = z.record(z.number());
  const publishSchema = z.object({
    base_xp: numMap.optional(),
    difficulty_weight: numMap.optional(),
    streak_milestones: numMap.optional(),
    version_label: z.string().max(80).optional(),
  });
  app.post('/v1/admin/rewards/economy/config', guard, async (req) => {
    requirePermission(req, 'config.global');
    const b = publishSchema.parse(req.body ?? {});
    const current = await loadEconomyConfig(db);
    const payload = {
      base_xp: { ...current.base_xp, ...(b.base_xp ?? {}) },
      difficulty_weight: { ...current.difficulty_weight, ...(b.difficulty_weight ?? {}) },
      streak_milestones: { ...current.streak_milestones, ...(b.streak_milestones ?? {}) },
    };
    const id = await withTransaction(db, async (client) => {
      await client.query(`update ccat.config_versions set is_active=false where domain='economy' and is_active=true`);
      const r = await client.query(
        `insert into ccat.config_versions(domain, version_label, payload, is_active, published_by, effective_at, published_at)
         values ('economy', $1, $2, true, $3, now(), now()) returning id`,
        [b.version_label ?? `economy-${new Date().toISOString().slice(0, 19)}`, JSON.stringify(payload), req.admin!.adminId],
      );
      return r.rows[0]!.id as string;
    });
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,reason)
      values ($1,'admin','economy.config.published','config_version',$2,$3)`, [req.admin!.adminId, id, 'economy config']);
    return { id, payload };
  });

  // Rebuild cached balances from the authoritative ledgers (fixes integrity mismatches). The
  // ledger is never touched. config.global.
  app.post('/v1/admin/rewards/economy/recompute', guard, async (req) => {
    requirePermission(req, 'config.global');
    const fixed = await withTransaction(db, async (client) => {
      const xp = await client.query(
        `update ccat.students s set cached_xp_total = coalesce((select sum(delta) from ccat.xp_transactions x where x.student_id=s.id),0)
          where s.cached_xp_total <> coalesce((select sum(delta) from ccat.xp_transactions x where x.student_id=s.id),0)`);
      const coin = await client.query(
        `update ccat.students s set cached_coin_balance = coalesce((select sum(delta) from ccat.coin_transactions c where c.student_id=s.id),0)
          where s.cached_coin_balance <> coalesce((select sum(delta) from ccat.coin_transactions c where c.student_id=s.id),0)`);
      return { xp: xp.rowCount ?? 0, coin: coin.rowCount ?? 0 };
    });
    await db.query(`insert into ccat.audit_log(actor_admin_id,actor_kind,event_type,target_kind,target_id,reason)
      values ($1,'admin','economy.recomputed','system',$1,$2)`, [req.admin!.adminId, `xp:${fixed.xp} coin:${fixed.coin}`]);
    return { recomputed: true, ...fixed };
  });
}
