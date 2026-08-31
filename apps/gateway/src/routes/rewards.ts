import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { loadEconomyConfig } from '../lib/economyConfig.js';

// Human label for a coin ledger row — prefers the stored reason, else a kind label. Never fabricates.
function coinLabel(sourceKind: string, reason: string | null): string {
  if (reason && reason.trim()) return reason;
  switch (sourceKind) {
    case 'streak_milestone': return 'Streak bonus';
    case 'admin_adjustment': return 'Adjustment';
    case 'achievement': return 'Achievement reward';
    case 'session': return 'Practice reward';
    case 'referral': return 'Referral reward';
    default: return sourceKind.replace(/_/g, ' ');
  }
}

function describeCriteria(c: { type?: string; threshold?: number } | null): string {
  if (!c) return '';
  if (c.type === 'first_completion') return 'Finish your first practice set.';
  if (c.type === 'perfect_set') return 'Score full marks on a set.';
  if (c.type === 'xp_total') return `Reach ${c.threshold ?? 0} total XP.`;
  return '';
}

// Partial progress toward an unearned achievement (0–100) + an actionable how-to hint, from the
// student's current stats. Earned achievements are always 100%. Keeps the "how close am I" UX
// honest without fabricating — everything derives from real ledger/session counts.
function progressFor(
  c: { type?: string; threshold?: number } | null,
  stats: { xp: number; completions: number; perfects: number },
): { pct: number; howto: string } {
  if (!c) return { pct: 0, howto: '' };
  if (c.type === 'first_completion') {
    const done = stats.completions > 0;
    return { pct: done ? 100 : 0, howto: done ? '' : 'Finish any practice set to unlock.' };
  }
  if (c.type === 'perfect_set') {
    const done = stats.perfects > 0;
    return { pct: done ? 100 : 0, howto: done ? '' : 'Score full marks on any set to unlock.' };
  }
  if (c.type === 'xp_total') {
    const t = c.threshold ?? 0;
    if (t <= 0) return { pct: 100, howto: '' };
    const pct = Math.max(0, Math.min(100, Math.round((100 * stats.xp) / t)));
    const remaining = Math.max(0, t - stats.xp);
    return { pct, howto: remaining > 0 ? `${remaining} more XP to go.` : '' };
  }
  return { pct: 0, howto: '' };
}

export function registerRewardsRoutes(app: FastifyInstance, db: DB) {
  // GET /v1/rewards/summary — balances from authoritative ledgers (§19). Cached values are a
  // convenience; here we sum the ledger so the number is always correct.
  app.get('/v1/rewards/summary', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const xpRow = await db.query(`select coalesce(sum(delta),0)::bigint as v from ccat.xp_transactions where student_id=$1`, [sid]);
    const coin = await db.query(`select coalesce(sum(delta),0)::bigint as v from ccat.coin_transactions where student_id=$1`, [sid]);
    const xp = Number(xpRow.rows[0]!.v);

    // Daily streak (§19, Option A): effective current is 0 once a full day is missed; longest is all-time.
    const stk = await db.query(
      `select case when last_active_day >= (now() at time zone s.timezone)::date - 1 then ss.current_streak else 0 end as current,
              ss.longest_streak as longest
         from ccat.student_streaks ss join ccat.students s on s.id = ss.student_id where ss.student_id=$1`, [sid]);
    const streakCore = stk.rows[0] ? { current: Number(stk.rows[0].current), longest: Number(stk.rows[0].longest) } : { current: 0, longest: 0 };

    // Last 7 local days (oldest→newest, ending today): a day is "active" if the student FINALIZED a
    // session that day (terminal_at set) — the same signal the streak is bumped from. New accounts →
    // every day inactive (no crash, empty row). Uses the student's own timezone, mirroring the streak.
    const last7q = await db.query(
      `with tz as (select timezone from ccat.students where id=$1)
       select to_char(gs::date,'YYYY-MM-DD') as date,
              exists(
                select 1 from ccat.sessions s
                 where s.student_id=$1 and s.terminal_at is not null
                   and (s.terminal_at at time zone (select timezone from tz))::date = gs::date
              ) as active
         from generate_series(
                ((now() at time zone (select timezone from tz))::date - 6),
                ((now() at time zone (select timezone from tz))::date),
                interval '1 day') gs
        order by gs`, [sid]);
    const last7 = last7q.rows.map((r) => ({ date: String(r.date), active: r.active === true }));

    // Level model — the step is server-owned (economy config, default 500 XP/level). No client math.
    const cfg = await loadEconomyConfig(db);
    const step = cfg.level_step_xp > 0 ? cfg.level_step_xp : 500;
    const level = Math.floor(xp / step) + 1;
    const floorXp = (level - 1) * step;
    const nextLevelXpTotal = level * step;
    const levelInfo = {
      level,
      xp_into_level: xp - floorXp,
      xp_for_level: step,
      xp_to_next: Math.max(0, nextLevelXpTotal - xp),
      next_level_xp_total: nextLevelXpTotal,
    };

    // Next reward — the nearest XP-gated unlock the student hasn't reached/owned yet, from the SAME
    // sources the customization endpoints read (avatar_stages.required_xp and theme xp_total unlock
    // rules). Null once everything XP-gated is unlocked. No thresholds hardcoded here.
    const nr = await db.query(
      `with cand as (
         select st.name as label, 'avatar' as kind, st.required_xp::bigint as target
           from ccat.avatar_stages st
           join ccat.avatar_families f on f.id = st.family_id and f.active = true
          where st.active = true and st.required_xp is not null and st.required_xp > $2
            and not exists (select 1 from ccat.student_avatar_grants g where g.student_id=$1 and g.avatar_stage_id=st.id)
         union all
         select t.name as label, 'theme' as kind, (r.rule_expr->>'threshold')::bigint as target
           from ccat.themes t
           join lateral (
             select rule_expr from ccat.theme_unlock_rules r
              where r.theme_id = t.id and r.active = true
              order by version_number desc limit 1
           ) r on true
          where t.active = true and r.rule_expr->>'type' = 'xp_total'
            and (r.rule_expr->>'threshold')::bigint > $2
            and not exists (select 1 from ccat.student_theme_grants g where g.student_id=$1 and g.theme_id=t.id)
       )
       select label, kind, target from cand where target is not null order by target asc limit 1`,
      [sid, xp]);
    let next_reward: { label: string; kind: string; target_xp: number; xp_needed: number; progress_pct: number } | null = null;
    if (nr.rows[0]) {
      const target = Number(nr.rows[0].target);
      next_reward = {
        label: String(nr.rows[0].label),
        kind: String(nr.rows[0].kind),
        target_xp: target,
        xp_needed: Math.max(0, target - xp),
        progress_pct: target > 0 ? Math.max(0, Math.min(100, Math.round((100 * xp) / target))) : 0,
      };
    }

    return {
      xp_total: xp,
      coin_balance: Number(coin.rows[0]!.v),
      streak: { ...streakCore, last7 },
      level: levelInfo,
      next_reward,
    };
  });

  // GET /v1/rewards/coins — coin balance + recent ledger history + the streak-milestone ladder.
  // Everything derives from real ledgers/config: history is the coin_transactions rows; the ladder's
  // amounts are the versioned economy config (same source the finalizer grants from); a rung is
  // "reached" only if its milestone bonus was actually granted (present in the ledger).
  app.get('/v1/rewards/coins', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const bal = await db.query(`select coalesce(sum(delta),0)::bigint as v from ccat.coin_transactions where student_id=$1`, [sid]);
    const hist = await db.query(
      `select delta, source_kind, reason, created_at
         from ccat.coin_transactions where student_id=$1
        order by created_at desc, id desc limit 30`, [sid]);
    const stk = await db.query(
      `select case when ss.last_active_day >= (now() at time zone s.timezone)::date - 1 then ss.current_streak else 0 end as current
         from ccat.student_streaks ss join ccat.students s on s.id = ss.student_id where ss.student_id=$1`, [sid]);
    const currentStreak = stk.rows[0] ? Number(stk.rows[0].current) : 0;
    // Which milestone rungs were actually paid out (exactly-once source_id = the streak length).
    const granted = await db.query(
      `select source_id from ccat.coin_transactions where student_id=$1 and source_kind='streak_milestone'`, [sid]);
    const grantedDays = new Set(granted.rows.map((r) => String(r.source_id)));
    const cfg = await loadEconomyConfig(db);
    const ladder = Object.entries(cfg.streak_milestones)
      .map(([day, coins]) => ({ day: Number(day), coins: Number(coins) }))
      .sort((a, b) => a.day - b.day)
      .map((rung) => ({ ...rung, reached: grantedDays.has(String(rung.day)) }));
    const nextRung = ladder.find((r) => !r.reached) ?? null;
    return {
      coin_balance: Number(bal.rows[0]!.v),
      current_streak: currentStreak,
      history: hist.rows.map((r) => ({
        delta: Number(r.delta), label: coinLabel(r.source_kind, r.reason),
        source_kind: r.source_kind, created_at: r.created_at,
      })),
      ladder,
      next: nextRung ? { day: nextRung.day, coins: nextRung.coins, days_to_go: Math.max(0, nextRung.day - currentStreak) } : null,
    };
  });

  // GET /v1/achievements — active achievements with the student's earned status + partial
  // progress toward unearned ones (§32.5, §19.4). Progress/how-to derive from real ledger counts.
  app.get('/v1/achievements', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid0 = req.student!.studentId;
    const xpAgg = await db.query(`select coalesce(sum(delta),0)::bigint as v from ccat.xp_transactions where student_id=$1`, [sid0]);
    const compAgg = await db.query(`select count(*)::int as n from ccat.set_completions where student_id=$1`, [sid0]);
    const perfAgg = await db.query(
      `select count(*)::int as n from ccat.session_results where session_id in
         (select id from ccat.sessions where student_id=$1) and score_total > 0 and score_correct = score_total`,
      [sid0],
    );
    const stats = { xp: Number(xpAgg.rows[0]!.v), completions: compAgg.rows[0]!.n as number, perfects: perfAgg.rows[0]!.n as number };
    const { rows } = await db.query(
      `select a.key, a.name, av.id as version_id, av.criteria,
              sa.created_at as earned_at,
              coalesce(json_agg(json_build_object('kind', ar.reward_kind, 'xp', ar.xp_amount, 'coins', ar.coin_amount))
                       filter (where ar.id is not null), '[]') as rewards
         from ccat.achievement_versions av
         join ccat.achievements a on a.id = av.achievement_id
         left join ccat.achievement_rewards ar on ar.achievement_version_id = av.id
         left join ccat.student_achievements sa on sa.achievement_version_id = av.id and sa.student_id = $1
        where av.active = true
        group by a.key, a.name, av.id, av.criteria, sa.created_at
        order by (sa.created_at is null), a.name`,
      [req.student!.studentId],
    );
    return rows.map((r) => {
      const earned = r.earned_at != null;
      const pr = earned ? { pct: 100, howto: '' } : progressFor(r.criteria, stats);
      return {
        key: r.key,
        name: r.name,
        description: describeCriteria(r.criteria),
        earned,
        earned_at: r.earned_at,
        rewards: r.rewards,
        progress_pct: pr.pct,
        howto: pr.howto,
      };
    });
  });

  // GET /v1/readiness — latest snapshot (§16). insufficient_data instead of 0%.
  app.get('/v1/readiness', { preHandler: [app.authenticateStudent] }, async (req) => {
    const { rows } = await db.query(
      `select readiness_pct, insufficient_data, band, window_questions
         from ccat.readiness_snapshots where student_id=$1 order by computed_at desc limit 1`,
      [req.student!.studentId],
    );
    if (rows.length === 0) return { readiness_pct: null, insufficient_data: true, band: null, window_questions: 0 };
    const r = rows[0]!;
    return {
      readiness_pct: r.readiness_pct === null ? null : Number(r.readiness_pct),
      insufficient_data: r.insufficient_data,
      band: r.band,
      window_questions: r.window_questions,
    };
  });

  // GET /v1/progress — versioned learning-plan coverage (§15).
  app.get('/v1/progress', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const lpv = await db.query(
      `select lpv.id
         from ccat.students st
         join ccat.learning_plans lp on lp.grade_id = st.grade_id
         join ccat.learning_plan_versions lpv on lpv.learning_plan_id = lp.id and lpv.is_active = true
        where st.id = $1 limit 1`,
      [sid],
    );
    if (lpv.rows.length === 0) {
      return { progress_pct: null, completed_count: 0, eligible_count: 0, learning_plan_version_id: null };
    }
    const planId = lpv.rows[0]!.id;
    const eligible = await db.query(
      `select count(*)::int as n from ccat.learning_plan_sets where learning_plan_version_id=$1`, [planId]);
    const completed = await db.query(
      `select count(*)::int as n from ccat.set_completions where student_id=$1 and learning_plan_version_id=$2`, [sid, planId]);
    const e = eligible.rows[0]!.n as number;
    const c = completed.rows[0]!.n as number;
    return {
      progress_pct: e > 0 ? Math.round((100 * c) / e) : null,
      completed_count: c,
      eligible_count: e,
      learning_plan_version_id: planId,
    };
  });
}
