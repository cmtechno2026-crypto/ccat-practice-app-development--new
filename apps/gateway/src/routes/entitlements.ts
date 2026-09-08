import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { resolveEntitlement, CAPABILITIES_UNLOCKED_ALL } from '../lib/entitlements.js';

// GET /v1/entitlements/me — the authenticated student's effective membership + capabilities.
// Payments Phase 2. Read-only; the guardian is resolved from the session, never from the client.
export function registerEntitlementsRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  app.get('/v1/entitlements/me', { preHandler: [app.authenticateStudent] }, async (req) => {
    // Flag OFF → payments inactive: return capabilities that unlock EVERYTHING so a client that calls
    // this endpoint by accident can never lock the (free-for-all) production experience.
    if (!cfg.paymentsEnabled) {
      return {
        paymentsEnabled: false,
        tier: 'free' as const,
        capabilities: CAPABILITIES_UNLOCKED_ALL,
        status: 'inactive',
        currentPeriodEnd: null,
      };
    }
    const ent = await resolveEntitlement(db, req.student!.studentId);
    return {
      paymentsEnabled: true,
      tier: ent.tier,                 // effective, clamped tier ('free' | 't50' this phase)
      capabilities: ent.capabilities,
      status: ent.status,
      currentPeriodEnd: ent.currentPeriodEnd,
    };
  });
}
