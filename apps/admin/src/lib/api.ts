// Typed client for the CCAT Gateway admin API. Token kept in memory + sessionStorage.
const GATEWAY: string = (window as any).__CCAT_GATEWAY__ || (import.meta as any).env?.VITE_GATEWAY_URL || 'http://localhost:8080';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message); this.name = 'ApiError';
  }
}

let token: string | null = sessionStorage.getItem('ccat_admin_token');
export function setToken(t: string | null) {
  token = t;
  if (t) sessionStorage.setItem('ccat_admin_token', t); else sessionStorage.removeItem('ccat_admin_token');
}
export function getToken() { return token; }

async function req<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const h: Record<string, string> = { ...(headers || {}) };
  if (token) h['authorization'] = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(GATEWAY + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) { const e = json?.error || {}; throw new ApiError(res.status, e.code || 'UNKNOWN', e.message || res.statusText, e.details); }
  return json as T;
}

export const api = {
  gateway: GATEWAY,
  // auth
  login: (email: string, password: string) => req<{ access_token: string; admin: any }>('POST', '/v1/admin/auth/login', { email, password }),
  me: () => req<any>('GET', '/v1/admin/me'),
  // dashboard + health
  dashboard: (window = 7) => req<any>('GET', `/v1/admin/dashboard?window=${window}`),
  health: () => req<any>('GET', '/v1/admin/health'),
  opsJobs: () => req<{ jobs: any[] }>('GET', '/v1/admin/ops/jobs'),
  opsInfrastructure: () => req<{ backup: any; disaster_recovery: any; failover: any }>('GET', '/v1/admin/ops/infrastructure'),
  opsProviders: () => req<{ providers: any[] }>('GET', '/v1/admin/ops/providers'),
  // students
  students: (opts: { limit?: number; cursor?: string; q?: string; status?: string; band?: string; sort?: string; dir?: string } = {}) => {
    const p = new URLSearchParams();
    p.set('limit', String(opts.limit ?? 50));
    if (opts.cursor) p.set('cursor', opts.cursor);
    if (opts.q) p.set('q', opts.q);
    if (opts.status) p.set('status', opts.status);
    if (opts.band) p.set('band', opts.band);
    if (opts.sort) p.set('sort', opts.sort);
    if (opts.dir) p.set('dir', opts.dir);
    return req<{ matched: number; items: any[]; next_cursor: string | null }>('GET', `/v1/admin/students?${p.toString()}`);
  },
  studentStats: () => req<{ total: number; active: number; suspended: number; banned: number; pending_deletion: number; practised_today: number }>('GET', '/v1/admin/students/stats'),
  studentDetail: (id: string) => req<any>('GET', `/v1/admin/students/${id}/detail`),
  studentStatus: (id: string, version: number, to_status: string, reason_code: string, reason_text?: string) =>
    req<any>('POST', `/v1/admin/students/${id}/status`, { to_status, reason_code, reason_text }, { 'if-match': String(version) }),
  revokeDevice: (id: string, reason: string) => req<any>('POST', `/v1/admin/students/${id}/device/revoke`, { reason }),
  breakGlass: (id: string, b: { platform?: string; device_hash: string; verification_note: string; reference?: string }) => req<any>('POST', `/v1/admin/students/${id}/device/break-glass`, b),
  approveBreakGlass: (id: string, reqId: string) => req<any>('POST', `/v1/admin/students/${id}/device/break-glass/${reqId}/approve`),
  denyBreakGlass: (id: string, reqId: string) => req<any>('POST', `/v1/admin/students/${id}/device/break-glass/${reqId}/deny`),
  requestDeletion: (id: string, reference?: string) => req<any>('POST', `/v1/admin/students/${id}/deletion`, { reference }),
  purgeStudent: (id: string, reference?: string) => req<{ purged: boolean; status: string }>('POST', `/v1/admin/students/${id}/purge`, { reference }),
  rewardAdjust: (student_id: string, kind: string, delta: number, reason: string, reference: string) =>
    req<any>('POST', '/v1/admin/rewards/adjust', { student_id, kind, delta, reason, reference }),
  // content
  taxonomy: () => req<any>('GET', '/v1/admin/content/taxonomy'),
  questions: (q: { state?: string; grade_id?: string; category_id?: string } = {}) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as any).toString();
    return req<{ items: any[] }>('GET', `/v1/admin/content/questions${p ? '?' + p : ''}`);
  },
  question: (id: string) => req<any>('GET', `/v1/admin/content/questions/${id}`),
  createQuestion: (b: any) => req<any>('POST', '/v1/admin/content/questions', b),
  editQuestion: (id: string, b: any) => req<any>('PATCH', `/v1/admin/content/questions/${id}`, b),
  questionVersions: (id: string) => req<{ items: any[] }>('GET', `/v1/admin/content/questions/${id}/versions`),
  reviewQuestion: (id: string, decision: string, feedback?: string) => req<any>('POST', `/v1/admin/content/questions/${id}/review`, { decision, feedback }),
  publishQuestion: (id: string) => req<any>('POST', `/v1/admin/content/questions/${id}/publish`),
  retireQuestion: (id: string) => req<any>('POST', `/v1/admin/content/questions/${id}/retire`),
  uploadAsset: (mime_type: string, data_base64: string, alt_text?: string, constraint?: 'avatar_512') => req<{ id: string; url: string }>('POST', '/v1/admin/content/assets', { mime_type, data_base64, alt_text, constraint }),
  // Batch upload many figures in ONE request (bulk-add with figures). Server stores with bounded concurrency
  // and inserts the rows in one shot; returns assets 1:1 with input order plus the measured timings.
  uploadAssetsBatch: (images: { mime_type: string; data_base64: string; alt_text?: string }[]) =>
    req<{ assets: { id: string; url: string }[]; count: number; unique: number; upload_ms: number; insert_ms: number; elapsed_ms: number }>('POST', '/v1/admin/content/assets/batch', { images }),
  // Public, unauthenticated serve route (redirects to cloud storage or streams local bytes). Used as an
  // <img src> — must NOT require a bearer token, so it points at /v1/assets/:id, not the admin route.
  assetUrl: (id: string) => `${GATEWAY}/v1/assets/${id}`,
  // sets + exam papers
  sets: () => req<{ items: any[] }>('GET', '/v1/admin/content/sets'),
  set: (id: string) => req<any>('GET', `/v1/admin/content/sets/${id}`),
  createSet: (b: any) => req<{ set_version_id: string }>('POST', '/v1/admin/content/sets', b),
  patchSet: (id: string, b: { name?: string; duration_minutes?: number | null; preserve_order?: boolean }) => req<any>('PATCH', `/v1/admin/content/sets/${id}`, b),
  setMembership: (id: string, question_version_ids: string[]) => req<any>('POST', `/v1/admin/content/sets/${id}/questions`, { question_version_ids }),
  // Google-Forms-style batch author: save one OR many question cards into a set (or a single exam
  // battery via scope_category_id) in one pass.
  authorSet: (id: string, questions: any[], scope_category_id?: string) => req<{ question_version_ids: string[]; question_count: number }>('POST', `/v1/admin/content/sets/${id}/author`, scope_category_id ? { questions, scope_category_id } : { questions }),
  // Ensure a grade's 3 starter exam papers exist (idempotent; creates only when the grade has none).
  scaffoldExamPapers: (grade_id: string) => req<{ created: number }>('POST', '/v1/admin/content/exam-papers/scaffold', { grade_id }),
  // Scoped bulk import: each row names its scope (grade/battery/category/difficulty) + question fields.
  // The gateway resolves scope, groups by it, creates DRAFT practice set(s), and returns imported/
  // created sets + rejected rows (with reasons). Nothing publishes until the admin publishes each set.
  importScopedQuestions: (rows: any[]) => req<{ imported: number; sets: { set_version_id: string; name: string; grade: number; battery: string; category: string; difficulty: string; question_count: number }[]; rejected: { index: number; reasons: string[] }[] }>('POST', '/v1/admin/content/import', { rows }),
  setQuestionActive: (id: string, qid: string, active: boolean) => req<any>('PATCH', `/v1/admin/content/sets/${id}/questions/${qid}`, { active }),
  publishSet: (id: string) => req<any>('POST', `/v1/admin/content/sets/${id}/publish`),
  unpublishSet: (id: string) => req<any>('POST', `/v1/admin/content/sets/${id}/unpublish`),
  // Retire a published set — removes it from the live student catalog (published → 'retired'). Uses the
  // dedicated /retire route (guarded by content.retire). Published sets are immutable (§8.1); to bring
  // content back, copy the set to a new draft and publish.
  retireSet: (id: string) => req<any>('POST', `/v1/admin/content/sets/${id}/retire`),
  copySet: (id: string) => req<{ id: string }>('POST', `/v1/admin/content/sets/${id}/copy`),
  deleteSet: (id: string) => req<any>('DELETE', `/v1/admin/content/sets/${id}`),
  learningPlans: () => req<{ items: any[] }>('GET', '/v1/admin/content/learning-plans'),
  // config
  grades: () => req<{ items: any[] }>('GET', '/v1/admin/config/grades'),
  patchGrade: (id: string, b: any) => req<any>('PATCH', `/v1/admin/config/grades/${id}`, b),
  flags: () => req<{ items: any[] }>('GET', '/v1/admin/config/flags'),
  setFlag: (key: string, value: boolean, reason?: string) => req<any>('POST', '/v1/admin/config/flags', { key, value, reason }),
  // Payments Phase 2 — manual membership grant (Super-Admin, gated by config.global). Keyed by lower(email).
  getEntitlement: (email: string) => req<{ item: any; students: any[]; allowed_tiers: string[] }>('GET', `/v1/admin/entitlements?email=${encodeURIComponent(email)}`),
  setEntitlement: (b: { guardian_email: string; tier: 'free' | 't50' | 't250' | 't500'; status?: string; current_period_end?: string | null }) => req<{ item: any }>('POST', '/v1/admin/entitlements', b),
  // rewards
  achievements: () => req<{ items: any[] }>('GET', '/v1/admin/rewards/achievements'),
  createAchievement: (b: any) => req<any>('POST', '/v1/admin/rewards/achievements', b),
  setAchievementActive: (versionId: string, active: boolean) => req<any>('PATCH', `/v1/admin/rewards/achievements/versions/${versionId}`, { active }),
  editAchievement: (versionId: string, b: { name?: string; xp?: number | null; coins?: number | null; active?: boolean }) => req<any>('PATCH', `/v1/admin/rewards/achievements/versions/${versionId}`, b),
  avatars: () => req<{ items: any[] }>('GET', '/v1/admin/rewards/avatars'),
  patchStage: (id: string, b: { active?: boolean; required_xp?: number; name?: string; asset_id?: string | null }) => req<any>('PATCH', `/v1/admin/rewards/avatars/stages/${id}`, b),
  createStage: (b: { family_id: string; stage_number: number; name: string; required_xp: number; active?: boolean; asset_id?: string }) => req<any>('POST', '/v1/admin/rewards/avatars/stages', b),
  createFamily: (key: string, name: string) => req<any>('POST', '/v1/admin/rewards/avatars/families', { key, name }),
  patchFamily: (id: string, b: { active?: boolean; name?: string }) => req<any>('PATCH', `/v1/admin/rewards/avatars/families/${id}`, b),
  themes: () => req<{ items: any[] }>('GET', '/v1/admin/rewards/themes'),
  setThemeActive: (id: string, active: boolean) => req<any>('PATCH', `/v1/admin/rewards/themes/${id}`, { active }),
  editTheme: (id: string, b: { name?: string; palette?: Record<string, string>; active?: boolean }) => req<any>('PATCH', `/v1/admin/rewards/themes/${id}`, b),
  makeThemeDefault: (id: string) => req<any>('POST', `/v1/admin/rewards/themes/${id}/make-default`),
  economy: () => req<any>('GET', '/v1/admin/rewards/economy'),
  publishEconomy: (b: { base_xp?: Record<string, number>; streak_milestones?: Record<string, number>; difficulty_weight?: Record<string, number>; version_label?: string }) => req<any>('POST', '/v1/admin/rewards/economy/config', b),
  recomputeEconomy: () => req<{ recomputed: boolean; xp: number; coin: number }>('POST', '/v1/admin/rewards/economy/recompute'),
  // comms
  announcements: () => req<{ items: any[] }>('GET', '/v1/admin/announcements'),
  createAnnouncement: (b: { title: string; body_text: string; target_grade_ids?: string[]; channel?: 'carousel' | 'carousel_push'; scheduled_at?: string; ends_at?: string }) => req<any>('POST', '/v1/admin/announcements', b),
  publishAnnouncement: (id: string) => req<any>('POST', `/v1/admin/announcements/${id}/publish`),
  stopAnnouncement: (id: string) => req<any>('POST', `/v1/admin/announcements/${id}/stop`),
  restartAnnouncement: (id: string) => req<any>('POST', `/v1/admin/announcements/${id}/restart`),
  archiveAnnouncement: (id: string) => req<any>('POST', `/v1/admin/announcements/${id}/archive`),
  duplicateAnnouncement: (id: string) => req<{ id: string }>('POST', `/v1/admin/announcements/${id}/duplicate`),
  patchAnnouncement: (id: string, b: { ends_at?: string | null; scheduled_at?: string }) => req<any>('PATCH', `/v1/admin/announcements/${id}`, b),
  pushCampaigns: () => req<{ items: any[] }>('GET', '/v1/admin/push/campaigns'),
  pushPiiCheck: (message: string) => req<{ safe: boolean; reason?: string }>('POST', '/v1/admin/push/pii-check', { message }),
  requestPush: (b: { title: string; message: string; scheduled_at?: string; audience_grade_ids?: string[] }) => req<any>('POST', '/v1/admin/push/campaigns', b),
  approvePush: (id: string, decision: string, reason?: string) => req<any>('POST', `/v1/admin/push/campaigns/${id}/approval`, { decision, reason }),
  books: () => req<{ items: any[] }>('GET', '/v1/admin/books'),
  bookRetailers: () => req<{ platforms: { key: string; label: string; domains: string[] }[] }>('GET', '/v1/admin/books/retailers'),
  createBook: (b: { title: string; author?: string; description?: string; price_cents?: number; subject?: string; grade_ids?: string[]; retailer: string; url: string }) => req<{ id: string }>('POST', '/v1/admin/books', b),
  patchBook: (id: string, b: { title?: string; author?: string | null; description?: string | null; active?: boolean; price_cents?: number | null; subject?: string | null; grade_ids?: string[] | null }) => req<any>('PATCH', `/v1/admin/books/${id}`, b),
  addBookLink: (id: string, b: { retailer: string; url: string; kind?: string; display_order?: number }) => req<{ id: string }>('POST', `/v1/admin/books/${id}/links`, b),
  patchBookLink: (id: string, linkId: string, b: { retailer?: string; url?: string; kind?: string | null; active?: boolean; display_order?: number }) => req<any>('PATCH', `/v1/admin/books/${id}/links/${linkId}`, b),
  deleteBookLink: (id: string, linkId: string) => req<any>('DELETE', `/v1/admin/books/${id}/links/${linkId}`),
  // accounts
  accounts: () => req<{ items: any[] }>('GET', '/v1/admin/accounts'),
  createAccount: (b: { email: string; display_name: string; role: string; permissions: string[]; temp_password?: string; recovery_channel?: 'email' | 'phone' }) => req<{ id: string; temp_password: string; generated: boolean }>('POST', '/v1/admin/accounts', b),
  patchAccount: (id: string, b: { status?: string; role?: string; permissions?: string[] }) => req<any>('PATCH', `/v1/admin/accounts/${id}`, b),
  deleteAccount: (id: string, reference?: string) => req<{ deleted: boolean; status: string }>('DELETE', `/v1/admin/accounts/${id}`, { reference }),
  // Reset an admin's password (Super-Admin only, enforced server-side). Omit new_password to GENERATE a
  // strong one (returned once); supply new_password to SET it (validated server-side, not echoed back).
  resetAccountPassword: (id: string, body: { new_password?: string; require_change?: boolean } = {}) =>
    req<{ mode: 'generated'; password: string } | { mode: 'set' }>('POST', `/v1/admin/accounts/${id}/reset-password`, body),
  unlockAccount: (id: string) => req<{ unlocked: boolean; temp_password: string }>('POST', `/v1/admin/accounts/${id}/unlock`),
  permissions: () => req<{ items: any[] }>('GET', '/v1/admin/permissions'),
  permissionBundles: () => req<{ bundles: { key: string; label: string; description: string; permissions: string[] }[] }>('GET', '/v1/admin/permissions/bundles'),
  // audit
  audit: (opts: { scope?: 'self' | 'global'; event?: string; target_kind?: string; category?: string; actor?: string; q?: string; from?: string; to?: string; cursor?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    p.set('scope', opts.scope ?? 'self');
    for (const k of ['event', 'target_kind', 'category', 'actor', 'q', 'from', 'to', 'cursor'] as const) if (opts[k]) p.set(k, opts[k] as string);
    if (opts.limit) p.set('limit', String(opts.limit));
    return req<{ items: any[]; scope: string; next_cursor: string | null }>('GET', `/v1/admin/audit?${p.toString()}`);
  },
  auditFacets: (scope: 'self' | 'global' = 'self') => req<{ event_types: string[]; target_kinds: string[]; actors: { id: string; name: string }[] }>('GET', `/v1/admin/audit/facets?scope=${scope}`),
  // Server-side CSV export — permission (audit.export.self) is enforced by the gateway, not here. The
  // endpoint is authenticated (bearer), so we fetch with the token and hand back a Blob to download;
  // a plain <a href> would omit the Authorization header. Exports the FULL filtered set, not the page.
  auditExport: async (opts: { scope?: 'self' | 'global'; category?: string; actor?: string; q?: string; from?: string; to?: string } = {}) => {
    const p = new URLSearchParams();
    p.set('scope', opts.scope ?? 'self');
    for (const k of ['category', 'actor', 'q', 'from', 'to'] as const) if (opts[k]) p.set(k, opts[k] as string);
    const res = await fetch(GATEWAY + `/v1/admin/audit/export?${p.toString()}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!res.ok) { let e: any = {}; try { e = (JSON.parse(await res.text())).error || {}; } catch {} throw new ApiError(res.status, e.code || 'UNKNOWN', e.message || res.statusText, e.details); }
    const cd = res.headers.get('content-disposition') || '';
    return { blob: await res.blob(), filename: cd.match(/filename="?([^"]+)"?/)?.[1] || `ccat-audit-${opts.scope ?? 'self'}.csv`, truncated: res.headers.get('x-export-truncated') === 'true' };
  },
};
