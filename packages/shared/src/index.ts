// Shared constants/types across gateway + (future) admin-web + mobile.
export const CCAT_API_VERSION = 'v1';
export const SESSION_STATES = ['IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED','ABANDONED','ABANDONED_BY_INACTIVITY','INVALIDATED','CANCELLED'] as const;
export type SessionState = typeof SESSION_STATES[number];
