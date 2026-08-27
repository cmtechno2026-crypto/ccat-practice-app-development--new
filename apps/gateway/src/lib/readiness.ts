import type { Client } from '../db.js';
import { DIFF_WEIGHT } from './economy.js';

// Readiness % launch model v1 (readiness-calculation.md). Difficulty-weighted accuracy over a
// rolling window of the student's answered questions in valid terminal sessions. Insufficient
// activity => insufficient_data = true (never 0%).
const MIN_QUESTIONS = 20;
const WINDOW_QUESTIONS = 60;

export interface ReadinessResult {
  readiness_pct: number | null;
  insufficient_data: boolean;
  window_questions: number;
  band: string | null;
}

function band(pct: number): string {
  if (pct >= 85) return 'Excelling';
  if (pct >= 70) return 'Strong';
  if (pct >= 50) return 'Developing';
  return 'Building';
}

export async function computeReadiness(client: Client, studentId: string): Promise<ReadinessResult> {
  // Locked answers from terminal (submitted/auto-submitted) sessions, newest first.
  const { rows } = await client.query(
    `select sa.selected_option_ids, qv.correct_option_ids, d.key as difficulty_key
       from ccat.session_answers sa
       join ccat.sessions s on s.id = sa.session_id
       join ccat.question_versions qv on qv.id = sa.question_version_id
       join ccat.difficulties d on d.id = qv.difficulty_id
      where s.student_id = $1
        and s.state in ('SUBMITTED','AUTO_SUBMITTED')
        and sa.is_locked = true
      order by sa.updated_at desc
      limit $2`,
    [studentId, WINDOW_QUESTIONS],
  );
  if (rows.length < MIN_QUESTIONS) {
    return { readiness_pct: null, insufficient_data: true, window_questions: rows.length, band: null };
  }
  let wCorrect = 0;
  let wTotal = 0;
  for (const r of rows) {
    const w = DIFF_WEIGHT[r.difficulty_key] ?? 1;
    wTotal += w;
    const selected: string[] = r.selected_option_ids ?? [];
    const correct: string[] = r.correct_option_ids;
    const ok = selected.length === correct.length && [...selected].sort().every((v, i) => v === [...correct].sort()[i]);
    if (ok) wCorrect += w;
  }
  const pct = Math.round((100 * wCorrect) / wTotal);
  return { readiness_pct: pct, insufficient_data: false, window_questions: rows.length, band: band(pct) };
}
