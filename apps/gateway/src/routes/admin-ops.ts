import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { makeAuthenticateAdmin, requireSuperAdmin } from '../plugins/adminAuth.js';
import { loadJobStatus, makeOpsService, loadProviders } from '../lib/ops.js';

// Service Health — operational sub-console (Blueprint §27): background-job status and the
// backups/DR/failover posture. Read-only and truthful: job rows reflect the Gateway's real
// interval workers; infrastructure capability comes from a provider seam that reports
// 'not configured' until real infra (OPS_PROVIDER) is wired. No action buttons that can't act.
export function registerAdminOpsRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);
  const guard = { preHandler: [authenticateAdmin] };
  const ops = makeOpsService();

  app.get('/v1/admin/ops/jobs', guard, async (req) => {
    requireSuperAdmin(req);
    return { jobs: await loadJobStatus(db) };
  });

  app.get('/v1/admin/ops/infrastructure', guard, async (req) => {
    requireSuperAdmin(req);
    return await ops.getInfrastructure();
  });

  app.get('/v1/admin/ops/providers', guard, async (req) => {
    requireSuperAdmin(req);
    return { providers: loadProviders() };
  });
}
