import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { SELLABLE_TIERS, tierRank, tierUnlocksText, TIER_LABELS, type Tier } from './entitlements.js';
import { amountForTier } from './paypal.js';
import { sendEmail } from './email.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

interface MiniLog { info?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void }

export type GrantOutcome = 'granted' | 'deduped' | 'ignored' | 'amount_mismatch';

// The ONE place a PayPal-paid entitlement is written. Called by BOTH the return-time capture endpoint and
// the PAYMENT.CAPTURE.COMPLETED webhook — keyed on the SAME PayPal capture id, so the grant happens
// exactly once regardless of which path arrives first (or if both do). Mirrors the Stripe webhook grant:
// grant_reason='paid' (overrides any prior comp/sale/etc.), 1-year plan -> active, expires 1 year from
// purchase (current_period_end = now + 1 year); a later re-purchase resets a fresh year. Audited.
export async function grantPaidEntitlementPaypal(
  // Only needs a queryable (Pool in prod, a Client in tests / a tx handle) — not the full Pool surface.
  db: Pick<DB, 'query'>,
  cfg: Config,
  args: { captureId: string; orderId: string; tier: string; guardianEmail: string; amount: string | null; eventType: string; log?: MiniLog },
): Promise<GrantOutcome> {
  const tier = args.tier as Tier;
  const guardianEmail = (args.guardianEmail ?? '').trim().toLowerCase();
  if (!SELLABLE_TIERS.includes(tier) || !guardianEmail || !args.captureId) {
    args.log?.warn?.({ tier, hasEmail: !!guardianEmail, captureId: args.captureId }, 'paypal grant: unresolvable');
    return 'ignored';
  }

  // Defence in depth: the captured amount must match the server-owned price for the tier.
  const expected = amountForTier(cfg, tier);
  if (args.amount != null && expected && Number(args.amount) !== Number(expected)) {
    args.log?.error?.({ tier, paid: args.amount, expected }, 'paypal grant: amount/tier mismatch — refusing');
    return 'amount_mismatch';
  }

  // Idempotency: capture id recorded => already granted (via the other path or a redelivery).
  const seen = await db.query('select 1 from ccat.paypal_payment_events where capture_id = $1', [args.captureId]);
  if (seen.rowCount && seen.rowCount > 0) return 'deduped';

  const gc = await db.query('select id, name from ccat.guardian_contacts where lower(email::text) = $1 limit 1', [guardianEmail]);
  const guardianId = gc.rows[0]?.id ?? null;
  const guardianName = gc.rows[0]?.name ?? '';
  const prev = await db.query(
    'select tier, status, current_period_end from ccat.entitlements where lower(guardian_email) = $1 limit 1',
    [guardianEmail],
  );

  const up = await db.query(
    `insert into ccat.entitlements (guardian_email, guardian_id, tier, status, current_period_end, source, external_ref, grant_reason)
     values ($1, $2, $3, 'active', now() + interval '1 year', 'webhook', $4, 'paid')
     on conflict (lower(guardian_email)) do update
       set tier = excluded.tier,
           status = 'active',
           current_period_end = now() + interval '1 year',
           guardian_id = coalesce(excluded.guardian_id, ccat.entitlements.guardian_id),
           source = 'webhook',
           external_ref = excluded.external_ref,
           grant_reason = 'paid',
           updated_at = now()
     returning id`,
    [guardianEmail, guardianId, tier, args.captureId],
  );

  try {
    await db.query(
      `insert into ccat.audit_log(actor_admin_id, actor_kind, event_type, target_kind, target_id, old_value, new_value, reference)
       values (null, 'system', 'entitlement.changed', 'entitlement', $1, $2, $3, $4)`,
      [up.rows[0]!.id, JSON.stringify(prev.rows[0] ?? null),
       JSON.stringify({ guardian_email: guardianEmail, tier, source: 'paypal', capture_id: args.captureId }), args.orderId],
    );
  } catch (err) { args.log?.warn?.({ err: (err as Error).message }, 'paypal grant: audit insert failed (grant applied)'); }

  // Record the capture id LAST so a crash before this simply reprocesses the same (idempotent) grant.
  await db.query(
    'insert into ccat.paypal_payment_events (capture_id, event_type, order_id) values ($1, $2, $3) on conflict (capture_id) do nothing',
    [args.captureId, args.eventType, args.orderId],
  );

  // Confirmation email (fire-and-forget; never affects the grant). Two shapes, chosen by whether the
  // guardian already has an account:
  //  • NO account yet  → landing-page Case 2 (paid before signing up): send the "create your account with
  //    this email to use your plan" instructions. The plan is already reserved against this email.
  //  • account exists  → Case 1 / in-app upgrade: send the existing "plan is active" email on a real upgrade.
  const label = TIER_LABELS[tier] ?? tier;
  const acct = await db.query(
    `select 1 from ccat.guardian_contacts gc
       join ccat.student_guardians sg on sg.guardian_id = gc.id
       join ccat.students s on s.id = sg.student_id
      where lower(gc.email::text) = $1 and s.status <> 'purged' limit 1`,
    [guardianEmail],
  );
  const accountExists = acct.rows.length > 0;

  if (!accountExists) {
    const amt = args.amount ?? amountForTier(cfg, tier);
    const createUrl = cfg.webAppOrigin ? `${cfg.webAppOrigin}/register` : '';
    const button = createUrl
      ? `<p style="margin:20px 0"><a href="${createUrl}" style="display:inline-block;background:#1A5EAB;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:10px">Create your account →</a></p>`
      : '';
    const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:15px;color:#1f2340;line-height:1.55">
      <h2 style="color:#1A5EAB;margin:0 0 8px">Payment received — 2 steps to start practising</h2>
      <p>Hello,</p>
      <p>Your payment of <strong>${amt ? `${amt} CAD` : 'your plan'}</strong> for the <strong>${label}</strong> plan is confirmed and held for <strong>${escapeHtml(guardianEmail)}</strong>.</p>
      <p>Here's how to get started:</p>
      <p style="margin:0 0 4px"><strong>1.</strong> Create your CCAT Practice account using this email address — <strong>${escapeHtml(guardianEmail)}</strong>.</p>
      <p style="margin:0 0 4px"><strong>2.</strong> Sign in. Your ${label} plan will already be active on the account.</p>
      <p>That's it — your plan is attached to this email, so there is nothing else to pay and your access won't be lost.</p>
      ${button}
      <p>If you have any questions, simply reply to this email or contact us at <a href="mailto:info@conceptmastery.com" style="color:#1A5EAB">info@conceptmastery.com</a>.</p>
      <p style="color:#8a90a6;font-size:13px">— Concept Mastery · CCAT Practice</p>
    </div>`;
    void sendEmail(cfg, { to: guardianEmail, subject: 'Payment received — 2 steps to start practising', html }, args.log as any);
  } else {
    const pr = prev.rows[0];
    const prevActive = pr && pr.status === 'active' && (pr.current_period_end == null || new Date(pr.current_period_end) > new Date());
    const prevRank = prevActive ? tierRank(pr.tier as Tier) : 0;
    if (tierRank(tier) > prevRank) {
      const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:15px;color:#1f2340">
        <h2 style="color:#5b3ff0;margin:0 0 8px">Your CCAT Practice plan is active</h2>
        <p>Hello ${escapeHtml(guardianName || 'there')},</p>
        <p>Your payment has been confirmed, and the <strong>${label}</strong> plan is now active on your CCAT Practice account.</p>
        <p>Your plan includes:</p>
        <p>${tierUnlocksText(tier)}</p>
        <p>You can sign in and begin using these features immediately.</p>
        <p style="color:#8a90a6;font-size:13px">— Concept Mastery · CCAT Practice</p>
      </div>`;
      void sendEmail(cfg, { to: guardianEmail, subject: 'Your CCAT Practice plan is active', html }, args.log as any);
    }
  }

  return 'granted';
}
