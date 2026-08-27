// @ccat/client-core — platform-agnostic domain logic shared by every client (web + mobile).
// NO React, NO DOM, NO React Native. Presentation/formatting + session glue only.
// The gateway remains the source of truth for scoring, shuffle, XP/coins/streak, consent, RBAC.
// Anything here is display math or client-side orchestration that must be identical across clients.

import type {
  SessionState, SessionQuestion, SessionWithQuestions, AnswerWrite,
} from '@ccat/api-client';

// ---- content blocks -------------------------------------------------------
// prompt_blocks / option_blocks are an extensible block model: [{type:'text', value}, ...].
// Base clients render text; richer block types (image, figure) are added later. This helper
// flattens to plain text so any client can render a baseline without knowing every block type.
export interface Block { type?: string; value?: string; [k: string]: unknown }
export function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b) => (b && typeof b === 'object' && 'value' in b ? String((b as Block).value ?? '') : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

// ---- session state machine ------------------------------------------------
export const TERMINAL_STATES: SessionState[] = [
  'SUBMITTED', 'AUTO_SUBMITTED', 'ABANDONED', 'ABANDONED_BY_INACTIVITY', 'INVALIDATED', 'CANCELLED',
];
export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.includes(state);
}
export function canAnswer(state: SessionState): boolean {
  return state === 'IN_PROGRESS';
}

// ---- answer autosave glue -------------------------------------------------
// Tracks the per-question answer_version so autosave writes monotonically increase and the
// gateway's stale-answer rejection never triggers on our own writes. Identical logic on all clients.
export class AnswerBuffer {
  private versions = new Map<string, number>();
  constructor(questions: SessionQuestion[]) {
    for (const q of questions) this.versions.set(q.question_version_id, q.answer_version ?? 0);
  }
  /** Produce the next AnswerWrite for a selection, bumping the local version. */
  next(questionVersionId: string, selectedOptionIds: string[]): AnswerWrite {
    const v = (this.versions.get(questionVersionId) ?? 0) + 1;
    this.versions.set(questionVersionId, v);
    return { question_version_id: questionVersionId, selected_option_ids: selectedOptionIds, answer_version: v };
  }
  /** Reconcile to the server-accepted version (from AnswerAck). */
  accept(questionVersionId: string, acceptedVersion: number): void {
    this.versions.set(questionVersionId, Math.max(this.versions.get(questionVersionId) ?? 0, acceptedVersion));
  }
}

// ---- timers / formatting --------------------------------------------------
export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
/** Remaining seconds for a timed session given an ISO deadline; null for untimed. */
export function remainingSeconds(deadlineAtIso: string | null, now = Date.now()): number | null {
  if (!deadlineAtIso) return null;
  return Math.max(0, Math.round((new Date(deadlineAtIso).getTime() - now) / 1000));
}

// ---- XP / level (DISPLAY ONLY — not authoritative) ------------------------
// The gateway owns XP/level truth. This mirrors a simple display ladder so the UI can show a
// level chip without a round-trip; never use it to grant anything.
export function displayLevel(xpTotal: number): number {
  return Math.max(1, Math.floor(xpTotal / 500) + 1);
}
export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

// ---- app-config / client channel (feature-flag ready) ---------------------
// Base model ships without the gateway app-config endpoint (owner deferred it). The client is
// written flag-READY: if/when GET /v1/app-config exists, drop the fetch into readAppConfig and the
// channel gate below activates with zero UI change. Until then, the channel is treated as enabled.
export type ClientChannel = 'web' | 'app';
export interface AppConfig {
  channels: Record<ClientChannel, boolean>;
  maintenance_mode: boolean;
  min_supported_version?: string;
}
export const DEFAULT_APP_CONFIG: AppConfig = {
  channels: { web: true, app: true },
  maintenance_mode: false,
};
export function channelEnabled(cfg: AppConfig | null, channel: ClientChannel): boolean {
  if (!cfg) return true; // fail-open until the endpoint exists
  return cfg.channels?.[channel] !== false && !cfg.maintenance_mode;
}

// ---- misc -----------------------------------------------------------------
export function firstName(displayName: string | undefined | null): string {
  return (displayName ?? '').trim().split(/\s+/)[0] || 'there';
}
export type { SessionWithQuestions };
