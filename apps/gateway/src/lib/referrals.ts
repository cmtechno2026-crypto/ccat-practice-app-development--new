import type { Client } from '../db.js';

// Referral reward ladder: coins granted to the REFERRER as their count of successful referrals
// reaches each rung. Granted exactly-once via the coin ledger's unique (student_id, source_kind,
// source_id) — source_kind='referral', source_id = the rung's referral count.
export const REFERRAL_MILESTONES: Record<number, number> = { 1: 20, 3: 60, 5: 120, 10: 300 };

// Opaque, human-typable invite code (no PII). Ambiguous chars (0/O, 1/I) removed.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function codeFromBytes(bytes: Uint8Array, len = 7): string {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

// After a redemption is inserted, grant the referrer the milestone bonus for their NEW total, if the
// new total is a ladder rung. Idempotent: the coin ledger unique key blocks a double grant.
export async function grantReferralMilestone(client: Client, referrerId: string): Promise<number> {
  const c = await client.query('select count(*)::int as n from ccat.referral_redemptions where referrer_student_id=$1', [referrerId]);
  const count = c.rows[0]!.n as number;
  const coins = REFERRAL_MILESTONES[count];
  if (!coins) return 0;
  const ins = await client.query(
    `insert into ccat.coin_transactions (student_id, delta, source_kind, source_id, reason)
     values ($1, $2, 'referral', $3, $4)
     on conflict (student_id, source_kind, source_id) do nothing
     returning id`,
    [referrerId, coins, String(count), count === 1 ? 'First friend invited' : `${count} friends invited`],
  );
  if (ins.rows.length === 0) return 0;
  await client.query('update ccat.students set cached_coin_balance = cached_coin_balance + $2 where id=$1', [referrerId, coins]);
  return coins;
}
