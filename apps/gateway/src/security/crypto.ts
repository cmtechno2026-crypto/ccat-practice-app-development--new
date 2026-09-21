import { scrypt, randomBytes, timingSafeEqual, createHmac, randomInt } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// PIN / OTP verifier hashing using scrypt (no native deps). Format: scrypt$<saltHex>$<hashHex>.
// The pepper is applied via HMAC before hashing so a DB leak alone can't be brute-forced
// without the secret (Blueprint §4.4, §36.1).
export async function hashSecret(secret: string, pepper: string): Promise<string> {
  const salt = randomBytes(16);
  const peppered = createHmac('sha256', pepper).update(secret).digest();
  const hash = (await scryptAsync(peppered, salt, 32)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifySecret(secret: string, pepper: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  const peppered = createHmac('sha256', pepper).update(secret).digest();
  const hash = (await scryptAsync(peppered, salt, 32)) as Buffer;
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

// 6-digit numeric OTP (Blueprint guardian-otp policy).
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashToken(token: string, key: string): string {
  // Non-reversible lookup hash for refresh tokens / device hashes stored at rest. Keyed with the
  // server pepper (not a hardcoded constant) so a DB leak alone can't recompute lookup hashes.
  // NOTE: changing `key` invalidates previously stored hashes — rotate only during a re-auth window.
  return createHmac('sha256', key).update(token).digest('hex');
}

// Short, non-reversible fingerprint of an admin's stored password hash. Embedded in the admin
// access token (claim `pv`) and re-checked each request, so resetting/unlocking an admin's
// password (which changes the stored hash) invalidates every token issued before the change.
export function credentialFingerprint(passwordHash: string): string {
  return createHmac('sha256', 'ccat-admin-pv').update(passwordHash).digest('base64url').slice(0, 16);
}
