import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { SupabaseAdminDirectory } from '../src/services/adminAuth.js';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const email = argument('email')?.trim().toLowerCase();
if (!email) {
  throw new Error('Usage: pnpm --filter @ccat/gateway provision:admin-auth -- --email=admin@example.com');
}

const cfg = loadConfig();
if (cfg.env !== 'production' && cfg.env !== 'staging') {
  throw new Error('Admin Auth provisioning is allowed only with NODE_ENV=staging or production');
}

const db = createPool(cfg.databaseUrl);
try {
  const result = await db.query(
    `select id, email, status from ccat.admin_profiles
      where email=$1 and status in ('active','disabled')`,
    [email],
  );
  if (result.rows.length === 0) throw new Error(`No active/disabled admin profile found for ${email}`);
  const profile = result.rows[0]!;
  const temporaryPassword = randomBytes(18).toString('base64url');
  const directory = new SupabaseAdminDirectory(cfg);
  // Persist the restriction before creating the external identity. A provider or network failure
  // therefore cannot leave an existing profile eligible for unrestricted login.
  await db.query(
    'update ccat.admin_profiles set mfa_enrolled=false, must_change_password=true where id=$1',
    [profile.id],
  );
  await directory.createUser(profile.id, profile.email, temporaryPassword);
  if (profile.status === 'disabled') await directory.setDisabled(profile.id, true);
  process.stdout.write(JSON.stringify({
    provisioned: true,
    admin_id: profile.id,
    email: profile.email,
    temporary_password: temporaryPassword,
    next: 'Share the temporary password through an approved secure channel. First login requires TOTP enrollment and password change.',
  }, null, 2) + '\n');
} finally {
  await db.end();
}
