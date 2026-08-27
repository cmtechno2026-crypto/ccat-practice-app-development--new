import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { loadEnv } from './loadEnv.js';
import { pgSslConfig } from '../db.js';

// Minimal ordered migration runner. In production, prefer `supabase db push` / the Supabase
// MCP apply_migration; this exists for local dev/test parity (Blueprint §38).
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../../../packages/contracts/migrations');

export interface MigrateResult { applied: string[]; skipped: string[]; backfilled: boolean }

// Idempotent, ordered migration runner. Records applied files in public.ccat_schema_migrations
// so re-running (e.g. dev-local.ps1 on an already-set-up DB) is a clean no-op instead of erroring
// with "type ... already exists". Each new migration runs in its own transaction.
export async function runMigrations(databaseUrl: string): Promise<MigrateResult> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort();
  // TLS parity with apps/gateway/src/db.ts. Supabase's pooler REQUIRES SSL but presents a cert chain
  // Node has no bundled root for. CRUCIAL: node-postgres parses the connectionString and merges its
  // `sslmode` OVER an explicit `ssl` config object, so a `sslmode=require` in DATABASE_URL (now
  // escalated to verify-full) wins and rejects the chain with "self-signed certificate in certificate
  // chain" — even when we pass `ssl` below. So we STRIP sslmode/ssl from the DSN and let our explicit
  // ssl object be authoritative. TLS stays ON (encrypted); flip PGSSL_REJECT_UNAUTHORIZED=true once
  // the Supabase CA is pinned in the deploy image. Localhost keeps ssl=undefined (plaintext dev).
  const { connectionString, ssl } = pgSslConfig(databaseUrl);
  const client = new pg.Client({ connectionString, ssl });
  await client.connect();
  const applied: string[] = [], skipped: string[] = [];
  let backfilled = false;
  try {
    await client.query(
      `create table if not exists public.ccat_schema_migrations (
         filename text primary key, applied_at timestamptz not null default now())`,
    );
    const done = new Set<string>(
      (await client.query('select filename from public.ccat_schema_migrations')).rows.map((r) => r.filename),
    );

    // Upgrade path: a DB migrated before this tracking table existed. If the ccat schema is already
    // present but nothing is tracked, treat every current migration as already applied (backfill),
    // so we don't try to re-run 0000 against existing objects.
    if (done.size === 0) {
      const exists = await client.query(
        `select 1 from information_schema.schemata where schema_name = 'ccat'`,
      );
      if (exists.rows.length > 0) {
        for (const f of files) {
          await client.query('insert into public.ccat_schema_migrations(filename) values ($1) on conflict do nothing', [f]);
          skipped.push(f);
        }
        return { applied: [], skipped, backfilled: true };
      }
    }

    for (const f of files) {
      if (done.has(f)) { skipped.push(f); continue; }
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into public.ccat_schema_migrations(filename) values ($1)', [f]);
        await client.query('commit');
        applied.push(f);
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
    }
  } finally {
    await client.end();
  }
  return { applied, skipped, backfilled };
}

// CLI entry. pathToFileURL makes this comparison correct on Windows too — `file://${argv[1]}`
// produced `file://D:\...` which never matched Node's `file:///D:/...`, so this block silently
// never ran on Windows and migrations appeared to succeed while doing nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  runMigrations(url)
    .then((r) => {
      if (r.backfilled) console.log(`Database already migrated — recorded ${r.skipped.length} existing migrations, nothing to apply.`);
      else if (r.applied.length === 0) console.log(`Already up to date — ${r.skipped.length} migrations, nothing new to apply.`);
      else console.log(`Applied ${r.applied.length} migration(s): ${r.applied.join(', ')}${r.skipped.length ? ` (skipped ${r.skipped.length} already applied)` : ''}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error('Migration failed:', e.message);
      process.exit(1);
    });
}
