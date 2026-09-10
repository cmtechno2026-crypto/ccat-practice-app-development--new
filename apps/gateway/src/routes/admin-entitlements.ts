import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { makeAuthenticateAdmin, requirePermission } from '../plugins/adminAuth.js';
import { ALLOWED_TIERS, resolveEntitlement, resolveGuardianEmail, tierRank, tierUnlocksText, TIER_LABELS, type Tier } from '../lib/entitlements.js';
import { sendEmail } from '../lib/email.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Payments — MANUAL admin membership control. Upserts one ccat.entitlements row per guardian email
// (source='manual'), keyed case-insensitively. Protected by the EXISTING admin auth; gated to Super-Admin
// via 'config.global'. Writing rows is safe regardless of PAYMENTS_ENABLED — enforcement is what the flag
// governs. NEW this task: a site-wide default-plan lever, a grant_reason on every grant, and a per-student
// membership view/edit scoped by student id.
//
// grant_reason: default is 'comp' — an omitted reason is never treated as a payment. 'paid' is normally
// set by the Stripe webhook (a real, confirmed payment), but admins may also set it manually (e.g. to
// record a payment taken outside Stripe). A manual 'paid' grant is indistinguishable from a webhook one
// in the audit trail, so use it only for genuine payments.
const ADMIN_GRANT_REASONS = ['paid', 'sale', 'discount', 'comp', 'trial', 'other'] as const;

const upsertSchema = z.object({
  guardian_email: z.string().email(),
  tier: z.enum(['free', 't50', 't250', 't500']),
  status: z.enum(['active', 'canceled', 'expired', 'pending']).default('active'),
  current_period_end: z.string().datetime().nullable().optional(),
  // Defaults to 'comp'. 'paid' is accepted (manual payment record); still defaults to comp when omitted.
  grant_reason: z.enum(ADMIN_GRANT_REASONS).default('comp'),
});

const defaultPlanSchema = z.object({
  tier: z.enum(['free', 't50', 't250', 't500']),
  until: z.string().datetime().nullable().optional(), // null / omitted = no expiry
});

// Per-student membership edit — same effect as the email grant, but the guardian is resolved from the
// student id server-side (no email in the body).
const studentGrantSchema = z.object({
  tier: z.enum(['free', 't50', 't250', 't500']),
  grant_reason: z.enum(ADMIN_GRANT_REASONS).default('comp'),
  until: z.string().datetime().nullable().optional(),
});

export function registerAdminEntitlementsRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };

  // Shared upsert of a guardian's entitlement (source='manual'). Links guardian_id when the email matches
  // a guardian_contacts row, writes an audit entry, and returns the stored row.
  async function upsertGrant(
    adminId: string,
    email: string,
    tier: string,
    status: string,
    currentPeriodEnd: string | null,
    grantReason: string,
  ) {
    const gc = await db.query(
      `select id, name from ccat.guardian_contacts where lower(email::text) = $1 limit 1`,
      [email],
    );
    const guardianId = gc.rows[0]?.id ?? null;
    const guardianName = gc.rows[0]?.name ?? '';

    const prev = await db.query(
      `select tier, status, current_period_end, grant_reason from ccat.entitlements where lower(guardian_email) = $1 limit 1`,
      [email],
    );

    const { rows } = await db.query(
      `insert into ccat.entitlements (guardian_email, guardian_id, tier, status, current_period_end, source, grant_reason)
       values ($1, $2, $3, $4, $5, 'manual', $6)
       on conflict (lower(guardian_email)) do update
         set tier = excluded.tier,
             status = excluded.status,
             current_period_end = excluded.current_period_end,
             guardian_id = coalesce(excluded.guardian_id, ccat.entitlements.guardian_id),
             source = 'manual',
             grant_reason = excluded.grant_reason,
             updated_at = now()
       returning id, guardian_email, tier, status, current_period_end, source, grant_reason`,
      [email, guardianId, tier, status, currentPeriodEnd, grantReason],
    );

    await db.query(
      `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, old_value, new_value)
       values ($1, 'admin', 'entitlement.changed', 'entitlement', $2, $3, $4)`,
      [
        adminId,
        rows[0]!.id,
        JSON.stringify(prev.rows[0] ?? null),
        JSON.stringify({ guardian_email: email, tier, status, current_period_end: currentPeriodEnd, grant_reason: grantReason }),
      ],
    );

    // Tier-upgrade confirmation email (behind PAYMENTS_ENABLED; fire-and-forget). Only when the tier moved
    // UP and the new row is active — not on downgrade, cancel, or a same-tier re-save. This is the CCAT
    // "plan active" message (Stripe sends its own receipt separately).
    if (cfg.paymentsEnabled && status === 'active') {
      const p = prev.rows[0];
      const prevActive = p && p.status === 'active' && (p.current_period_end == null || new Date(p.current_period_end) > new Date());
      const prevRank = prevActive ? tierRank(p.tier as Tier) : 0; // inactive/none ⇒ free
      if (tierRank(tier as Tier) > prevRank) {
        const label = TIER_LABELS[tier as Tier] ?? tier;
        const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:15px;color:#1f2340">
          <h2 style="color:#5b3ff0;margin:0 0 8px">Your CCAT Practice plan has been updated</h2>
          <p>Hello ${escapeHtml(guardianName || 'there')},</p>
          <p>Your CCAT Practice account has been upgraded to the <strong>${label}</strong> plan.</p>
          <p>Your plan now includes:</p>
          <p>${tierUnlocksText(tier as Tier)}</p>
          <p>The upgraded features are available immediately.</p>
          <p style="color:#8a90a6;font-size:13px">— Concept Mastery · CCAT Practice</p>
        </div>`;
        void sendEmail(cfg, { to: email, subject: 'Your CCAT Practice plan has been updated', html }, app.log);
      }
    }
    return rows[0];
  }

  // GET /v1/admin/entitlements?email= — current entitlement + linked students for a guardian email.
  app.get('/v1/admin/entitlements', guard, async (req) => {
    requirePermission(req, 'config.global');
    const email = String((req.query as any)?.email ?? '').trim().toLowerCase();
    if (!email) throw Errors.validation('email query param is required');
    const { rows } = await db.query(
      `select id, guardian_email, tier, status, current_period_end, seats, source, grant_reason, external_ref, updated_at
         from ccat.entitlements where lower(guardian_email) = $1 limit 1`,
      [email],
    );
    const students = await db.query(
      `select s.display_name, s.username_normalized as username, s.status,
              g.grade_number, g.name as grade_name, sg.is_primary, sg.relationship
         from ccat.student_guardians sg
         join ccat.students s on s.id = sg.student_id
         join ccat.guardian_contacts gc on gc.id = sg.guardian_id
         left join ccat.grades g on g.id = s.grade_id
        where lower(gc.email::text) = $1
        order by sg.is_primary desc, s.display_name`,
      [email],
    );
    return { item: rows[0] ?? null, students: students.rows, allowed_tiers: ALLOWED_TIERS, grant_reasons: ADMIN_GRANT_REASONS };
  });

  // POST /v1/admin/entitlements — upsert a guardian's entitlement by email (source='manual').
  app.post('/v1/admin/entitlements', guard, async (req) => {
    requirePermission(req, 'config.global');
    const b = upsertSchema.parse(req.body);
    if (!ALLOWED_TIERS.includes(b.tier)) throw Errors.validation('Tier not available this phase');
    const email = b.guardian_email.trim().toLowerCase();
    const item = await upsertGrant(req.admin!.adminId, email, b.tier, b.status, b.current_period_end ?? null, b.grant_reason);
    return { item, paymentsEnabled: cfg.paymentsEnabled };
  });

  // ---- Default plan (site-wide promo lever) --------------------------------------------------------
  // Flag-gated: when PAYMENTS_ENABLED is off these are inactive (404), matching the rest of the no-op.

  // GET /v1/admin/settings/default-plan → { default_tier, default_until }.
  app.get('/v1/admin/settings/default-plan', guard, async (req) => {
    if (!cfg.paymentsEnabled) throw Errors.notFound('Payments are not enabled');
    requirePermission(req, 'config.global');
    const { rows } = await db.query(`select default_tier, default_until from ccat.app_settings where id = 1 limit 1`);
    const r = rows[0] ?? { default_tier: 'free', default_until: null };
    return { default_tier: r.default_tier, default_until: r.default_until };
  });

  // PUT /v1/admin/settings/default-plan { tier, until } → upsert the singleton row.
  app.put('/v1/admin/settings/default-plan', guard, async (req) => {
    if (!cfg.paymentsEnabled) throw Errors.notFound('Payments are not enabled');
    requirePermission(req, 'config.global');
    const b = defaultPlanSchema.parse(req.body);
    if (!ALLOWED_TIERS.includes(b.tier)) throw Errors.validation('Tier not available this phase');
    const prev = await db.query(`select default_tier, default_until from ccat.app_settings where id = 1 limit 1`);
    const { rows } = await db.query(
      `insert into ccat.app_settings (id, default_tier, default_until)
       values (1, $1, $2)
       on conflict (id) do update set default_tier = excluded.default_tier, default_until = excluded.default_until, updated_at = now()
       returning default_tier, default_until`,
      [b.tier, b.until ?? null],
    );
    await db.query(
      `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, old_value, new_value)
       values ($1, 'admin', 'default_plan.changed', 'config', null, $2, $3)`,
      [req.admin!.adminId, JSON.stringify(prev.rows[0] ?? null), JSON.stringify({ default_tier: b.tier, default_until: b.until ?? null })],
    );
    return { default_tier: rows[0]!.default_tier, default_until: rows[0]!.default_until };
  });

  // ---- Per-student membership (scoped by student id) ----------------------------------------------

  // GET /v1/admin/students/:id/membership → the student's guardian effective tier + source + expiry +
  // the stored entitlement row.
  app.get('/v1/admin/students/:id/membership', guard, async (req) => {
    if (!cfg.paymentsEnabled) throw Errors.notFound('Payments are not enabled');
    requirePermission(req, 'config.global');
    const studentId = String((req.params as any).id);
    const guardianEmail = await resolveGuardianEmail(db, studentId);
    const eff = await resolveEntitlement(db, studentId);
    let item: any = null;
    if (guardianEmail) {
      const { rows } = await db.query(
        `select id, guardian_email, tier, status, current_period_end, source, grant_reason, updated_at
           from ccat.entitlements where lower(guardian_email) = $1 limit 1`,
        [guardianEmail],
      );
      item = rows[0] ?? null;
    }
    return {
      guardian_email: guardianEmail,
      effective: {
        tier: eff.tier,
        source: eff.source,
        current_period_end: eff.currentPeriodEnd,
        promo_active: eff.promoActive,
        default_tier: eff.defaultTier,
      },
      item,
      allowed_tiers: ALLOWED_TIERS,
      grant_reasons: ADMIN_GRANT_REASONS,
    };
  });

  // POST /v1/admin/students/:id/membership { tier, grant_reason, until } — upsert the entitlement for THAT
  // student's guardian (email resolved server-side; no email in the body).
  app.post('/v1/admin/students/:id/membership', guard, async (req) => {
    if (!cfg.paymentsEnabled) throw Errors.notFound('Payments are not enabled');
    requirePermission(req, 'config.global');
    const studentId = String((req.params as any).id);
    const b = studentGrantSchema.parse(req.body);
    if (!ALLOWED_TIERS.includes(b.tier)) throw Errors.validation('Tier not available this phase');
    const guardianEmail = await resolveGuardianEmail(db, studentId);
    if (!guardianEmail) throw Errors.conflict('NO_GUARDIAN_EMAIL', 'This student has no guardian email on file');
    const item = await upsertGrant(req.admin!.adminId, guardianEmail, b.tier, 'active', b.until ?? null, b.grant_reason);
    return { item, guardian_email: guardianEmail };
  });
}
