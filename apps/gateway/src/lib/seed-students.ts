import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { loadEnv } from './loadEnv.js';

// Loads packages/contracts/seed/demo-students.sql (DEV ONLY): ~60 demo students with readiness,
// progress, devices and guardians so the admin Students directory can be exercised locally.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = join(__dirname, '../../../../packages/contracts/seed/demo-students.sql');

export async function runStudentSeed(databaseUrl: string): Promise<void> {
  const sql = readFileSync(SQL, 'utf8');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  runStudentSeed(url).then(() => { console.log('Demo students seeded.'); process.exit(0); })
    .catch((e) => { console.error('Student seed failed:', e.message); process.exit(1); });
}
