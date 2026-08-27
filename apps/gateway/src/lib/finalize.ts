import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import { Errors } from '../errors.js';
import { scoreSession } from './economy.js';
import { computeReadiness } from './readiness.js';
import { evaluateAchievements, type EarnedAchievement } from './achievements.js';
import { bumpStreakAndMilestones } from './streaks.js';

export interface FinalizeOptions {
  finalizedBy: 'manual' | 'deadline' | 'worker';
  submissionId: string;
  expectedSessionVersion?: number; // required for manual
}

export interface FinalizeOutcome {
  replay: boolean;
  result: {
    session_id: string;
    terminal_state: string;
    score_correct: number;
    score_total: number;
    xp_awarded: number;
    coins_awarded: number;
    streak?: { current: number; longest: number; milestone_coins: number };
    achievements_unlocked?: EarnedAchievement[];
  };
}

// The authoritative exactly-once finalization transaction (Blueprint §13.2). Shared by manual
// submit and the deadline/worker path. Idempotent: a terminal session returns its stored result.
export async function finalizeSession(
  db: DB,
  sessionId: string,
  studentIdForOwnershipCheck: string | null,
  opts: FinalizeOptions,
): Promise<FinalizeOutcome> {
  const outcome = await withTransaction(db, async (client) => {
    const s = await client.query(
      `select id, student_id, set_version_id, session_version, state, mode, timer_type
         from ccat.sessions where id = $1 for update`,
      [sessionId],
    );
    if (s.rows.length === 0) throw Errors.notFound('Session not found');
    const sess = s.rows[0]!;
    if (studentIdForOwnershipCheck && sess.student_id !== studentIdForOwnershipCheck) {
      throw Errors.notFound('Session not found'); // no IDOR leak
    }

    if (sess.state !== 'IN_PROGRESS') {
      const existing = await client.query(
        `select session_id, terminal_state, score_correct, score_total, xp_awarded, coins_awarded
           from ccat.session_results where session_id = $1`,
        [sessionId],
      );
      if (existing.rows.length > 0) return { replay: true, result: existing.rows[0]! } as FinalizeOutcome;
      throw Errors.sessionTerminal();
    }
    if (opts.finalizedBy === 'manual' && sess.session_version !== opts.expectedSessionVersion) {
      throw Errors.sessionVersionConflict();
    }

    const terminalState = opts.finalizedBy === 'manual' ? 'SUBMITTED' : 'AUTO_SUBMITTED';
    const score = await scoreSession(client, sessionId, sess.set_version_id);

    const sub = await client.query(
      `insert into ccat.session_submissions(session_id, submission_id, finalized_by, expected_session_version)
       values ($1,$2,$3,$4) returning id`,
      [sessionId, opts.submissionId, opts.finalizedBy, opts.expectedSessionVersion ?? sess.session_version],
    );
    const submissionPk = sub.rows[0]!.id;

    if (score.xp > 0) {
      await client.query(
        `insert into ccat.xp_transactions(student_id, delta, source_kind, source_id)
         values ($1,$2,'session_submit',$3)`,
        [sess.student_id, score.xp, sessionId],
      );
      await client.query(
        `update ccat.students set cached_xp_total = cached_xp_total + $2 where id = $1`,
        [sess.student_id, score.xp],
      );
    }

    // Coverage credit (§15): if the set belongs to the active learning-plan version for the
    // student's grade, record a completion (idempotent per student+set+plan version).
    await client.query(
      `insert into ccat.set_completions(student_id, question_set_id, learning_plan_version_id, first_session_id, mode)
       select s.student_id, qs.id, lpv.id, s.id, s.mode
         from ccat.sessions s
         join ccat.question_set_versions sv on sv.id = s.set_version_id
         join ccat.question_sets qs on qs.id = sv.question_set_id
         join ccat.students st on st.id = s.student_id
         join ccat.learning_plans lp on lp.grade_id = st.grade_id
         join ccat.learning_plan_versions lpv on lpv.learning_plan_id = lp.id and lpv.is_active = true
         join ccat.learning_plan_sets lps on lps.learning_plan_version_id = lpv.id and lps.question_set_id = qs.id
        where s.id = $1
       on conflict (student_id, question_set_id, learning_plan_version_id) do nothing`,
      [sessionId],
    );

    // Daily streak (Option A): increment for the student's local day + exactly-once milestone
    // coins. Runs inside this finalize transaction so it's atomic and once-per-finalized-session.
    const streak = await bumpStreakAndMilestones(client, sess.student_id);
    const coinsAwarded = streak.milestone_coins;

    await client.query(
      `insert into ccat.session_results(session_id, submission_pk, terminal_state, score_correct, score_total, xp_awarded, coins_awarded, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sessionId, submissionPk, terminalState, score.correct, score.total, score.xp, coinsAwarded, JSON.stringify(score.detail)],
    );
    await client.query(
      `update ccat.sessions set state=$2, terminal_at=now(), session_version = session_version + 1 where id=$1`,
      [sessionId, terminalState],
    );
    // Lock only rows not already locked — practice per-question feedback commits+locks answers as
    // the student goes, and the answer-guard trigger forbids updating an already-locked row.
    await client.query(`update ccat.session_answers set is_locked = true where session_id = $1 and is_locked = false`, [sessionId]);

    // Achievement evaluation + atomic reward grants (§13.2 step 8, §19.4).
    const achievements = await evaluateAchievements(client, sess.student_id, sessionId, { correct: score.correct, total: score.total });

    // Readiness inputs recompute + snapshot (§16). Uses now-locked answers.
    const readiness = await computeReadiness(client, sess.student_id);
    await client.query(
      `insert into ccat.readiness_snapshots(student_id, readiness_pct, insufficient_data, window_questions, band)
       values ($1,$2,$3,$4,$5)`,
      [sess.student_id, readiness.readiness_pct, readiness.insufficient_data, readiness.window_questions, readiness.band],
    );

    return {
      replay: false,
      result: {
        session_id: sessionId,
        terminal_state: terminalState,
        score_correct: score.correct,
        score_total: score.total,
        xp_awarded: score.xp,
        coins_awarded: coinsAwarded,
        streak: { current: streak.current, longest: streak.longest, milestone_coins: streak.milestone_coins },
        achievements_unlocked: achievements,
      },
    } as FinalizeOutcome;
  }).catch(async (e: any) => {
    // Race: another finalize committed first (unique session_submissions / one-per-session).
    if (e?.code === '23505') {
      const existing = await db.query(
        `select session_id, terminal_state, score_correct, score_total, xp_awarded, coins_awarded
           from ccat.session_results where session_id = $1`,
        [sessionId],
      );
      if (existing.rows.length > 0) return { replay: true, result: existing.rows[0]! } as FinalizeOutcome;
    }
    throw e;
  });
  return outcome;
}

// Durable overdue-session finalization worker (Blueprint §14.4). Finalizes timed IN_PROGRESS
// sessions past their deadline as AUTO_SUBMITTED. Idempotent and safe to run repeatedly.
export async function finalizeOverdueSessions(db: DB): Promise<number> {
  // Overdue = past the timer deadline. deadline_at is the authoritative field (written at start), but
  // it is an absolute instant produced by the gateway's clock, while now() is the database clock. When
  // the app process and the database run on different hosts whose clocks are not perfectly in step
  // (e.g. a Node process on the host vs. Postgres inside a Docker/WSL VM), a thin margin can make
  // deadline_at <= now() briefly false even though the session is genuinely overdue. The second branch
  // recomputes the deadline entirely in the database clock (started_at DEFAULT now() + duration), so a
  // just-overdue session is still finalized regardless of cross-host clock skew. In production, where
  // both clocks are NTP-synced, the two branches coincide.
  const { rows } = await db.query(
    `select id from ccat.sessions
      where state = 'IN_PROGRESS' and timer_type = 'timed'
        and (
          (deadline_at is not null and deadline_at <= now())
          or (duration_seconds is not null and started_at + make_interval(secs => duration_seconds) <= now())
        )
      limit 100`,
  );
  let n = 0;
  for (const r of rows) {
    try {
      await finalizeSession(db, r.id, null, { finalizedBy: 'worker', submissionId: `auto:${r.id}` });
      n += 1;
    } catch {
      // best-effort; a concurrent manual submit may have finalized it — ignore
    }
  }
  return n;
}
