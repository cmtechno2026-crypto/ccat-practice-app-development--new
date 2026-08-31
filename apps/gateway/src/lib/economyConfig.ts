import type { Client, DB } from '../db.js';

// Versioned economy config (Blueprint §19.1, §30). The active row lives in config_versions
// (domain='economy', append-only, is_active). Scoring and streaks READ this so admin edits take
// effect without a code change; if no row exists the launch defaults below apply. Editing
// publishes a NEW version and supersedes the old — never an in-place overwrite.

export interface EconomyConfig {
  base_xp: Record<string, number>;          // XP per difficulty key for a correct answer
  difficulty_weight: Record<string, number>; // readiness weighting
  streak_milestones: Record<string, number>; // day -> coin bonus
  level_step_xp: number;                     // XP needed to advance one level (level = floor(xp/step)+1)
}

export const ECONOMY_DEFAULTS: EconomyConfig = {
  base_xp: { easy: 10, medium: 15, hard: 20 },
  difficulty_weight: { easy: 1.0, medium: 1.5, hard: 2.0 },
  streak_milestones: { '3': 10, '7': 25, '14': 60, '30': 150 },
  level_step_xp: 500,
};

export async function loadEconomyConfig(client: Client | DB): Promise<EconomyConfig> {
  const r = await client.query(
    `select payload from ccat.config_versions where domain='economy' and is_active=true
      order by effective_at desc limit 1`,
  ).catch(() => ({ rows: [] as any[] }));
  const p = r.rows[0]?.payload ?? {};
  return {
    base_xp: { ...ECONOMY_DEFAULTS.base_xp, ...(p.base_xp ?? {}) },
    difficulty_weight: { ...ECONOMY_DEFAULTS.difficulty_weight, ...(p.difficulty_weight ?? {}) },
    streak_milestones: { ...ECONOMY_DEFAULTS.streak_milestones, ...(p.streak_milestones ?? {}) },
    level_step_xp: (typeof p.level_step_xp === 'number' && p.level_step_xp > 0) ? p.level_step_xp : ECONOMY_DEFAULTS.level_step_xp,
  };
}
