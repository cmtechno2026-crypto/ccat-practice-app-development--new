import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { makeAuthenticateAdmin, requireSuperAdmin } from '../plugins/adminAuth.js';

// Dashboard KPIs + product-health console (Blueprint §27). Read-only aggregates.
export function registerAdminDashboardRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  const authenticateAdmin = makeAuthenticateAdmin(db, cfg.hmacSecret);

  // Windowed KPI dashboard (Blueprint §27). ?window=7|30|90 days. Each hero card carries a delta
  // vs the immediately preceding window of equal length, so trends are real, not cosmetic. All
  // aggregates are indexed reads; safe to serve frequently and cache at the edge for a minute.
  const WINDOWS = new Set([7, 30, 90]);
  app.get('/v1/admin/dashboard', { preHandler: [authenticateAdmin] }, async (req) => {
    const qp = req.query as { window?: string };
    const w = WINDOWS.has(Number(qp.window)) ? Number(qp.window) : 7;
    const q = async (sql: string, params: any[] = []) => (await db.query(sql, params)).rows[0]!;
    const pct = (cur: number, prev: number): number | null => prev === 0 ? (cur > 0 ? 100 : null) : Math.round(((cur - prev) / prev) * 1000) / 10;

    // hero: active students (distinct with a session), current vs previous window
    const act = await q(
      `select
         count(distinct student_id) filter (where started_at >= now() - make_interval(days => $1))::int cur,
         count(distinct student_id) filter (where started_at >= now() - make_interval(days => 2*$1) and started_at < now() - make_interval(days => $1))::int prev
       from ccat.sessions where student_id not in (select id from ccat.students where is_preview)`, [w]);
    // hero: sessions scored (terminal ok) + success rate + dead-letter (non-scored terminals)
    const scored = await q(
      `select
         count(*) filter (where created_at >= now() - make_interval(days => $1) and terminal_state in ('SUBMITTED','AUTO_SUBMITTED'))::int cur,
         count(*) filter (where created_at >= now() - make_interval(days => 2*$1) and created_at < now() - make_interval(days => $1) and terminal_state in ('SUBMITTED','AUTO_SUBMITTED'))::int prev,
         count(*) filter (where created_at >= now() - make_interval(days => $1))::int cur_total,
         count(*) filter (where created_at >= now() - make_interval(days => $1) and terminal_state not in ('SUBMITTED','AUTO_SUBMITTED'))::int dead_letter
       from ccat.session_results where session_id in (select id from ccat.sessions where student_id not in (select id from ccat.students where is_preview))`, [w]);
    const successPct = scored.cur_total > 0 ? Math.round((1000 * scored.cur) / scored.cur_total) / 10 : null;
    // hero: avg readiness (latest per student, non-insufficient) + delta from windowed averages
    const readHead = await q(`select round(avg(readiness_pct))::int v from (
        select distinct on (student_id) readiness_pct, insufficient_data
        from ccat.readiness_snapshots order by student_id, computed_at desc) t where not insufficient_data`);
    const readWin = await q(
      `select
         avg(readiness_pct) filter (where computed_at >= now() - make_interval(days => $1))::float cur,
         avg(readiness_pct) filter (where computed_at >= now() - make_interval(days => 2*$1) and computed_at < now() - make_interval(days => $1))::float prev
       from ccat.readiness_snapshots where not insufficient_data`, [w]);
    const readDelta = (readWin.cur != null && readWin.prev != null) ? Math.round(readWin.cur - readWin.prev) : null;

    const students = await q(`select
        count(*)::int total,
        count(*) filter (where status='active')::int active,
        count(*) filter (where status='suspended')::int suspended,
        count(*) filter (where status='banned')::int banned,
        count(*) filter (where status='pending_deletion')::int pending_deletion,
        count(*) filter (where created_at > now() - make_interval(days => $1))::int new_in_window
      from ccat.students where status <> 'purged' and is_preview = false`, [w]);
    const sessions = await q(`select
        count(*) filter (where state='IN_PROGRESS')::int in_progress,
        count(*) filter (where state in ('SUBMITTED','AUTO_SUBMITTED') and terminal_at > now() - interval '24 hours')::int completed_24h
      from ccat.sessions where student_id not in (select id from ccat.students where is_preview)`);
    const content = await q(`select
        (select count(*) from ccat.question_versions where state='published')::int published_questions,
        (select count(*) from ccat.question_versions where state in ('draft','automated_checks','expert_review'))::int pending_questions,
        (select count(*) from ccat.question_set_versions where state='published')::int published_sets`);
    const incidents = await q(`select count(*) filter (where state<>'resolved')::int open from ccat.incident_records`);
    const rewards = await q(`select coalesce(sum(delta),0)::bigint xp_all from ccat.xp_transactions where student_id not in (select id from ccat.students where is_preview)`);
    const flags = await db.query(`select key, value from ccat.global_flags where value = true`);
    const recent = await db.query(
      `select event_type, target_kind, reason, created_at, request_id,
              (select display_name from ccat.admin_profiles ap where ap.id = a.actor_admin_id) as actor
         from ccat.audit_log a order by created_at desc limit 8`);

    // platform state (§30 emergency flags + §27 health). Truthful precedence.
    const flagKeys = flags.rows.map((r) => r.key as string);
    const maint = flagKeys.includes('maintenance_mode');
    let platform_state: { label: string; tone: string; note: string };
    if (maint) platform_state = { label: 'Maintenance', tone: 'amber', note: 'Maintenance mode is on — students cannot start new sessions.' };
    else if (flagKeys.length > 0) platform_state = { label: 'Restricted', tone: 'amber', note: `Emergency control active: ${flagKeys.join(', ')}.` };
    else if (incidents.open > 0) platform_state = { label: 'Incident', tone: 'coral', note: `${incidents.open} open incident${incidents.open > 1 ? 's' : ''}.` };
    else if (successPct != null && successPct < 99) platform_state = { label: 'Degraded', tone: 'amber', note: `Session success ${successPct}% in the last ${w} days.` };
    else platform_state = { label: 'Ready', tone: 'green', note: 'Practice is healthy across all grades. Nothing needs attention right now.' };

    return {
      window: w,
      hero: {
        active_students: { value: act.cur, delta_pct: pct(act.cur, act.prev) },
        sessions_scored: { value: scored.cur, delta_pct: pct(scored.cur, scored.prev) },
        avg_readiness: { value: readHead.v ?? null, delta_pts: readDelta },
        session_success: { value_pct: successPct, dead_letter: scored.dead_letter, total: scored.cur_total },
      },
      platform_state,
      summary: platform_state.note,
      // backward-compatible + secondary
      students: { ...students, new_7d: students.new_in_window },
      sessions, content,
      open_incidents: incidents.open,
      xp_awarded_total: Number(rewards.xp_all),
      recent_activity: recent.rows,
    };
  });

  // Product-health console (§27.1). Blends stored snapshots with a few live checks.
  // Super-Admin only (owner decision 4-c): Service health is a governance surface.
  app.get('/v1/admin/health', { preHandler: [authenticateAdmin] }, async (req) => {
    requireSuperAdmin(req);
    const indicators: { indicator: string; state: string; value: number | null; detail?: string }[] = [];
    // Live: DB reachable + basic success proxies.
    let dbOk = true; try { await db.query('select 1'); } catch { dbOk = false; }
    indicators.push({ indicator: 'gateway', state: 'Healthy', value: null });
    indicators.push({ indicator: 'database', state: dbOk ? 'Healthy' : 'Major Incident', value: null });

    const subOk = await db.query(`select
        count(*) filter (where terminal_state in ('SUBMITTED','AUTO_SUBMITTED'))::int ok,
        count(*)::int total from ccat.session_results where created_at > now() - interval '24 hours' and session_id in (select id from ccat.sessions where student_id not in (select id from ccat.students where is_preview))`);
    const r = subOk.rows[0]!;
    const rate = r.total > 0 ? Math.round((100 * r.ok) / r.total) : null;
    indicators.push({ indicator: 'session_submit', state: rate === null ? 'Unknown' : rate >= 99 ? 'Healthy' : 'Degraded', value: rate, detail: `${r.ok}/${r.total} last 24h` });

    // Reward reconciliation (cache vs ledger).
    const recon = await db.query(`select count(*)::int bad from (
        select s.id from ccat.students s
        where s.is_preview = false and s.cached_xp_total <> coalesce((select sum(delta) from ccat.xp_transactions x where x.student_id=s.id),0)) t`);
    const bad = recon.rows[0]!.bad as number;
    indicators.push({ indicator: 'reward_reconciliation', state: bad === 0 ? 'Healthy' : 'Major Incident', value: bad, detail: bad === 0 ? 'in balance' : `${bad} mismatches` });

    // Stored snapshots (latest per indicator).
    const snaps = await db.query(`select distinct on (indicator) indicator, state, value, observed_at
        from ccat.health_snapshots order by indicator, observed_at desc`);
    for (const s of snaps.rows) indicators.push({ indicator: s.indicator, state: s.state, value: s.value === null ? null : Number(s.value) });

    const worst = indicators.some(i => i.state === 'Major Incident') ? 'Major Incident'
      : indicators.some(i => i.state === 'Degraded') ? 'Degraded'
      : indicators.some(i => i.state === 'Unknown') ? 'Degraded' : 'Healthy';
    const incidents = await db.query(`select id, title, severity, state, opened_at from ccat.incident_records order by opened_at desc limit 10`);
    return { overall: worst, indicators, incidents: incidents.rows };
  });
}
