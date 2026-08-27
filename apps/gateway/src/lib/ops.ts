import type { DB } from '../db.js';

// ---------------------------------------------------------------------------
// Background-job registry + truthful run tracking (Blueprint §27).
// These are the Gateway's real in-process interval workers. Each records its
// actual last run into ccat.job_runs via recordJobRun; the console reads it.
// ---------------------------------------------------------------------------
export interface JobDef { key: string; name: string; interval_ms: number; description: string; pg_cron_in_prod: boolean }

export const JOB_DEFS: JobDef[] = [
  { key: 'overdue_finalizer', name: 'Overdue session finalizer', interval_ms: 15_000, description: 'Auto-submits sessions past their deadline (§14.4).', pg_cron_in_prod: false },
  { key: 'streak_reconcile', name: 'Streak reconciliation', interval_ms: 60 * 60 * 1000, description: 'Zeroes stale daily streaks so stored values match reality (§19).', pg_cron_in_prod: true },
  { key: 'announcement_publisher', name: 'Scheduled announcement publisher', interval_ms: 30_000, description: 'Publishes due scheduled announcements to the carousel (§26.1).', pg_cron_in_prod: true },
];

// Upsert a worker's real last-run. status 'ok' | 'error'. Never throws (best-effort telemetry).
export async function recordJobRun(db: DB, jobKey: string, status: 'ok' | 'error', detail?: string): Promise<void> {
  try {
    await db.query(
      `insert into ccat.job_runs(job_key,last_run_at,last_status,last_detail,runs_total,errors_total,updated_at)
         values ($1, now(), $2, $3, 1, case when $2='error' then 1 else 0 end, now())
       on conflict (job_key) do update set
         last_run_at = now(), last_status = excluded.last_status, last_detail = excluded.last_detail,
         runs_total = ccat.job_runs.runs_total + 1,
         errors_total = ccat.job_runs.errors_total + (case when excluded.last_status='error' then 1 else 0 end),
         updated_at = now()`,
      [jobKey, status, detail ?? null],
    );
  } catch { /* telemetry must never break the worker */ }
}

export async function loadJobStatus(db: DB): Promise<any[]> {
  const rows = await db.query(`select job_key,last_run_at,last_status,last_detail,runs_total,errors_total from ccat.job_runs`);
  const byKey = new Map(rows.rows.map((r: any) => [r.job_key, r]));
  return JOB_DEFS.map((d) => {
    const r: any = byKey.get(d.key);
    return {
      key: d.key, name: d.name, description: d.description,
      interval_ms: d.interval_ms, pg_cron_in_prod: d.pg_cron_in_prod,
      last_run_at: r?.last_run_at ?? null,
      last_status: r?.last_status ?? null,
      last_detail: r?.last_detail ?? null,
      runs_total: r ? Number(r.runs_total) : 0,
      errors_total: r ? Number(r.errors_total) : 0,
      // 'stale' if it has never run or hasn't run within 3× its interval.
      stale: !r?.last_run_at || (Date.now() - new Date(r.last_run_at).getTime()) > d.interval_ms * 3,
    };
  });
}

// ---------------------------------------------------------------------------
// Infrastructure service seam: backups / disaster recovery / failover.
// This deployment has no backup pipeline, replica, or failover orchestrator to
// drive, so the console must NOT show action buttons that can't act. Instead we
// expose a provider seam (like storage): a Null provider reports 'not
// configured', and a real provider (RDS/pg_basebackup/Patroni/etc.) can be wired
// via OPS_PROVIDER later WITHOUT changing the route or the UI contract.
// ---------------------------------------------------------------------------
export interface InfraCapability { configured: boolean; provider: string | null; state: string; detail: string }
export interface OpsInfrastructure { backup: InfraCapability; disaster_recovery: InfraCapability; failover: InfraCapability }
export interface OpsService { getInfrastructure(): Promise<OpsInfrastructure> }

class NullOpsService implements OpsService {
  async getInfrastructure(): Promise<OpsInfrastructure> {
    const notConfigured = (label: string): InfraCapability => ({
      configured: false, provider: null, state: 'Not configured',
      detail: `${label} is not provisioned in this environment. It is a managed-infrastructure concern (e.g. RDS automated backups, a standby replica, a failover orchestrator) and is wired via OPS_PROVIDER in production.`,
    });
    return {
      backup: notConfigured('Automated database backups'),
      disaster_recovery: notConfigured('Cross-region disaster recovery'),
      failover: notConfigured('Database failover'),
    };
  }
}

// Third-party providers the platform depends on (Blueprint §27 "third-party providers" panel).
// State is truthful: unless a real integration is configured via env, it reports 'not_configured'
// rather than a fabricated health/latency. A real provider health feed slots in here later.
export interface ProviderStatus { name: string; kind: string; configured: boolean; state: string; detail: string }
export function loadProviders(): ProviderStatus[] {
  const dep = (name: string, kind: string, envKey: string, detail: string): ProviderStatus => {
    const configured = !!process.env[envKey];
    return { name, kind, configured, state: configured ? 'Configured' : 'Not configured', detail: configured ? detail : `${detail} — not configured in this environment (${envKey}).` };
  };
  return [
    dep('SMS OTP', 'sms', 'SMS_PROVIDER_KEY', 'Guardian phone verification'),
    dep('Email OTP', 'email', 'EMAIL_PROVIDER_KEY', 'Guardian email verification'),
    dep('Push delivery', 'push', 'PUSH_PROVIDER_KEY', 'APNs / FCM campaign delivery'),
    dep('Object storage', 'storage', 'STORAGE_PROVIDER', 'Content asset storage (local disk in dev)'),
  ];
}

export function makeOpsService(): OpsService {
  const provider = process.env.OPS_PROVIDER; // unset → Null. Real providers slot in here later.
  switch (provider) {
    // case 'rds': return new RdsOpsService();  // future
    default: return new NullOpsService();
  }
}
