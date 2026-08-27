import type { Client, DB } from '../db.js';
import { loadEconomyConfig } from './economyConfig.js';

// Daily practice streaks — Option A (strict daily, student-local timezone, no grace).
// Milestone coin bonuses are granted exactly once via the coin ledger's unique
// (student_id, source_kind, source_id) constraint. Called inside the exactly-once session
// finalization transaction, so it runs once per finalized session.

export const STREAK_MILESTONES: Record<number, number> = { 3: 10, 7: 25, 14: 60, 30: 150 };

export interface StreakBump { current: number; longest: number; milestone_coins: number }

// Increment (or reset) the student's streak based on their local day, then grant a milestone
// coin bonus if the new streak length hits an ungranted milestone. Idempotent within a day:
// a second finalized session the same day leaves current_streak unchanged and grants nothing new.
export async function bumpStreakAndMilestones(client: Client, studentId: string): Promise<StreakBump> {
  const upserted = await client.query(
    `with d as (
        select (now() at time zone st.timezone)::date as today
          from ccat.students st where st.id = $1
     ),
     cur as (
        select current_streak, longest_streak, last_active_day
          from ccat.student_streaks where student_id = $1
     ),
     calc as (
        select
          (case
             when c.last_active_day is null then 1
             when c.last_active_day = d.today then coalesce(c.current_streak, 1)
             when c.last_active_day = d.today - 1 then coalesce(c.current_streak, 0) + 1
             else 1
           end) as newcur,
          coalesce(c.longest_streak, 0) as oldlong,
          d.today
        from d left join cur c on true
     )
     insert into ccat.student_streaks (student_id, current_streak, longest_streak, last_active_day)
       select $1, calc.newcur, greatest(calc.oldlong, calc.newcur), calc.today from calc
     on conflict (student_id) do update set
       current_streak  = excluded.current_streak,
       longest_streak  = excluded.longest_streak,
       last_active_day = excluded.last_active_day,
       updated_at      = now()
     returning current_streak, longest_streak`,
    [studentId],
  );
  const current = Number(upserted.rows[0]!.current_streak);
  const longest = Number(upserted.rows[0]!.longest_streak);

  // Milestone coin bonus — exactly-once. Streak grows +1/day so at most one milestone applies now.
  // Amounts come from the versioned economy config (fallback to STREAK_MILESTONES defaults).
  const cfg = await loadEconomyConfig(client);
  let milestone_coins = 0;
  const coins = cfg.streak_milestones[String(current)] ?? STREAK_MILESTONES[current];
  if (coins) {
    const ins = await client.query(
      `insert into ccat.coin_transactions (student_id, delta, source_kind, source_id, reason)
       values ($1, $2, 'streak_milestone', $3, $4)
       on conflict (student_id, source_kind, source_id) do nothing
       returning id`,
      [studentId, coins, String(current), `${current}-day streak`],
    );
    if (ins.rows.length > 0) {
      await client.query(`update ccat.students set cached_coin_balance = cached_coin_balance + $2 where id = $1`, [studentId, coins]);
      milestone_coins = coins;
    }
  }
  return { current, longest, milestone_coins };
}

// Housekeeping: persist the zeroing of streaks that have gone stale (a full day missed), so
// stored current_streak matches reality for analytics. Reads already compute the effective value,
// so this is not required for display correctness. Safe to run repeatedly. Returns rows reset.
export async function reconcileStreaks(db: DB): Promise<number> {
  const r = await db.query(
    `update ccat.student_streaks ss set current_streak = 0, updated_at = now()
       from ccat.students s
      where ss.student_id = s.id and ss.current_streak > 0
        and ss.last_active_day < (now() at time zone s.timezone)::date - 1`,
  );
  return r.rowCount ?? 0;
}
