// Structured error envelope (Blueprint §32.1). Canonical codes mirror the specs
// (session-state-machine.md §8, idempotency-retry-contract.md).

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (msg: string, details?: Record<string, unknown>) =>
    new AppError(422, 'VALIDATION_ERROR', msg, details),
  unauthorized: (msg = 'Unauthorized') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (code: string, msg: string) => new AppError(403, code, msg),
  notFound: (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (code: string, msg: string, details?: Record<string, unknown>) =>
    new AppError(409, code, msg, details),
  // Duplicate userID at registration — a 422 with a friendly, form-level message (the userID is the
  // unique students.username_normalized; the DB unique constraint is the source of truth).
  usernameTaken: () =>
    new AppError(422, 'USERNAME_TAKEN', 'That username is already taken — please choose another.'),
  rateLimited: (msg = 'Rate limited') => new AppError(429, 'RATE_LIMITED', msg),
  // Domain-specific
  activeSessionExists: () =>
    new AppError(409, 'ACTIVE_SESSION_EXISTS', 'A learning session is already in progress'),
  sessionTerminal: () =>
    new AppError(409, 'SESSION_TERMINAL', 'Session is already in a terminal state'),
  staleAnswer: () => new AppError(409, 'STALE_ANSWER', 'Answer version is stale'),
  sessionVersionConflict: () =>
    new AppError(409, 'SESSION_VERSION_CONFLICT', 'Expected session version mismatch'),
  deviceNotEnrolled: () =>
    new AppError(403, 'DEVICE_NOT_ENROLLED', 'Request device is not the enrolled device'),
  idempotencyReuse: () =>
    new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused with a different body'),
};

export function toEnvelope(err: unknown, requestId?: string) {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      body: {
        error: {
          code: err.code,
          message: err.message,
          request_id: requestId,
          ...(err.details ? { details: err.details } : {}),
        },
      },
    };
  }
  return {
    statusCode: 500,
    body: {
      error: { code: 'INTERNAL', message: 'Internal error', request_id: requestId },
    },
  };
}
