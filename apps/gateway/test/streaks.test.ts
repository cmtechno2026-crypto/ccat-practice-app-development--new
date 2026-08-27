import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { bumpStreakAndMilestones, reconcileStreaks, STREAK_MILESTONES } from '../src/lib/streaks.js';

const GRADE5 = 'a0000000-0000-0000-0000-000000000005';
let app: FastifyInstance;
const pool = createPool(loadConfig().databaseUrl);

async function json(method: string, url: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await app.inject({ method: method as any, url, payload: opts.body as any,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) } });
  let parsed: any = null; try { parsed = res.json(); } catch { /* */ }
  return { status: res.statusCode, body: parsed };
}
async function register(username: string): Promise<string> {
  const s = await json('POST', '/v1/registration/contact/start', { body: { guardian_name: 'Guardian', email: `${username}@g.test`, phone: '+14165551234' } });
  const c = await json('POST', '/v1/registration/consent', { body: { registration_grant: s.body.registration_grant, policy_version: 'v1', consent_hash: 'h' } });
  const st = await json('POST', '/v1/registration/student', { body: { registration_grant: c.body.registration_grant, display_name: 'K', username, grade_id: GRADE5, birth_month: 6, birth_year: 2016, pin: '1234', device_hash: `dev-${username}` } });
  expect(st.status).toBe(201);
  return st.body.id;
}
// backdate the streak's last_active_day by N student-local days and force current_streak
async function setStreak(studentId: string, current: number, daysAgo: number) {
  await pool.query(
    `insert into ccat.student_streaks(student_id, current_streak, longest_streak, last_active_day)
     values ($1,$2,$2,(now() at time zone (select timezone from ccat.students where id=$1))::date - $3::int)
     on conflict (student_id) do update set current_streak=$2, longest_streak=greatest(ccat.student_streaks.longest_streak,$2),
       last_active_day=(now() at time zone (select timezone from ccat.students where id=$1))::date - $3::int`,
    [studentId, current, daysAgo],
  );
}

beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); });
afterAll(async () => { await app.close(); await pool.end(); });

describe('daily streaks — Option A (§19)', () => {
  it('starts at 1, is idempotent within a day', async () => {
    const id = await register('strk_a');
    const c = await pool.connect();
    try {
      const first = await bumpStreakAndMilestones(c, id);
      expect(first.current).toBe(1);
      expect(first.longest).toBe(1);
      expect(first.milestone_coins).toBe(0);
      const again = await bumpStreakAndMilestones(c, id); // same day
      expect(again.current).toBe(1); // no double increment
    } finally { c.release(); }
  });

  it('increments on consecutive days and grants milestone coins exactly once', async () => {
    const id = await register('strk_b');
    const c = await pool.connect();
    try {
      // pretend they practised yesterday with a 2-day streak → today should hit 3 (milestone)
      await setStreak(id, 2, 1);
      const coinsBefore = Number((await pool.query('select cached_coin_balance from ccat.students where id=$1', [id])).rows[0].cached_coin_balance);
      const bump = await bumpStreakAndMilestones(c, id);
      expect(bump.current).toBe(3);
      expect(bump.milestone_coins).toBe(STREAK_MILESTONES[3]!); // 10
      const coinsAfter = Number((await pool.query('select cached_coin_balance from ccat.students where id=$1', [id])).rows[0].cached_coin_balance);
      expect(coinsAfter).toBe(coinsBefore + STREAK_MILESTONES[3]!);
      // exactly-once: bumping again same day grants nothing
      const dup = await bumpStreakAndMilestones(c, id);
      expect(dup.current).toBe(3);
      expect(dup.milestone_coins).toBe(0);
      const ledger = await pool.query(`select count(*)::int n from ccat.coin_transactions where student_id=$1 and source_kind='streak_milestone' and source_id='3'`, [id]);
      expect(ledger.rows[0].n).toBe(1);
    } finally { c.release(); }
  });

  it('resets to 1 after a missed day (gap)', async () => {
    const id = await register('strk_c');
    const c = await pool.connect();
    try {
      await setStreak(id, 9, 3); // last practised 3 days ago → gap
      const bump = await bumpStreakAndMilestones(c, id);
      expect(bump.current).toBe(1);       // reset
      expect(bump.longest).toBe(9);       // longest preserved
    } finally { c.release(); }
  });

  it('reconcile zeroes stale streaks', async () => {
    const id = await register('strk_d');
    await setStreak(id, 5, 3); // stale (missed a full day)
    const reset = await reconcileStreaks(pool);
    expect(reset).toBeGreaterThanOrEqual(1);
    const row = await pool.query('select current_streak from ccat.student_streaks where student_id=$1', [id]);
    expect(Number(row.rows[0].current_streak)).toBe(0);
  });
});
