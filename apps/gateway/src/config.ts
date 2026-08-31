// Gateway configuration. Secrets come from the environment / managed secret store,
// never from VCS (Blueprint §36.2 "no secret in browser bundle", §36.3 managed secret store).

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  hmacSecret: string;
  env: 'local' | 'development' | 'staging' | 'production';
  // Launch defaults; all are config-versioned in production (§30).
  pinPepper: string;
  otpTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  untimedPracticeInactivityHours: number;
  // Service abstractions (Blueprint §36). Drivers are pluggable; local is the dev default.
  storageDriver: string;      // local | s3 | supabase | gcs
  uploadsDir: string;         // local-disk asset root
  // Supabase Storage (used only when STORAGE_DRIVER=supabase). Service-role key is SERVER-ONLY and never
  // reaches a browser bundle. Read from env; empty in local/dev where the local-disk driver is used.
  supabaseUrl: string;
  supabaseServiceKey: string;
  storageBucket: string;      // Supabase Storage bucket name (default 'assets')
}

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Known dev/placeholder secret values that must never reach production. The pepper and HMAC secret
// are the DB-leak protection for PIN/password hashes and the token signer, so a silent fallback to a
// public value would defeat them entirely.
const WEAK_SECRETS = new Set(['dev-pepper', 'change-me', 'change-me-in-prod', 'changeme', 'secret', 'password', '']);

export function loadConfig(): Config {
  const env = (process.env.NODE_ENV as Config['env']) ?? 'local';
  const isProd = env === 'production';
  const hmacSecret = required('GATEWAY_HMAC_SECRET');
  // In production the pepper is MANDATORY (no silent 'dev-pepper' fallback) and both secrets must be
  // strong. Local/dev/test keep the convenient defaults so the vitest suite and smoke scripts run.
  const pinPepper = isProd ? required('PIN_PEPPER') : (process.env.PIN_PEPPER ?? 'dev-pepper');
  if (isProd) {
    if (WEAK_SECRETS.has(pinPepper)) throw new Error('PIN_PEPPER must be a strong production value, not a dev placeholder');
    if (WEAK_SECRETS.has(hmacSecret) || hmacSecret.length < 32) throw new Error('GATEWAY_HMAC_SECRET must be a strong production value (>=32 chars, not a placeholder)');
  }
  return {
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl: required('DATABASE_URL'),
    hmacSecret,
    env,
    pinPepper,
    otpTtlSeconds: Number(process.env.OTP_TTL_SECONDS ?? 600),
    accessTokenTtlSeconds: Number(process.env.ACCESS_TTL_SECONDS ?? 900),
    refreshTokenTtlSeconds: Number(process.env.REFRESH_TTL_SECONDS ?? 60 * 60 * 24 * 30),
    untimedPracticeInactivityHours: Number(process.env.UNTIMED_INACTIVITY_HOURS ?? 24),
    storageDriver: process.env.STORAGE_DRIVER ?? 'local',
    uploadsDir: process.env.UPLOADS_DIR ?? '.uploads',
    supabaseUrl: (process.env.SUPABASE_URL ?? '').replace(/\/$/, ''),
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    storageBucket: process.env.SUPABASE_STORAGE_BUCKET ?? 'assets',
  };
}
