import type { Config } from '../config.js';
import { AppError, Errors } from '../errors.js';

type Factor = {
  id: string;
  factor_type: string;
  status: 'verified' | 'unverified';
};

type AuthUser = {
  id: string;
  email?: string;
  factors?: Factor[];
};

type AuthSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: AuthUser;
};

type Enrollment = {
  id: string;
  totp: { qr_code: string; secret: string };
};

export type SupabaseAdminIdentity = { id: string; email: string };

export class SupabaseAdminDirectory {
  private readonly authUrl: string;
  private readonly key: string;

  constructor(cfg: Config, private readonly fetcher: typeof fetch = fetch) {
    if (!cfg.supabaseUrl || !cfg.supabaseSecretKey) {
      throw new Error('Supabase Admin Directory requires SUPABASE_URL and SUPABASE_SECRET_KEY');
    }
    this.authUrl = `${cfg.supabaseUrl}/auth/v1`;
    this.key = cfg.supabaseSecretKey;
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.authUrl}${path}`, {
        ...init,
        headers: {
          apikey: this.key,
          authorization: `Bearer ${this.key}`,
          'content-type': 'application/json',
          'x-supabase-api-version': '2024-01-01',
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new AppError(502, 'AUTH_PROVIDER_UNAVAILABLE', 'Authentication provider is unavailable');
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const code = String(body.code ?? body.error_code ?? '');
      if (code === 'email_exists' || code === 'user_already_exists') {
        throw Errors.conflict('EMAIL_TAKEN', 'An admin with that email exists');
      }
      if (response.status >= 500) throw new AppError(502, 'AUTH_PROVIDER_UNAVAILABLE', 'Authentication provider is unavailable');
      throw new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication provider rejected the admin operation');
    }
    return body;
  }

  async createUser(id: string, email: string, password: string): Promise<void> {
    const user = await this.request('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        id,
        email,
        password,
        email_confirm: true,
        app_metadata: { ccat_admin: true },
      }),
    });
    if (user.id !== id) throw new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication provider created a mismatched identity');
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.request(`/admin/users/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ password, ban_duration: 'none' }),
    });
  }

  async setDisabled(id: string, disabled: boolean): Promise<void> {
    await this.request(`/admin/users/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ ban_duration: disabled ? '876000h' : 'none' }),
    });
  }

  async deleteUser(id: string): Promise<void> {
    await this.request(`/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication provider returned an invalid token');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication provider returned an invalid token');
  }
}

export class SupabaseAdminAuth {
  private readonly authUrl: string;
  private readonly key: string;

  constructor(cfg: Config, private readonly fetcher: typeof fetch = fetch) {
    if (!cfg.supabaseUrl || !cfg.supabasePublishableKey) {
      throw new Error('Supabase Admin Auth requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY');
    }
    this.authUrl = `${cfg.supabaseUrl}/auth/v1`;
    this.key = cfg.supabasePublishableKey;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    accessToken?: string,
    errorKind?: 'credentials' | 'mfa',
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.authUrl}${path}`, {
        ...init,
        headers: {
          apikey: this.key,
          'content-type': 'application/json',
          'x-supabase-api-version': '2024-01-01',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new AppError(502, 'AUTH_PROVIDER_UNAVAILABLE', 'Authentication provider is unavailable');
    }

    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const providerCode = String(body.code ?? body.error_code ?? '');
      if (response.status === 429) throw Errors.rateLimited('Too many authentication attempts. Try again shortly.');
      if (errorKind === 'credentials' && (providerCode === 'invalid_credentials' || response.status === 400 || response.status === 401)) {
        throw Errors.unauthorized('Invalid credentials');
      }
      if (errorKind === 'mfa' && [400, 401, 422].includes(response.status)) {
        throw new AppError(401, 'MFA_INVALID', 'Invalid authenticator code');
      }
      if (response.status >= 500) throw new AppError(502, 'AUTH_PROVIDER_UNAVAILABLE', 'Authentication provider is unavailable');
      throw new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication provider rejected the request');
    }
    return body as T;
  }

  private async challengeAndVerify(session: AuthSession, factorId: string, code: string): Promise<AuthSession> {
    const challenge = await this.request<{ id: string }>(
      `/factors/${encodeURIComponent(factorId)}/challenge`,
      { method: 'POST', body: JSON.stringify({ factorId }) },
      session.access_token,
    );
    if (!challenge.id) throw new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication provider returned an invalid challenge');
    return this.request<AuthSession>(
      `/factors/${encodeURIComponent(factorId)}/verify`,
      { method: 'POST', body: JSON.stringify({ challenge_id: challenge.id, code }) },
      session.access_token,
      'mfa',
    );
  }

  private async beginEnrollment(session: AuthSession, factors: Factor[]): Promise<never> {
    for (const factor of factors.filter((item) => item.factor_type === 'totp' && item.status === 'unverified')) {
      await this.request(`/factors/${encodeURIComponent(factor.id)}`, { method: 'DELETE' }, session.access_token);
    }
    const enrollment = await this.request<Enrollment>(
      '/factors',
      { method: 'POST', body: JSON.stringify({ factor_type: 'totp', friendly_name: 'CCAT Admin' }) },
      session.access_token,
    );
    if (!enrollment.id || !enrollment.totp?.qr_code || !enrollment.totp.secret) {
      throw new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication provider returned invalid enrollment data');
    }
    throw new AppError(403, 'MFA_ENROLLMENT_REQUIRED', 'Set up an authenticator app to continue', {
      qr_code: enrollment.totp.qr_code,
      secret: enrollment.totp.secret,
    });
  }

  async authenticate(email: string, password: string, mfaCode?: string): Promise<SupabaseAdminIdentity> {
    const session = await this.request<AuthSession>('/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }, undefined, 'credentials');
    if (!session.user?.id || !session.access_token) {
      throw new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication provider returned an incomplete session');
    }

    const factors = session.user.factors ?? [];
    const verified = factors.find((item) => item.factor_type === 'totp' && item.status === 'verified');
    const pending = factors.find((item) => item.factor_type === 'totp' && item.status === 'unverified');
    if (!mfaCode) {
      if (verified) throw Errors.forbidden('MFA_REQUIRED', 'Enter the code from your authenticator app');
      return this.beginEnrollment(session, factors);
    }

    const factor = verified ?? pending;
    if (!factor) return this.beginEnrollment(session, factors);
    const verifiedSession = await this.challengeAndVerify(session, factor.id, mfaCode);
    const claims = decodePayload(verifiedSession.access_token);
    if (claims.aal !== 'aal2' || claims.sub !== session.user.id) {
      throw Errors.forbidden('MFA_REQUIRED', 'Multi-factor authentication is required');
    }

    // Ask Supabase Auth to validate the upgraded token; do not trust a locally decoded payload alone.
    const user = await this.request<AuthUser>('/user', { method: 'GET' }, verifiedSession.access_token);
    if (user.id !== session.user.id || !user.email) {
      throw new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication identity mismatch');
    }
    return { id: user.id, email: user.email };
  }
}
