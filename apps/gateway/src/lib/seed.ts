import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { loadEnv } from './loadEnv.js';
import { pgSslConfig } from '../db.js';

// Loads the demo seed (packages/contracts/seed/seed.sql) into DATABASE_URL. Idempotent-ish
// (ON CONFLICT DO NOTHING on catalog rows). DEMO CONTENT ONLY — not production data.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = join(__dirname, '../../../../packages/contracts/seed/seed.sql');

// Returns 'seeded' when the demo data was loaded, 'skipped' when it was already present.
// The guard makes re-running (dev-local.ps1) safe instead of failing on duplicate keys.
export async function runSeed(databaseUrl: string, force = false): Promise<'seeded' | 'skipped'> {
  const sql = readFileSync(SEED, 'utf8');
  // Same TLS handling as the app pool (db.ts) — see pgSslConfig.
  const { connectionString, ssl } = pgSslConfig(databaseUrl);
  const client = new pg.Client({ connectionString, ssl });
  await client.connect();
  try {
    if (!force) {
      // sentinel: the demo super-admin. If present, the seed already ran.
      const seeded = await client.query(
        `select 1 from ccat.admin_profiles where email = 'super@cm.ca' limit 1`,
      ).catch(() => ({ rows: [] as unknown[] }));
      if (seeded.rows.length > 0) return 'skipped';
    }
    await client.query(sql);
    return 'seeded';
  } finally {
    await client.end();
  }
}

// pathToFileURL: Windows-correct direct-invocation check (see migrate.ts for why).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const force = process.argv.includes('--force');
  runSeed(url, force)
    .then((r) => { console.log(r === 'skipped' ? 'Demo data already present — seed skipped (pass --force to reload).' : 'Demo seed applied.'); process.exit(0); })
    .catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
}
