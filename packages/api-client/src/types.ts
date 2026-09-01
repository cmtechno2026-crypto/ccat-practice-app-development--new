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

// The student's currently-equipped avatar stage, resolved to a renderable image + label. Single
// source of truth for the avatar shown across the app (from GET /v1/profile).
export interface CurrentAvatar {
  stage_id: string;
  name: string | null;
  family_key: string | null;  // drives the emoji fallback when image_url is absent
  stage_number: number | null;
  image_url: string | null;   // absolute or gateway-relative; null → fallback to family/stage emoji
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
  prompt_blocks: unknown[]; option_blocks: { option_id: string; content: unknown[] }[];
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
  difficulty: string | null; question_count: number; duration_minutes?: number | null; allowed_modes: Mode[];
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

// ---- Progress & Analytics (GET /v1/progress/summary, /v1/progress/activity) ----
// Every field is real, driven by the student's own practice data. Metrics that are not tracked are
// null (never faked). See the gateway PROGRESS report for the exact table/column behind each field.
export type ProgressCategory = 'verbal' | 'non_verbal' | 'quantitative';
export interface ProgressCategoryStat {
  category: ProgressCategory | string;
  answered: number;
  accuracyPct: number | null;   // null when 0 answered in this category
}
export interface ProgressExamReadiness {
  label: string;                // e.g. 'Ready', 'Building…' — reuses readiness band
  pct: number | null;           // null while insufficient data
}
export interface ProgressSummary {
  questionsAnswered: number;
  setsCompleted: number;
  avgAccuracy: number | null;       // %, null when 0 answered
  timeSpentMinutes: number | null;  // real session wall-clock; null when not tracked
  mockExamsTaken: number;
  courseCompletionPct: number | null; // null when no learning-plan sets
  examReadiness: ProgressExamReadiness;
  streakDays: number;
  byCategory: ProgressCategoryStat[];
}
export interface ProgressActivityEvent {
  id: string;
  type: 'set' | 'exam' | 'badge';
  title: string;
  category: string | null;
  accuracyPct: number | null;   // green≥80 / amber 50–79 / red<50 in the UI; null for badges & ungraded
  questions: number | null;
  timeMinutes: number | null;
  dayLabel: string;             // DATE-ONLY: 'Today' | 'Yesterday' | 'Aug 22' — never a clock time
  sortDate: string;             // ISO timestamp, newest-first ordering
}
// Query filters for both progress endpoints. Only filters reported LIVE by the gateway have effect.
export interface ProgressQuery { from?: string; to?: string; category?: string; mode?: Mode; }
