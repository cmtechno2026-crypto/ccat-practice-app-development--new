import { loadEnv } from './lib/loadEnv.js';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { finalizeOverdueSessions } from './lib/finalize.js';
import { reconcileStreaks } from './lib/streaks.js';
import { publishScheduledAnnouncements } from './lib/comms.js';
import { recordJobRun } from './lib/ops.js';

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

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.warn({ signal }, 'Gateway shutting down');
  clearInterval(worker);
  clearInterval(streakWorker);
  clearInterval(annWorker);
  await Promise.allSettled([app.close(), workerPool.end()]);
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

app
  .listen({ port: cfg.port, host: cfg.host })
  .then((addr) => app.log.warn(`CCAT Gateway listening on ${addr} (env=${cfg.env})`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
