import type { Client } from '../db.js';

// Achievement evaluation (Blueprint §13.2 step 8, §19.4). Runs inside the submit transaction.
// Reward grants + their ledger writes occur atomically with the student_achievements insert.
// Idempotent: student_achievements unique(student, version); ledger unique(student, kind, source).
//
// Supported criteria (JSONB `criteria.type`):
//   first_completion        — the student's first valid terminal completion
//   perfect_set             — this session scored full marks (total > 0)
//   xp_total {threshold}    — cumulative XP has reached the threshold

export interface CurrentScore { correct: number; total: number; }
export interface EarnedAchievement { key: string; name: string; }

export async function evaluateAchievements(
  client: Client,
  studentId: string,
  sessionId: string,
  score: CurrentScore,
): Promise<EarnedAchievement[]> {
  const av = await client.query(
    `select av.id as version_id, a.key, a.name, av.criteria
       from ccat.achievement_versions av
       join ccat.achievements a on a.id = av.achievement_id
      where av.active = true
        and not exists (
          select 1 from ccat.student_achievements sa
           where sa.student_id = $1 and sa.achievement_version_id = av.id)`,
    [studentId],
  );
  if (av.rows.length === 0) return [];

  // Context for criteria checks.
  const compQ = await client.query(
    `select count(*)::int as n from ccat.session_results r
       join ccat.sessions s on s.id = r.session_id
      where s.student_id = $1 and r.terminal_state in ('SUBMITTED','AUTO_SUBMITTED')`,
    [studentId],
  );
  const completions = compQ.rows[0]!.n as number;
  const xpQ = await client.query(
    `select coalesce(sum(delta),0)::bigint as v from ccat.xp_transactions where student_id = $1`,
    [studentId],
  );
  const xpTotal = Number(xpQ.rows[0]!.v);

  const earned: EarnedAchievement[] = [];
  for (const row of av.rows) {
    const c = (row.criteria ?? {}) as { type?: string; threshold?: number };
    let hit = false;
    if (c.type === 'first_completion') hit = completions >= 1;
    else if (c.type === 'perfect_set') hit = score.total > 0 && score.correct === score.total;
    else if (c.type === 'xp_total') hit = typeof c.threshold === 'number' && xpTotal >= c.threshold;

    if (!hit) continue;

    // Grant (atomic within this transaction).
    await client.query(
      `insert into ccat.student_achievements(student_id, achievement_version_id, granted_from_session_id)
       values ($1,$2,$3) on conflict (student_id, achievement_version_id) do nothing`,
      [studentId, row.version_id, sessionId],
    );
    const rewards = await client.query(
      `select reward_kind, xp_amount, coin_amount, avatar_stage_id, theme_id
         from ccat.achievement_rewards where achievement_version_id = $1`,
      [row.version_id],
    );
    for (const r of rewards.rows) {
      if (r.reward_kind === 'xp' && r.xp_amount) {
        await client.query(
          `insert into ccat.xp_transactions(student_id, delta, source_kind, source_id)
           values ($1,$2,'achievement',$3)
           on conflict (student_id, source_kind, source_id) do nothing`,
          [studentId, r.xp_amount, row.version_id],
        );
        await client.query(`update ccat.students set cached_xp_total = cached_xp_total + $2 where id = $1`, [studentId, r.xp_amount]);
      } else if (r.reward_kind === 'coins' && r.coin_amount) {
        await client.query(
          `insert into ccat.coin_transactions(student_id, delta, source_kind, source_id)
           values ($1,$2,'achievement',$3)
           on conflict (student_id, source_kind, source_id) do nothing`,
          [studentId, r.coin_amount, row.version_id],
        );
        await client.query(`update ccat.students set cached_coin_balance = cached_coin_balance + $2 where id = $1`, [studentId, r.coin_amount]);
      } else if (r.reward_kind === 'avatar' && r.avatar_stage_id) {
        await client.query(
          `insert into ccat.student_avatar_grants(student_id, avatar_stage_id, source_kind)
           values ($1,$2,'achievement') on conflict do nothing`,
          [studentId, r.avatar_stage_id],
        );
      } else if (r.reward_kind === 'theme' && r.theme_id) {
        await client.query(
          `insert into ccat.student_theme_grants(student_id, theme_id, source_kind)
           values ($1,$2,'achievement') on conflict do nothing`,
          [studentId, r.theme_id],
        );
      }
    }
    earned.push({ key: row.key, name: row.name });
  }
  return earned;
}
