import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { loadEnv } from './loadEnv.js';
import { hashSecret } from '../security/crypto.js';

// Preview ("cheat") accounts — one synthetic student per active grade: username admin_<grade>,
// PIN 2026 (hashed like real PINs), is_preview=true, MAX XP + coins (real ledger rows) so every
// XP/coin gate opens through the normal endpoints. No guardian/consent/PII. Idempotent (re-run safe).
// The PIN is a placeholder: a future admin "generate id/pin per grade" section rotates it by
// re-hashing into student_credentials — no rebuild, this seed just sets the launch default.

const PREVIEW_PIN = '2026';
const PREVIEW_XP = 1_000_000;   // "max" — unlocks every XP-gated cosmetic through the real path
const PREVIEW_COINS = 1_000_000;

export interface PreviewSeedResult { created: string[]; updated: string[] }

export async function runPreviewSeed(databaseUrl: string): Promise<PreviewSeedResult> {
  const pepper = process.env.PIN_PEPPER ?? 'dev-pepper';
  const pinHash = await hashSecret(PREVIEW_PIN, pepper);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const created: string[] = [], updated: string[] = [];
  try {
    const grades = await client.query(
      `select id, grade_number from ccat.grades where active = true and retired_at is null order by grade_number`,
    );
    for (const g of grades.rows) {
      const username = `admin_${g.grade_number}`;
      const displayName = `Preview · Grade ${g.grade_number}`;
      await client.query('begin');
      try {
        // Student (synthetic; is_preview). Upsert by unique username.
        const stu = await client.query(
          `insert into ccat.students
             (username_normalized, display_name, grade_id, birth_month, birth_year, status, is_preview,
              cached_xp_total, cached_coin_balance)
           values ($1,$2,$3,1,2015,'active',true,$4,$5)
           on conflict (username_normalized) do update
             set display_name = excluded.display_name, grade_id = excluded.grade_id,
                 status = 'active', is_preview = true,
                 cached_xp_total = excluded.cached_xp_total, cached_coin_balance = excluded.cached_coin_balance
           returning id, (xmax = 0) as inserted`,
          [username, displayName, g.id, PREVIEW_XP, PREVIEW_COINS],
        );
        const sid = stu.rows[0]!.id as string;
        (stu.rows[0]!.inserted ? created : updated).push(username);

        // Credentials — PIN hashed exactly like a real student's; reset any lockout.
        await client.query(
          `insert into ccat.student_credentials (student_id, pin_hash)
           values ($1,$2)
           on conflict (student_id) do update
             set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null`,
          [sid, pinHash],
        );

        // One shared active device (multi-device waiver is handled in the login guard; this row
        // keeps authenticateStudent's device check satisfied). Ensure exactly one active device.
        const hasActive = await client.query(
          `select 1 from ccat.student_devices where student_id = $1 and status = 'active' limit 1`, [sid],
        );
        if (hasActive.rows.length === 0) {
          await client.query(
            `insert into ccat.student_devices (student_id, device_hash, platform, status, enrolled_at)
             values ($1,$2,'web','active',now())`,
            [sid, `preview-shared-${g.grade_number}`],
          );
        }

        // MAX XP + coins as REAL, clearly-labeled ledger rows (idempotent via source uniqueness).
        await client.query(
          `insert into ccat.xp_transactions (student_id, delta, source_kind, source_id, reason)
           values ($1,$2,'admin_adjustment','preview_seed','preview cheat account grant')
           on conflict (student_id, source_kind, source_id) do nothing`,
          [sid, PREVIEW_XP],
        );
        await client.query(
          `insert into ccat.coin_transactions (student_id, delta, source_kind, source_id, reason)
           values ($1,$2,'admin_adjustment','preview_seed','preview cheat account grant')
           on conflict (student_id, source_kind, source_id) do nothing`,
          [sid, PREVIEW_COINS],
        );
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
    }
    return { created, updated };
  } finally {
    await client.end();
  }
}

// pathToFileURL: Windows-correct direct-invocation check (see migrate.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  runPreviewSeed(url)
    .then((r) => { console.log(`Preview accounts ready. created: [${r.created.join(', ')}] updated: [${r.updated.join(', ')}] (PIN 2026)`); process.exit(0); })
    .catch((e) => { console.error('Preview seed failed:', e.message); process.exit(1); });
}
