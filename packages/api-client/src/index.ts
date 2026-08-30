import type {
  ApiErrorBody, Channel, ChallengeStarted, Grade, Mode, TimerType, TokenPair,
  StudentProfile, Session, SessionWithQuestions, AnswerWrite, AnswerAck,
  SessionResult, ExamHistoryItem, RewardsSummary, CoinsPanel, Readiness, Progress, CatalogItem, Bookmark, BookmarkReview, Achievement,
  AvatarsResponse, Theme, Announcement, Book, AdultChallenge, RetailerHandoff, PracticeAttemptResult,
  SupportCase, SupportCaseCreated, AccountInfo, AccountGuardian, DeletionResult, ReferralInfo,
  ContactValidated,
} from './types.js';

export * from './types.js';

// Thrown on any non-2xx response, carrying the Gateway's structured error envelope (§32.1).
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// Pluggable token storage so the same client works on Expo (SecureStore) and web (memory).
export interface TokenStore {
  getAccess(): Promise<string | null> | string | null;
  getRefresh(): Promise<string | null> | string | null;
  set(tokens: TokenPair): Promise<void> | void;
  clear(): Promise<void> | void;
}

export class MemoryTokenStore implements TokenStore {
  private access: string | null = null;
  private refresh: string | null = null;
  getAccess() { return this.access; }
  getRefresh() { return this.refresh; }
  set(t: TokenPair) { this.access = t.access_token; this.refresh = t.refresh_token; }
  clear() { this.access = null; this.refresh = null; }
}

export interface ClientOptions {
  baseUrl: string;            // e.g. http://localhost:8080
  tokens?: TokenStore;
  fetchImpl?: typeof fetch;   // inject for tests / RN
}

export class CcatClient {
  readonly baseUrl: string;
  readonly tokens: TokenStore;
  private readonly f: typeof fetch;
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.tokens = opts.tokens ?? new MemoryTokenStore();
    this.f = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, opts: { body?: unknown; auth?: boolean; headers?: Record<string, string> } = {}, retried = false): Promise<T> {
    // Only send a JSON content-type when there is actually a body (bodyless GET/DELETE).
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth) {
      const token = await this.tokens.getAccess();
      if (token) headers['authorization'] = `Bearer ${token}`;
    }
    const res = await this.f(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (res.status === 401 && opts.auth && !retried) {
      const refreshed = await this.tryRefresh();
      if (refreshed) return this.request<T>(method, path, opts, true);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = (json as ApiErrorBody | null)?.error;
      throw new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? res.statusText, e?.request_id);
    }
    return json as T;
  }

  private async tryRefresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const refreshToken = await this.tokens.getRefresh();
      if (!refreshToken) return false;
      try {
        const t = await this.request<TokenPair>('POST', '/v1/auth/refresh', { body: { refresh_token: refreshToken } }, true);
        await this.tokens.set(t);
        return true;
      } catch {
        await this.tokens.clear();
        return false;
      }
    })();
    try { return await this.refreshInFlight; }
    finally { this.refreshInFlight = null; }
  }

  // ---- catalog / health -----------------------------------------------------
  health() { return this.request<{ status: string }>('GET', '/health/ready'); }
  grades() { return this.request<Grade[]>('GET', '/v1/grades'); }

  // ---- registration (§4) ----------------------------------------------------
  // Validate + persist the unified guardian contact (name + email + E.164 phone). No OTP. Returns a
  // grant carrying the validated contact. Pass `grant` to update the same contact on a resubmit.
  registrationContact(input: { guardianName: string; email: string; phone: string; grant?: string }) {
    return this.request<ContactValidated>('POST', '/v1/registration/contact/start', {
      body: { guardian_name: input.guardianName, email: input.email, phone: input.phone, registration_grant: input.grant },
    });
  }
  registrationConsent(grant: string, policyVersion: string, consentHash: string) {
    return this.request<{ registration_grant: string }>('POST', '/v1/registration/consent', { body: { registration_grant: grant, policy_version: policyVersion, consent_hash: consentHash } });
  }
  registrationStudent(input: {
    registration_grant: string; display_name: string; username: string; grade_id: string;
    birth_month: number; birth_year: number; pin: string; device_hash: string;
    referral_code?: string;
  }) {
    return this.request<StudentProfile>('POST', '/v1/registration/student', { body: input });
  }

  // ---- auth (§4.4, §5) ------------------------------------------------------
  async login(username: string, pin: string, deviceHash: string): Promise<TokenPair> {
    const t = await this.request<TokenPair>('POST', '/v1/auth/login', { body: { username, pin, device_hash: deviceHash } });
    await this.tokens.set(t);
    return t;
  }
  async refreshTokens(): Promise<TokenPair> {
    const refreshToken = await this.tokens.getRefresh();
    if (!refreshToken) throw new ApiError(401, 'UNAUTHORIZED', 'No refresh token');
    const t = await this.request<TokenPair>('POST', '/v1/auth/refresh', { body: { refresh_token: refreshToken } }, true);
    await this.tokens.set(t);
    return t;
  }
  async logout() { await this.request<null>('POST', '/v1/auth/logout', { auth: true }); await this.tokens.clear(); }

  // ---- recovery / device ----------------------------------------------------
  pinResetStart(username: string, channel: Channel) {
    return this.request<ChallengeStarted>('POST', '/v1/recovery/pin/start', { body: { username, channel } });
  }
  pinResetComplete(challengeId: string, code: string, newPin: string) {
    return this.request<{ status: string }>('POST', '/v1/recovery/pin/complete', { body: { challenge_id: challengeId, code, new_pin: newPin } });
  }
  deviceReplacementStart(username: string, newDeviceHash: string, channel: Channel) {
    return this.request<ChallengeStarted>('POST', '/v1/devices/replacement/start', { body: { username, new_device_hash: newDeviceHash, channel } });
  }
  async deviceReplacementVerify(challengeId: string, code: string): Promise<TokenPair> {
    const t = await this.request<TokenPair>('POST', '/v1/devices/replacement/verify', { body: { challenge_id: challengeId, code } });
    await this.tokens.set(t);
    return t;
  }

  // ---- catalog / profile / home ---------------------------------------------
  catalog() { return this.request<CatalogItem[]>('GET', '/v1/catalog', { auth: true }); }
  profile() { return this.request<StudentProfile>('GET', '/v1/profile', { auth: true }); }
  rewardsSummary() { return this.request<RewardsSummary>('GET', '/v1/rewards/summary', { auth: true }); }
  coins() { return this.request<CoinsPanel>('GET', '/v1/rewards/coins', { auth: true }); }
  readiness() { return this.request<Readiness>('GET', '/v1/readiness', { auth: true }); }
  progress() { return this.request<Progress>('GET', '/v1/progress', { auth: true }); }
  achievements() { return this.request<Achievement[]>('GET', '/v1/achievements', { auth: true }); }

  // ---- help & support (Gate 4A) ---------------------------------------------
  reportProblem(message: string, category?: string) {
    return this.request<SupportCaseCreated>('POST', '/v1/support/cases', { auth: true, body: { message, category } });
  }
  supportCases() { return this.request<SupportCase[]>('GET', '/v1/support/cases', { auth: true }); }

  // ---- account self-service (Gate 3B) ---------------------------------------
  account() { return this.request<AccountInfo>('GET', '/v1/account', { auth: true }); }
  updateName(display_name: string) { return this.request<{ display_name: string }>('PATCH', '/v1/account/name', { auth: true, body: { display_name } }); }
  updateGuardian(patch: Partial<AccountGuardian>) { return this.request<AccountGuardian>('PATCH', '/v1/account/guardian', { auth: true, body: patch }); }
  deleteAccount() { return this.request<DeletionResult>('POST', '/v1/account/deletion', { auth: true, body: {} }); }

  // ---- referrals (Gate 2B) --------------------------------------------------
  referrals() { return this.request<ReferralInfo>('GET', '/v1/referrals', { auth: true }); }
  rotateReferral() { return this.request<{ code: string }>('POST', '/v1/referrals/rotate', { auth: true, body: {} }); }

  // ---- bookmarks (§32.4) ----------------------------------------------------
  bookmarks() { return this.request<Bookmark[]>('GET', '/v1/bookmarks', { auth: true }); }
  addBookmark(logicalQuestionId: string, note?: string) {
    return this.request<{ bookmarked: boolean }>('PUT', '/v1/bookmarks', { auth: true, body: { logical_question_id: logicalQuestionId, note } });
  }
  removeBookmark(logicalQuestionId: string) {
    return this.request<null>('DELETE', `/v1/bookmarks?logical_question_id=${encodeURIComponent(logicalQuestionId)}`, { auth: true });
  }
  bookmarkReview(logicalQuestionId: string) {
    return this.request<BookmarkReview>('GET', `/v1/bookmarks/${encodeURIComponent(logicalQuestionId)}/review`, { auth: true });
  }

  // ---- avatars & themes (§20, §32.5) ----------------------------------------
  avatars() { return this.request<AvatarsResponse>('GET', '/v1/avatars', { auth: true }); }
  equipAvatar(avatarStageId: string) {
    return this.request<{ active_avatar_stage_id: string }>('POST', '/v1/avatars/equip', { auth: true, body: { avatar_stage_id: avatarStageId } });
  }
  themes() { return this.request<Theme[]>('GET', '/v1/themes', { auth: true }); }
  equipTheme(themeId: string) {
    return this.request<{ active_theme_id: string }>('POST', '/v1/themes/equip', { auth: true, body: { theme_id: themeId } });
  }

  // ---- announcements & book store (§21, §26) --------------------------------
  announcements() { return this.request<Announcement[]>('GET', '/v1/announcements', { auth: true }); }
  books() { return this.request<Book[]>('GET', '/v1/books', { auth: true }); }
  bookAdultChallenge(bookId: string) {
    return this.request<AdultChallenge>('POST', `/v1/books/${bookId}/adult-challenge`, { auth: true, body: {} });
  }
  bookRetailerHandoff(bookId: string, challengeToken: string, answer: string, retailerLinkId?: string) {
    return this.request<RetailerHandoff>('POST', `/v1/books/${bookId}/retailer-handoff`, { auth: true, body: { challenge_token: challengeToken, answer, retailer_link_id: retailerLinkId } });
  }

  // ---- learning (§9-§14) ----------------------------------------------------
  sessionStart(setVersionId: string, mode: Mode, timerType: TimerType, durationSeconds?: number) {
    return this.request<Session>('POST', '/v1/sessions/start', { auth: true, body: { set_version_id: setVersionId, mode, timer_type: timerType, duration_seconds: durationSeconds } });
  }
  activeSession() { return this.request<Session | null>('GET', '/v1/sessions/active', { auth: true }); }
  getSession(id: string) { return this.request<SessionWithQuestions>('GET', `/v1/sessions/${id}`, { auth: true }); }
  saveAnswers(id: string, answers: AnswerWrite[]) {
    return this.request<AnswerAck[]>('PATCH', `/v1/sessions/${id}/answers`, { auth: true, body: { answers } });
  }
  submit(id: string, submissionId: string, expectedSessionVersion: number) {
    return this.request<SessionResult>('POST', `/v1/sessions/${id}/submit`, {
      auth: true, headers: { 'idempotency-key': submissionId },
      body: { submission_id: submissionId, expected_session_version: expectedSessionVersion },
    });
  }
  abandon(id: string, confirm = false) {
    return this.request<{ session_id: string; terminal_state: string }>('POST', `/v1/sessions/${id}/abandon`, { auth: true, body: { confirm } });
  }
  sessionResult(id: string) { return this.request<SessionResult>('GET', `/v1/sessions/${id}/result`, { auth: true }); }
  examHistory() { return this.request<ExamHistoryItem[]>('GET', '/v1/exams/history', { auth: true }); }

  // ---- practice per-question feedback (practice sessions only) -----------------
  // Single-answer: pass one option id. Multi-correct ("pick all"): pass an array — the server
  // grades by set-equality. `selected` accepts either shape.
  practiceAttempt(sessionId: string, questionVersionId: string, selected: string | string[]) {
    const body = Array.isArray(selected) ? { selectedOptionIds: selected } : { selectedOptionId: selected };
    return this.request<PracticeAttemptResult>(
      'POST',
      `/v1/practice/sessions/${sessionId}/questions/${questionVersionId}/attempt`,
      { auth: true, body },
    );
  }
}
