import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

// Compact HMAC-signed access token (JWT-like, no external dep). Payload carries the
// student/device/auth-session identity; the Gateway still re-validates against the DB on
// every request (Blueprint §5.4) — the token is not trusted as an authorization boundary.

export interface StudentTokenPayload {
  sub: string; // student_id
  did: string; // device_id
  sid: string; // auth_session id
  exp: number; // unix seconds
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signToken(payload: StudentTokenPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): StudentTokenPayload | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as StudentTokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

// Admin access token — HMAC signed, re-validated against the DB on every request (§22.1).
export interface AdminTokenPayload { sub: string; exp: number; }
export function signAdminToken(payload: AdminTokenPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', secret + ':admin-session').update(body).digest());
  return `${body}.${sig}`;
}
export function verifyAdminToken(token: string, secret: string): AdminTokenPayload | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret + ':admin-session').update(body).digest());
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as AdminTokenPayload;
    if (typeof p.exp !== 'number' || p.exp * 1000 < Date.now()) return null;
    return p;
  } catch { return null; }
}

export interface AdminPasswordChangeToken { sub: string; purpose: 'password_change'; exp: number; }
export function signAdminPasswordChangeToken(payload: AdminPasswordChangeToken, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', secret + ':admin-password-change').update(body).digest());
  return `${body}.${sig}`;
}
export function verifyAdminPasswordChangeToken(token: string, secret: string): AdminPasswordChangeToken | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot); const sig = token.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret + ':admin-password-change').update(body).digest());
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as AdminPasswordChangeToken;
    if (payload.purpose !== 'password_change' || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// Short-lived signed grant/ticket that carries the guardian + consent state between the stateless
// registration steps (Blueprint §4). ONE guardian_contact holds name + email + phone. Contacts are
// VALIDATED server-side (email format + E.164 phone), NOT verified by OTP — `validated` is set once
// the contact passes validation and is persisted. Not a session; single registration use.
export interface RegistrationGrant {
  guardianId: string;          // the single ccat.guardian_contacts row for this registration
  guardianName?: string;
  guardianEmail?: string;      // normalized (lowercased) email
  guardianPhone?: string;      // normalized E.164 phone
  validated: boolean;          // email + phone passed server-side validation and were persisted
  policyVersion?: string;
  consentHash?: string;
  exp: number;
}
// The account-creating steps require a validated contact (not an OTP-verified one).
export function grantValidated(g: RegistrationGrant): boolean {
  return g.validated === true;
}

export function signGrant(grant: RegistrationGrant, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(grant)));
  const sig = b64url(createHmac('sha256', secret + ':grant').update(body).digest());
  return `${body}.${sig}`;
}

export function verifyGrant(token: string, secret: string): RegistrationGrant | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret + ':grant').update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const grant = JSON.parse(Buffer.from(body, 'base64url').toString()) as RegistrationGrant;
    if (grant.exp * 1000 < Date.now()) return null;
    return grant;
  } catch {
    return null;
  }
}
