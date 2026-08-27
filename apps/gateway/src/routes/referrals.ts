import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import { Errors } from '../errors.js';
import { REFERRAL_MILESTONES, codeFromBytes } from '../lib/referrals.js';

// Gate 2B: referrals. GET returns the learner's own invite code (lazily created), how many friends
// have joined, and the coin reward ladder with reached state. The client builds the shareable URL
// from its own origin (`/register?ref=CODE`) — the gateway stays client-agnostic and returns the
// code + relative path, not a hard-coded web URL.

async function ensureCode(db: DB, studentId: string): Promise<string> {
  const existing = await db.query('select code from ccat.referral_codes where student_id=$1', [studentId]);
  if (existing.rows.length > 0) return existing.rows[0]!.code as string;
  for (let i = 0; i < 6; i++) {
    const code = codeFromBytes(randomBytes(7));
    const ins = await db.query(
      `insert into ccat.referral_codes(student_id, code) values ($1,$2)
       on conflict (student_id) do nothing returning code`,
      [studentId, code],
    );
    if (ins.rows.length > 0) return ins.rows[0]!.code as string;
    // student_id conflict → someone/we already made one; re-read.
    const reread = await db.query('select code from ccat.referral_codes where student_id=$1', [studentId]);
    if (reread.rows.length > 0) return reread.rows[0]!.code as string;
    // else code collided on the unique(code) index → try a new code.
  }
  throw new Error('Could not allocate a referral code');
}

export function registerReferralRoutes(app: FastifyInstance, db: DB) {
  // GET /v1/referrals — the learner's invite code, join count, and the reward ladder.
  app.get('/v1/referrals', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    const code = await ensureCode(db, sid);
    const cnt = await db.query('select count(*)::int as n from ccat.referral_redemptions where referrer_student_id=$1', [sid]);
    const joined = cnt.rows[0]!.n as number;
    // Which milestone rungs were actually paid out (exactly-once source_id = the referral count).
    const granted = await db.query(
      `select source_id from ccat.coin_transactions where student_id=$1 and source_kind='referral'`, [sid]);
    const grantedCounts = new Set(granted.rows.map((r) => String(r.source_id)));
    const ladder = Object.entries(REFERRAL_MILESTONES)
      .map(([n, coins]) => ({ friends: Number(n), coins: Number(coins) }))
      .sort((a, b) => a.friends - b.friends)
      .map((rung) => ({ ...rung, reached: grantedCounts.has(String(rung.friends)) || joined >= rung.friends }));
    const next = ladder.find((r) => !r.reached) ?? null;
    return {
      code,
      share_path: `/register?ref=${code}`,
      joined,
      ladder,
      next: next ? { friends: next.friends, coins: next.coins, to_go: Math.max(0, next.friends - joined) } : null,
    };
  });

  // POST /v1/referrals/rotate — issue a fresh code (invalidates the old one). Kept minimal; the old
  // code simply stops resolving because the row is replaced.
  app.post('/v1/referrals/rotate', { preHandler: [app.authenticateStudent] }, async (req) => {
    const sid = req.student!.studentId;
    for (let i = 0; i < 6; i++) {
      const code = codeFromBytes(randomBytes(7));
      try {
        await db.query('update ccat.referral_codes set code=$2 where student_id=$1', [sid, code]);
        const exists = await db.query('select 1 from ccat.referral_codes where student_id=$1', [sid]);
        if (exists.rows.length === 0) { await db.query('insert into ccat.referral_codes(student_id, code) values ($1,$2)', [sid, code]); }
        return { code };
      } catch { /* unique(code) collision — retry */ }
    }
    throw Errors.conflict('CODE_ALLOC', 'Could not allocate a new code');
  });
}
