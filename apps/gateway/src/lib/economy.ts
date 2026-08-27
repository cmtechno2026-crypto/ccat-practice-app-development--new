import type { Client } from '../db.js';
import { loadEconomyConfig } from './economyConfig.js';

// XP economy launch defaults (Blueprint §19.1). The active values are read from the versioned
// economy config at scoring time (see loadEconomyConfig); this constant is the fallback.
export const BASE_XP: Record<string, number> = { easy: 10, medium: 15, hard: 20 };

// Readiness difficulty weights launch seed (readiness-calculation.md §3).
export const DIFF_WEIGHT: Record<string, number> = { easy: 1.0, medium: 1.5, hard: 2.0 };

export interface AnswerRow {
  question_version_id: string;
  selected_option_ids: string[];
  correct_option_ids: string[];
  difficulty_key: string;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export interface ScoreDetailItem { question_version_id: string; category_key: string; correct: boolean; attempted: boolean }
export interface ScoreResult {
  correct: number;
  total: number;
  xp: number;
  detail: ScoreDetailItem[]; // per-question correctness + category (for by-battery breakdown)
}

// Score a session from its persisted answers vs the set's question versions (server-authoritative).
// total = number of questions in the set version; unanswered counts as incorrect.
export async function scoreSession(client: Client, sessionId: string, setVersionId: string): Promise<ScoreResult> {
  const q = await client.query(
    `select svq.question_version_id,
            qv.correct_option_ids,
            d.key as difficulty_key,
            qcat.key as category_key,
            sa.selected_option_ids
       from ccat.set_version_questions svq
       join ccat.question_versions qv on qv.id = svq.question_version_id
       join ccat.difficulties d on d.id = qv.difficulty_id
       join ccat.logical_questions lq on lq.id = qv.logical_question_id
       join ccat.categories qcat on qcat.id = lq.category_id
       left join ccat.session_answers sa
         on sa.session_id = $1 and sa.question_version_id = svq.question_version_id
      where svq.set_version_id = $2`,
    [sessionId, setVersionId],
  );
  const cfg = await loadEconomyConfig(client);
  let correct = 0;
  let xp = 0;
  const total = q.rows.length;
  const detail: ScoreDetailItem[] = [];
  for (const row of q.rows) {
    const selected: string[] = row.selected_option_ids ?? [];
    const isCorrect = selected.length > 0 && sameSet(selected, row.correct_option_ids);
    if (isCorrect) {
      correct += 1;
      xp += cfg.base_xp[row.difficulty_key] ?? BASE_XP[row.difficulty_key] ?? 0;
    }
    detail.push({ question_version_id: row.question_version_id, category_key: row.category_key, correct: isCorrect, attempted: selected.length > 0 });
  }
  return { correct, total, xp, detail };
}
