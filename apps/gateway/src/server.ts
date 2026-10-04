import { loadEnv } from './lib/loadEnv.js';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { finalizeOverdueSessions } from './lib/finalize.js';
import { reconcileStreaks } from './lib/streaks.js';
import { publishScheduledAnnouncements } from './lib/comms.js';
import { recordJobRun } from './lib/ops.js';
import { runTeacherSlaTick } from './lib/teacher-sla.js';

loadEnv(); // populate process.env from .env before any config is read
const cfg = loadConfig();
const app = await buildApp(cfg);

// Durable overdue-session finalization worker (Blueprint §14.4). Runs on an interval; the DB's
// exactly-once constraints make it safe to run alongside deadline-aware request guards.
const workerPool = createPool(cfg.databaseUrl);
const WORKER_INTERVAL_MS = 15_000;
const worker = setInterval(() => {
  finalizeOverdueSessions(workerPool)
    .then((n) => { if (n > 0) app.log.info({ finalized: n }, 'overdue sessions auto-submitted'); return recordJobRun(workerPool, 'overdue_finalizer', 'ok', n > 0 ? `${n} finalized` : 'idle'); })
    .catch((err) => { app.log.error({ err }, 'overdue finalizer failed'); return recordJobRun(workerPool, 'overdue_finalizer', 'error', String(err?.message ?? err)); });
}, WORKER_INTERVAL_MS);
worker.unref();

// Streak reconciliation (Blueprint §19): persist the zeroing of stale streaks hourly so stored
// values match reality for analytics. Reads compute the effective value too, so this is
// housekeeping; in production it can also run via pg_cron (see migration 0009). Runs once at
// boot, then hourly.
const STREAK_RECONCILE_MS = 60 * 60 * 1000;
const reconcile = () => reconcileStreaks(workerPool)
  .then((n) => { if (n > 0) app.log.info({ reset: n }, 'stale streaks reconciled'); return recordJobRun(workerPool, 'streak_reconcile', 'ok', n > 0 ? `${n} reset` : 'idle'); })
  .catch((err) => { app.log.error({ err }, 'streak reconcile failed'); return recordJobRun(workerPool, 'streak_reconcile', 'error', String(err?.message ?? err)); });
reconcile();
const streakWorker = setInterval(reconcile, STREAK_RECONCILE_MS);
streakWorker.unref();

// Scheduled-announcement publisher (Blueprint §26.1). Every 30s (pg_cron in prod, see 0010).
const annWorker = setInterval(() => {
  publishScheduledAnnouncements(workerPool)
    .then((n) => { if (n > 0) app.log.info({ published: n }, 'scheduled announcements published'); return recordJobRun(workerPool, 'announcement_publisher', 'ok', n > 0 ? `${n} published` : 'idle'); })
    .catch((err) => { app.log.error({ err }, 'announcement scheduler failed'); return recordJobRun(workerPool, 'announcement_publisher', 'error', String(err?.message ?? err)); });
}, 30_000);
annWorker.unref();

// Teacher acceptance SLA (24h): remind the teacher ~1h before expiry, then auto-decline still-pending
// requested slots and notify teacher / parent / admin. Runs against the TeacherHub ("cm-whiteboard")
// DB. Every 15 min, so the one-hour reminder always lands inside its window.
const teacherPool = cfg.teacherDatabaseUrl ? createPool(cfg.teacherDatabaseUrl) : null;
if (teacherPool) {
  const SLA_INTERVAL_MS = 15 * 60 * 1000;
  const slaTick = () => runTeacherSlaTick(teacherPool, cfg, app.log)
    .then((r) => { if (r.reminded || r.expired) app.log.info(r, 'teacher accept SLA tick'); return recordJobRun(workerPool, 'teacher_accept_sla', 'ok', (r.reminded || r.expired) ? `reminded ${r.reminded}, expired ${r.expired}` : 'idle'); })
    .catch((err) => { app.log.error({ err }, 'teacher accept SLA tick failed'); return recordJobRun(workerPool, 'teacher_accept_sla', 'error', String(err?.message ?? err)); });
  slaTick();
  const slaWorker = setInterval(slaTick, SLA_INTERVAL_MS);
  slaWorker.unref();
}

app
  .listen({ port: cfg.port, host: cfg.host })
  .then((addr) => app.log.warn(`CCAT Gateway listening on ${addr} (env=${cfg.env})`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
