import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { createPool, type DB } from './db.js';
import { AppError, toEnvelope } from './errors.js';
import { ZodError } from 'zod';
import { makeAuthenticateStudent, type StudentContext } from './plugins/auth.js';
import { registerRegistrationRoutes } from './routes/registration.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerCatalogRoutes, registerHealthRoutes } from './routes/catalog.js';
import { registerRewardsRoutes } from './routes/rewards.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerRecoveryRoutes } from './routes/recovery.js';
import { registerBookmarkRoutes } from './routes/bookmarks.js';
import { registerCustomizationRoutes } from './routes/customization.js';
import { registerContentRoutes } from './routes/content.js';
import { registerPracticeRoutes } from './routes/practice.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerReferralRoutes } from './routes/referrals.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAdminDashboardRoutes } from './routes/admin-dashboard.js';
import { registerAdminContentRoutes } from './routes/admin-content.js';
import { registerAdminContentAuthoringRoutes } from './routes/admin-content-authoring.js';
import { registerAdminConfigRoutes } from './routes/admin-config.js';
import { registerAdminRewardsRoutes } from './routes/admin-rewards.js';
import { registerAdminEconomyRoutes } from './routes/admin-economy.js';
import { registerAdminCommsRoutes } from './routes/admin-comms.js';
import { registerAdminAccountsRoutes } from './routes/admin-accounts.js';
import { registerAdminStudentDetailRoutes } from './routes/admin-students.js';
import { registerAdminOpsRoutes } from './routes/admin-ops.js';
import { registerAssetRoutes } from './routes/assets.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticateStudent: (req: any, reply: any) => Promise<void>;
    db: DB;
  }
}

export async function buildApp(cfg: Config, existingPool?: DB): Promise<FastifyInstance> {
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: cfg.env === 'local' ? { level: 'warn' } : { level: 'info' },
  });

  // Tolerate an empty body on JSON requests (e.g. bodyless DELETE/POST that still send
  // content-type: application/json) → treat as no body rather than a parse error.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = typeof body === 'string' ? body.trim() : '';
    if (s === '') { done(null, undefined); return; }
    try { done(null, JSON.parse(s)); }
    catch (e) { (e as any).statusCode = 400; done(e as Error, undefined); }
  });

  const db = existingPool ?? createPool(cfg.databaseUrl);
  app.decorate('db', db);
  app.decorate('authenticateStudent', makeAuthenticateStudent(db, cfg.hmacSecret));

  // Security headers (Blueprint §33, §36.2). Minimal set; a full CSP lands with Admin Web.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  // CORS for the browser clients (student Web + Admin Console — distinct origins). Local/dev is
  // permissive; production pins an explicit allowlist built from ADMIN_WEB_ORIGIN and WEB_APP_ORIGIN
  // (each may be a comma-separated list). An unlisted origin gets no CORS headers (request blocked).
  const prodOrigins = new Set(
    [process.env.ADMIN_WEB_ORIGIN, process.env.WEB_APP_ORIGIN]
      .filter(Boolean)
      .flatMap((v) => v!.split(',').map((s) => s.trim()).filter(Boolean)),
  );
  await app.register(cors, {
    origin: cfg.env === 'production'
      ? (origin, cb) => {
          // Non-browser callers (curl, server-to-server) send no Origin — allow them through.
          if (!origin || prodOrigins.has(origin)) return cb(null, true);
          return cb(null, false);
        }
      : true,
    credentials: true,
    // The Admin SPA uses PATCH (set/exam-paper edits, question activation) and DELETE (hard-delete),
    // so the preflight allow-list must include them — the default omitted PATCH/PUT/DELETE.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    exposedHeaders: ['ETag'],
  });

  // Rate limiting — fail closed by default policy (§36.4). Per-route limits refined later.
  await app.register(rateLimit, {
    global: true,
    // Production keeps a tight default (per-route limits refine it, §36.4). Local/dev/test raise
    // it so smoke scripts and the Admin SPA aren't throttled.
    max: cfg.env === 'production' ? 100 : 5000,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });

  // Structured error envelope (§32.1).
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const e = new AppError(422, 'VALIDATION_ERROR', 'Request validation failed', { issues: err.issues });
      const { statusCode, body } = toEnvelope(e, req.id);
      return reply.code(statusCode).send(body);
    }
    if (err instanceof AppError) {
      const { statusCode, body } = toEnvelope(err, req.id);
      return reply.code(statusCode).send(body);
    }
    // @fastify/rate-limit sets statusCode 429
    if ((err as any).statusCode === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Rate limited', request_id: req.id } });
    }
    // Framework errors (bad JSON, payload too large, etc.) carry their own 4xx status.
    const fwStatus = (err as any).statusCode as number | undefined;
    if (fwStatus && fwStatus >= 400 && fwStatus < 500) {
      return reply.code(fwStatus).send({ error: { code: (err as any).code ?? 'BAD_REQUEST', message: (err as Error).message, request_id: req.id } });
    }
    req.log.error({ err }, 'unhandled error');
    const { statusCode, body } = toEnvelope(err, req.id);
    return reply.code(statusCode).send(body);
  });

  // Routes
  registerHealthRoutes(app, db);
  registerAssetRoutes(app, db, cfg);
  registerCatalogRoutes(app, db);
  registerRegistrationRoutes(app, db, cfg);
  registerAuthRoutes(app, db, cfg);
  registerRecoveryRoutes(app, db, cfg);
  registerDeviceRoutes(app, db, cfg);
  registerSessionRoutes(app, db, cfg);
  registerRewardsRoutes(app, db);
  registerBookmarkRoutes(app, db);
  registerCustomizationRoutes(app, db);
  registerContentRoutes(app, db, cfg);
  registerPracticeRoutes(app, db);
  registerSupportRoutes(app, db);
  registerAccountRoutes(app, db);
  registerReferralRoutes(app, db);
  registerAdminRoutes(app, db, cfg);
  registerAdminDashboardRoutes(app, db, cfg);
  registerAdminStudentDetailRoutes(app, db, cfg);
  registerAdminContentRoutes(app, db, cfg);
  registerAdminContentAuthoringRoutes(app, db, cfg);
  registerAdminConfigRoutes(app, db, cfg);
  registerAdminRewardsRoutes(app, db, cfg);
  registerAdminEconomyRoutes(app, db, cfg);
  registerAdminCommsRoutes(app, db, cfg);
  registerAdminAccountsRoutes(app, db, cfg);
  registerAdminOpsRoutes(app, db, cfg);

  return app;
}
