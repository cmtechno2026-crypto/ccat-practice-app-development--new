// Response/request types for the CCAT Gateway (mirrors packages/contracts/openapi.yaml).

export type Channel = 'email' | 'sms';
export type Mode = 'practice' | 'exam';
export type TimerType = 'untimed' | 'timed';
export type SessionState =
  | 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | 'ABANDONED'
  | 'ABANDONED_BY_INACTIVITY' | 'INVALIDATED' | 'CANCELLED';

export interface ApiErrorBody {
  error: { code: string; message: string; request_id?: string; details?: Record<string, unknown> };
}

export interface Grade {
  id: string; grade_number: number; name: string; display_order: number;
  registration_enabled: boolean; practice_enabled: boolean;
}

export interface TokenPair { access_token: string; refresh_token: string; expires_in: number; }
export interface ChallengeStarted { challenge_id: string | null; expires_at: string; _dev_code?: string; }
// Registration — the unified guardian contact is VALIDATED (email format + E.164 phone), not OTP-verified.
export interface ContactValidated { registration_grant: string; guardian_email: string; guardian_phone: string; }

// The student's currently-equipped avatar stage, resolved to a renderable image + label (from
// GET /v1/profile). Single source of truth for the avatar shown across the app.
export interface CurrentAvatar {
  stage_id: string;
  name: string | null;
  family_key: string | null;
  stage_number: number | null;
  image_url: string | null;
}
export interface StudentProfile {
  id: string; display_name: string; username: string; grade_id: string;
  age_years: number; status: string;
  active_avatar_stage_id: string | null; active_theme_id: string | null;
  current_avatar?: CurrentAvatar | null;  // resolved equipped avatar for consistent rendering everywhere
  is_preview?: boolean;   // synthetic preview/"cheat" account — clients show a Preview-mode banner
}

export interface Session {
  id: string; set_version_id: string; mode: Mode; timer_type: TimerType;
  duration_seconds: number | null; state: SessionState; session_version: number;
  started_at: string; deadline_at: string | null;
  // Set metadata (present on GET /v1/sessions/:id) for the player header + result subline.
  set_name?: string | null; category_key?: string | null; subcategory?: string | null; difficulty?: string | null;
}
export interface SessionQuestion {
  question_version_id: string; logical_question_id: string; question_type: string;
  multi?: boolean; // "pick all correct" — number of correct options > 1 (never which)
  category_key?: string; category_name?: string; // battery grouping for exam mode
  prompt_blocks: unknown[]; option_blocks: { option_id: string; content: unknown[]; image_url?: string | null }[];
  // Ready-to-use figure URL for the question and for each option (null when none). Absolute for cloud
  // storage; a gateway-relative /v1/assets/:id path under the local-disk driver (resolve against the base).
  image_url?: string | null;
  selected_option_ids: string[]; answer_version: number;
}
export interface BatterySummary { category_key: string; correct: number; total: number; attempted: number; }
export interface SessionWithQuestions extends Session { questions: SessionQuestion[]; }

export interface AnswerWrite { question_version_id: string; selected_option_ids: string[]; answer_version: number; }
export interface AnswerAck { question_version_id: string; accepted_version: number; }

// PRACTICE per-question feedback (practice sessions only; exam is rejected server-side).
export interface PracticeReveal { correctOptionId: string | null; correctOptionIds?: string[]; explanation: unknown[] | null; }
export interface PracticeAttemptResult {
  correct: boolean;
  attemptsUsed: number;
  attemptsRemaining: number;
  hint?: string;            // only if authored — never fabricated
  revealed?: PracticeReveal; // present only once the question is committed (correct or attempts used)
}

export interface EarnedAchievement { key: string; name: string; }
export interface SessionResult {
  session_id: string; terminal_state: SessionState;
  score_correct: number; score_total: number; xp_awarded: number; coins_awarded: number;
  achievements_unlocked?: EarnedAchievement[];
  mode?: Mode; timer_type?: TimerType;
  time_spent_seconds?: number; timed_out?: boolean;
  attempted_count?: number; by_battery?: BatterySummary[];
}


export interface ExamHistoryItem {
  session_id: string; set_name: string | null; when: string | null; end_reason: SessionState;
  score_correct: number; score_total: number; accuracy_pct: number; attempted_count: number;
  time_spent_seconds: number; by_battery: BatterySummary[];
}

export interface Bookmark {
  logical_question_id: string; note: string | null; created_at: string;
  category_key: string; subcategory: string; preview: string;
  difficulty?: string | null; set_name?: string | null; position?: number | null;
}

// Full published question payload for the bookmark review player (reveals the answer — study, not
// a graded attempt; server-gated to the student's own bookmarks).
export interface BookmarkReview {
  logical_question_id: string; question_type: string;
  prompt_blocks: unknown[]; option_blocks: unknown[];
  correct_option_ids: string[]; explanation_blocks: unknown[] | null;
  category_key: string; subcategory: string;
  difficulty: string | null; set_name: string | null; position: number | null;
}

export interface ReferralLadderRung { friends: number; coins: number; reached: boolean; }
export interface ReferralInfo {
  code: string; share_path: string; joined: number;
  ladder: ReferralLadderRung[];
  next: { friends: number; coins: number; to_go: number } | null;
}

export interface AccountGuardian { email: string | null; phone: string | null; relationship: string | null; }
export interface AccountInfo { display_name: string; username: string; guardian: AccountGuardian | null; }
export interface DeletionResult { state: string; reference: string | null; restore_deadline: string | null; already: boolean; }

export interface SupportCase { reference: string; summary: string; state: string; created_at: string; }
export interface SupportCaseCreated { reference: string; state: string; created_at: string; }

export interface Announcement { id: string; title: string; body_blocks: unknown[]; image_asset_id: string | null; carousel_order: number | null; }
export interface BookRetailer { id: string; retailer: string; }
export interface Book { id: string; title: string; author: string | null; description: string | null; cover_asset_id: string | null; retailers: BookRetailer[]; price_cents?: number | null; original_price_cents?: number | null; subject?: string | null; grade_ids?: string[] | null; }
export interface AdultChallenge { challenge_token: string; prompt: string; }
export interface RetailerHandoff { destination_url: string; }

export interface AvatarStage { stage_id: string; stage_number: number; name: string; required_xp: number | null; owned: boolean; active: boolean; image_url?: string | null; }
export interface AvatarFamily { family_id: string; key: string; name: string; stages: AvatarStage[]; }
export interface AvatarsResponse { xp_total: number; families: AvatarFamily[]; }
export interface Theme { id: string; key: string; name: string; owned: boolean; active: boolean; requirement: string; palette?: Record<string, string>; }

export interface AchievementReward { kind: string; xp: number | null; coins: number | null; }
export interface Achievement {
  key: string; name: string; description: string;
  earned: boolean; earned_at: string | null; rewards: AchievementReward[];
  progress_pct?: number; howto?: string;
}

export interface CatalogSetProgress {
  status: 'not_started' | 'in_progress' | 'completed';
  session_id: string | null; answered_count: number;
  score_correct: number | null; score_total: number | null;
}
export interface CatalogItem {
  set_version_id: string; name: string; category_key: string; category_name?: string; subcategory: string;
  maxQuestionsPerSet?: number; // this subcategory's cap (45 for *_battery_combine, 15 otherwise)
  difficulty: string | null; question_count: number; duration_minutes?: number | null; allowed_modes: Mode[];
  // A set this student played that has since been RETIRED — kept visible for their history, shown greyed
  // at the bottom of the list and not startable.
  retired?: boolean;
  progress?: CatalogSetProgress;
}

export interface StreakDay { date: string; active: boolean; }
export interface LevelInfo {
  level: number;
  xp_into_level: number;       // XP accumulated inside the current level
  xp_for_level: number;        // XP span of one level (the config step)
  xp_to_next: number;          // XP remaining to reach the next level
  next_level_xp_total: number; // total XP at which the next level begins
}
export interface NextReward {
  label: string;               // name of the next XP-gated unlock
  kind: string;                // 'avatar' | 'theme'
  target_xp: number;           // XP total that unlocks it
  xp_needed: number;           // target_xp - current xp (>= 0)
  progress_pct: number;        // 0–100 toward target_xp
}
export interface RewardsSummary {
  xp_total: number;
  coin_balance: number;
  streak?: { current: number; longest: number; last7?: StreakDay[] };
  level?: LevelInfo;               // server-computed level + next-level threshold
  next_reward?: NextReward | null; // nearest XP unlock, or null when all XP rewards are unlocked
}

export interface CoinHistoryItem { delta: number; label: string; source_kind: string; created_at: string; }
export interface CoinLadderRung { day: number; coins: number; reached: boolean; }
export interface CoinsPanel {
  coin_balance: number; current_streak: number;
  history: CoinHistoryItem[]; ladder: CoinLadderRung[];
  next: { day: number; coins: number; days_to_go: number } | null;
}
export interface Readiness { readiness_pct: number | null; insufficient_data: boolean; band: string | null; window_questions: number; }
export interface Progress { progress_pct: number | null; completed_count: number; eligible_count: number; learning_plan_version_id: string | null; }

// ---- Progress & Analytics (GET /v1/progress/summary, /v1/progress/sets, /v1/progress/breakdown) ----
// Real, driven by the student's own practice data; untracked metrics are null (never faked). Only SESSION
// wall-clock exists → practiceTimeMinutes / practiceTimeSeries are LIVE; per-question duration is not
// tracked → avgSecondsPerQuestion is always null. See PROGRESS_ANALYTICS.
export type ProgressCategory = 'verbal' | 'non_verbal' | 'quantitative';
export interface ProgressTimePoint { date: string; minutes: number; }
export interface ProgressScore { correct: number; total: number; }
export interface ProgressSubcategory { key: string; name: string; }
// A subcategory of a battery with its accuracy — one box per subcategory (combine included).
export interface ProgressSubAccuracy { key: string; name: string; accuracyPct: number | null; }

// One battery (category) in the summary. accuracyPct = the battery "progress %" (Home ring).
// setsDone / setsTotal EXCLUDE combine subcategories; subcategories[] is the FULL list (combine included)
// with per-subcategory accuracy — powers the battery boxes and the sets-table subcategory filter.
export interface ProgressBatterySummary {
  key: string;                          // category key (e.g. 'verbal') — from the DB, not hard-coded
  name: string;                         // category display name
  accuracyPct: number | null;           // battery progress %
  score: ProgressScore;
  totalQuestions: number;
  avgSecondsPerQuestion: number | null; // derived (session wall-clock ÷ answered); null when no data
  setsDone: number;                     // finished sets, combine excluded
  setsTotal: number;                    // available sets for the grade, combine excluded
  subcategories: ProgressSubAccuracy[]; // every subcategory of the battery (incl combine) + accuracy
}
export interface ProgressSummary {
  score: ProgressScore;                 // across ALL finished sets (e.g. 46/60)
  setsDone: number;                     // total finished sets
  practiceTimeMinutes: number | null;   // LIVE (session wall-clock); null/0 when no terminal sessions
  practiceTimeSeries: ProgressTimePoint[]; // LIVE per-day; [] when none
  batteries: ProgressBatterySummary[];
}

// One per-set row from GET /v1/progress/sets (finished sets in a battery, optional subcategory filter).
export interface ProgressSetRow {
  setId: string;
  name: string;
  subcategory: ProgressSubcategory;
  accuracyPct: number | null;
  score: ProgressScore;
  totalQuestions: number;
  avgSecondsPerQuestion: number | null; // always null (per-question timing not captured)
}
export interface ProgressTopic {
  subcategory: string;
  accuracyPct: number | null;
  avgSecondsPerQuestion: number | null;
  completionPct: number | null;
  questionsDone: number;
  bestStreak: number;
  lastPractisedLabel: string;
}
export interface ProgressBreakdownCategory { category: ProgressCategory | string; accuracyPct: number | null; topics: ProgressTopic[]; }
export interface ProgressQuery { from?: string; to?: string; }
// Query for GET /v1/progress/sets. subcategory 'all' (or omitted) → every subcategory in the battery.
export interface ProgressSetsQuery extends ProgressQuery { battery: string; subcategory?: string; }

// ---- Set review (GET /v1/progress/set-review?setId=) — the latest submitted attempt of a set, for the
// slide-in preview panel. Reveals correct answers (study view). Rendered in the child's play order.
export interface ProgressReviewOption {
  option_id: string;
  content: unknown[];            // option content blocks (text/image)
  image_url: string | null;
  correct: boolean;              // is a correct option
  selected: boolean;            // the child picked this
}
export interface ProgressReviewQuestion {
  question_version_id: string;
  question_type: string;
  prompt_blocks: unknown[];
  image_url: string | null;
  options: ProgressReviewOption[];
  selected_option_ids: string[];
  correct_option_ids: string[];
  answered: boolean;
  correct: boolean;              // the child got this question right
}
export interface ProgressSetReview {
  found: boolean;                // false when the student has no submitted attempt of this set
  setName: string | null;
  score: ProgressScore;
  accuracyPct: number | null;
  timeSeconds: number | null;    // total session wall-clock for the attempt
  questions: ProgressReviewQuestion[];
}
