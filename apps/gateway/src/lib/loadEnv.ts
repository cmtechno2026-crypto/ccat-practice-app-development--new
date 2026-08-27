import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Zero-dependency .env loader. Reads KEY=VALUE lines from the first .env found (repo root,
// apps/gateway, or cwd) into process.env WITHOUT overriding vars already set in the environment.
// Works on every Node 20+ version (no reliance on process.loadEnvFile). Safe to call repeatedly.
//
// Why this exists: the Gateway/migrate/seed read configuration from process.env. When launched
// via `pnpm gateway` (or migrate/seed) in a plain terminal, nothing populated those vars from the
// project's .env — so DATABASE_URL came up undefined. This makes `.env` authoritative for local
// runs, matching what DEPLOY-LOCAL.md tells users to create.
export function loadEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../../../.env'), // monorepo root (from apps/gateway/src/lib)
    join(here, '../../.env'),       // apps/gateway/.env
    join(process.cwd(), '.env'),    // current working directory
  ];
  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // not here, try the next candidate
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue; // blank line or comment (# ...)
      const key = m[1];
      let val = m[2] ?? '';
      if (key === undefined) continue;
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    return; // stop at the first .env found
  }
}
