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

export function hashToken(token: string): string {
  // Non-reversible lookup hash for refresh tokens / device hashes stored at rest.
  return createHmac('sha256', 'ccat-token-hash').update(token).digest('hex');
}
