import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { SupabaseAdminAuth, SupabaseAdminDirectory } from '../src/services/adminAuth.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FACTOR_ID = '22222222-2222-4222-8222-222222222222';

const cfg: Config = {
  port: 8080,
  host: '0.0.0.0',
  databaseUrl: 'postgres://unused',
  hmacSecret: 'test-secret',
  env: 'production',
  pinPepper: 'test-pepper',
  otpTtlSeconds: 600,
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  untimedPracticeInactivityHours: 24,
  storageDriver: 'supabase',
  uploadsDir: '.uploads',
  publicUrl: 'https://gateway.example.com',
  supabaseUrl: 'https://project.supabase.co',
  supabasePublishableKey: 'sb_publishable_test',
  supabaseSecretKey: 'sb_secret_test',
  supabaseStorageBucket: 'ccat-content',
};

function jwt(payload: Record<string, unknown>) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function session(factors: Array<{ id: string; factor_type: string; status: 'verified' | 'unverified' }>) {
  return {
    access_token: jwt({ sub: USER_ID, aal: 'aal1' }),
    refresh_token: 'refresh',
    expires_in: 3600,
    user: { id: USER_ID, email: 'admin@example.com', factors },
  };
}

describe('SupabaseAdminAuth', () => {
  it('requires a TOTP code when a verified factor exists', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(session([
      { id: FACTOR_ID, factor_type: 'totp', status: 'verified' },
    ])));
    const auth = new SupabaseAdminAuth(cfg, fetcher);

    await expect(auth.authenticate('admin@example.com', 'password')).rejects.toMatchObject({
      statusCode: 403,
      code: 'MFA_REQUIRED',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('challenges, verifies, validates, and returns an AAL2 identity', async () => {
    const login = session([{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }]);
    const aal2 = jwt({ sub: USER_ID, aal: 'aal2' });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(login))
      .mockResolvedValueOnce(json({ id: 'challenge-id', type: 'totp' }))
      .mockResolvedValueOnce(json({ ...login, access_token: aal2 }))
      .mockResolvedValueOnce(json({ id: USER_ID, email: 'admin@example.com' }));
    const auth = new SupabaseAdminAuth(cfg, fetcher);

    await expect(auth.authenticate('admin@example.com', 'password', '123456')).resolves.toEqual({
      id: USER_ID,
      email: 'admin@example.com',
    });
    expect(fetcher.mock.calls[1]![0]).toBe(`https://project.supabase.co/auth/v1/factors/${FACTOR_ID}/challenge`);
    expect(JSON.parse(String((fetcher.mock.calls[2]![1] as RequestInit).body))).toEqual({
      challenge_id: 'challenge-id',
      code: '123456',
    });
    expect((fetcher.mock.calls[3]![1] as RequestInit).headers).toMatchObject({
      authorization: `Bearer ${aal2}`,
      apikey: 'sb_publishable_test',
    });
  });

  it('starts first-login TOTP enrollment without exposing the Supabase session', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(session([])))
      .mockResolvedValueOnce(json({ id: FACTOR_ID, totp: { qr_code: 'data:image/svg+xml;base64,abc', secret: 'SETUPKEY' } }));
    const auth = new SupabaseAdminAuth(cfg, fetcher);

    try {
      await auth.authenticate('admin@example.com', 'password');
      throw new Error('expected enrollment requirement');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        statusCode: 403,
        code: 'MFA_ENROLLMENT_REQUIRED',
        details: { qr_code: 'data:image/svg+xml;base64,abc', secret: 'SETUPKEY' },
      });
      expect(JSON.stringify((error as AppError).details)).not.toContain('refresh');
    }
    expect(fetcher.mock.calls[1]![0]).toBe('https://project.supabase.co/auth/v1/factors');
  });

  it('rejects a provider token that did not reach AAL2', async () => {
    const login = session([{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }]);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(login))
      .mockResolvedValueOnce(json({ id: 'challenge-id' }))
      .mockResolvedValueOnce(json(login));
    const auth = new SupabaseAdminAuth(cfg, fetcher);

    await expect(auth.authenticate('admin@example.com', 'password', '123456')).rejects.toMatchObject({
      statusCode: 403,
      code: 'MFA_REQUIRED',
    });
  });

  it('maps provider rate limiting without leaking provider details', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ message: 'internal provider detail' }, 429));
    const auth = new SupabaseAdminAuth(cfg, fetcher);

    await expect(auth.authenticate('admin@example.com', 'password')).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('maps an expired or invalid TOTP response to MFA_INVALID', async () => {
    const login = session([{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }]);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(login))
      .mockResolvedValueOnce(json({ id: 'challenge-id' }))
      .mockResolvedValueOnce(json({ code: 'mfa_verification_failed', message: 'provider detail' }, 422));
    const auth = new SupabaseAdminAuth(cfg, fetcher);

    await expect(auth.authenticate('admin@example.com', 'password', '000000')).rejects.toMatchObject({
      statusCode: 401,
      code: 'MFA_INVALID',
      message: 'Invalid authenticator code',
    });
  });
});

describe('SupabaseAdminDirectory', () => {
  it('creates an Auth identity with the database profile id and server-only secret', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ id: USER_ID }));
    const directory = new SupabaseAdminDirectory(cfg, fetcher);

    await directory.createUser(USER_ID, 'admin@example.com', 'temporary-password');

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://project.supabase.co/auth/v1/admin/users');
    expect((init as RequestInit).headers).toMatchObject({
      apikey: 'sb_secret_test',
      authorization: 'Bearer sb_secret_test',
    });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      id: USER_ID,
      email: 'admin@example.com',
      email_confirm: true,
      app_metadata: { ccat_admin: true },
    });
  });

  it('uses Auth admin operations for password, disable, enable, and deletion', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ id: USER_ID }));
    const directory = new SupabaseAdminDirectory(cfg, fetcher);

    await directory.setPassword(USER_ID, 'new-temporary-password');
    await directory.setDisabled(USER_ID, true);
    await directory.setDisabled(USER_ID, false);
    await directory.deleteUser(USER_ID);

    expect(JSON.parse(String((fetcher.mock.calls[0]![1] as RequestInit).body))).toMatchObject({ password: 'new-temporary-password' });
    expect(JSON.parse(String((fetcher.mock.calls[1]![1] as RequestInit).body))).toEqual({ ban_duration: '876000h' });
    expect(JSON.parse(String((fetcher.mock.calls[2]![1] as RequestInit).body))).toEqual({ ban_duration: 'none' });
    expect((fetcher.mock.calls[3]![1] as RequestInit).method).toBe('DELETE');
  });
});
