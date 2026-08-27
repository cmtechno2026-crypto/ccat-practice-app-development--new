import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { loadEnv } from './loadEnv.js';

// Loads packages/contracts/seed/demo-content.sql (DEV ONLY): the mockup's category tree with
// question sets across grades 3-6 and all difficulties, so the admin Content browser is populated.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(__dirname, '../../../../packages/contracts/seed');
// demo-content: the mockup category tree; exam-paper: a real 3-battery exam for Grade 5.
const FILES = ['demo-content.sql', 'exam-paper.sql'];

export async function runContentSeed(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const f of FILES) await client.query(readFileSync(join(SEED_DIR, f), 'utf8'));
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  runContentSeed(url).then(() => { console.log('Demo content seeded.'); process.exit(0); })
    .catch((e) => { console.error('Content seed failed:', e.message); process.exit(1); });
}
