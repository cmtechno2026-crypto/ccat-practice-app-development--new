import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';
import { ALLOWED_TIERS } from '../lib/entitlements.js';

// Payments Phase 2 — MANUAL admin grant (temporary bridge until Stripe/webhook exist). Upserts one
// ccat.entitlements row per guardian email (source='manual'), keyed case-insensitively. This is the
// operator's test lever: set a guardian to free (demo-only) or t50 (all practice), confirm Exam/Combine
// stay locked in both. Protected by the EXISTING admin auth (no new scheme); gated to Super-Admin via
// the existing 'config.global' permission (owner decision). Writing rows is safe regardless of the
// gateway PAYMENTS_ENABLED flag — enforcement is what the flag governs, not the data table.
const upsertSchema = z.object({
  guardian_email: z.string().email(),
  // Only tiers reachable this phase are accepted; a t250/t500 has no grant path yet.
  tier: z.enum(['free', 't50']),
  status: z.enum(['active', 'canceled', 'expired', 'pending']).default('active'),
  // ISO timestamp or null (no expiry). Optional.
  current_period_end: z.string().datetime().nullable().optional(),
});

export function registerAdminEntitlementsRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };

  // GET /v1/admin/entitlements?email= — read the current entitlement for a guardian email (for the UI to
  // show existing state before editing). Returns null when there is no row.
  app.get('/v1/admin/entitlements', guard, async (req) => {
    requirePermission(req, 'config.global');
    const email = String((req.query as any)?.email ?? '').trim().toLowerCase();
    if (!email) throw Errors.validation('email query param is required');
    const { rows } = await db.query(
      `select id, guardian_email, tier, status, current_period_end, seats, source, external_ref, updated_at
         from ccat.entitlements where lower(guardian_email) = $1 limit 1`,
      [email],
    );
    return { item: rows[0] ?? null, allowed_tiers: ALLOWED_TIERS };
  });

  // POST /v1/admin/entitlements — upsert a guardian's entitlement (source='manual').
  app.post('/v1/admin/entitlements', guard, async (req) => {
    requirePermission(req, 'config.global');
    const b = upsertSchema.parse(req.body);
    // Defense in depth: never store a tier outside the phase-reachable set.
    if (!ALLOWED_TIERS.includes(b.tier)) throw Errors.validation('Tier not available this phase');
    const email = b.guardian_email.trim().toLowerCase();

    // Best-effort link to an existing guardian contact by email (nullable; not required).
    const gc = await db.query(
      `select id from ccat.guardian_contacts where lower(email::text) = $1 limit 1`,
      [email],
    );
    const guardianId = gc.rows[0]?.id ?? null;

    const prev = await db.query(
      `select tier, status, current_period_end from ccat.entitlements where lower(guardian_email) = $1 limit 1`,
      [email],
    );

    const { rows } = await db.query(
      `insert into ccat.entitlements (guardian_email, guardian_id, tier, status, current_period_end, source)
       values ($1, $2, $3, $4, $5, 'manual')
       on conflict (lower(guardian_email)) do update
         set tier = excluded.tier,
             status = excluded.status,
             current_period_end = excluded.current_period_end,
             guardian_id = coalesce(excluded.guardian_id, ccat.entitlements.guardian_id),
             source = 'manual',
             updated_at = now()
       returning id, guardian_email, tier, status, current_period_end, source`,
      [email, guardianId, b.tier, b.status, b.current_period_end ?? null],
    );

    await db.query(
      `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, old_value, new_value)
       values ($1, 'admin', 'entitlement.changed', 'entitlement', $2, $3, $4)`,
      [
        req.admin!.adminId,
        rows[0]!.id,
        JSON.stringify(prev.rows[0] ?? null),
        JSON.stringify({ guardian_email: email, tier: b.tier, status: b.status, current_period_end: b.current_period_end ?? null }),
      ],
    );

    return { item: rows[0], paymentsEnabled: cfg.paymentsEnabled };
  });
}
