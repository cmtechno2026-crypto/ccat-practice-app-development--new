import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { SELLABLE_TIERS, tierRank, tierUnlocksText, TIER_LABELS, type Tier } from './entitlements.js';
import { amountForTier } from './paypal.js';
import { withHst, HST_RATE } from './tax.js';
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
  args: { captureId: string; orderId: string; tier: string; guardianEmail: string; amount: string | null; expectedAmount?: string | null; eventType: string; log?: MiniLog },
): Promise<GrantOutcome> {
  const tier = args.tier as Tier;
  const guardianEmail = (args.guardianEmail ?? '').trim().toLowerCase();
  if (!SELLABLE_TIERS.includes(tier) || !guardianEmail || !args.captureId) {
    args.log?.warn?.({ tier, hasEmail: !!guardianEmail, captureId: args.captureId }, 'paypal grant: unresolvable');
    return 'ignored';
  }

  // Defence in depth: the captured amount must match what this order was created to charge. Every charge is
  // the (promo-discounted) subtotal PLUS 13% HST, so `expected` here is TAX-INCLUSIVE. The order stamps the
  // exact tax-inclusive total into custom_id (args.expectedAmount) — validating against the ORDER's own
  // amount, not a recomputed live promo which may have ended before capture/webhook arrived. The stamp is
  // trusted only when its implied pre-tax subtotal (stamp / 1.13) falls within the allowed discount band
  // [10%..100%] of the base (promo percent is capped at 90); a malformed or out-of-band stamp falls back to
  // the full base price + HST rather than being honoured. Legacy orders (no 4th custom_id segment) pass
  // expectedAmount=null and validate against base + HST.
  const base = amountForTier(cfg, tier);
  let expected = withHst(base).total;
  if (args.expectedAmount != null && args.expectedAmount !== '') {
    const stamped = Number(args.expectedAmount);
    const b = Number(base);
    const impliedSubtotal = stamped / (1 + HST_RATE);
    if (Number.isFinite(stamped) && b > 0 && impliedSubtotal >= b * 0.10 - 0.005 && impliedSubtotal <= b + 0.005) {
      expected = args.expectedAmount;
    } else {
      args.log?.warn?.({ tier, stamped: args.expectedAmount, base }, 'paypal grant: stamped amount out of band — using base + HST');
    }
  }
  if (args.amount != null && expected && Math.abs(Number(args.amount) - Number(expected)) > 0.005) {
    args.log?.error?.({ tier, paid: args.amount, expected }, 'paypal grant: amount/tier mismatch — refusing');
    return 'amount_mismatch';
  }

  // Idempotency: capture id recorded => already granted (via the other path or a redelivery).
  const seen = await db.query('select 1 from ccat.paypal_payment_events where capture_id = $1', [args.captureId]);
  if (seen.rowCount && seen.rowCount > 0) return 'deduped';

  const gc = await db.query('select id, name, phone from ccat.guardian_contacts where lower(email::text) = $1 limit 1', [guardianEmail]);
  const guardianId = gc.rows[0]?.id ?? null;
  const guardianName = gc.rows[0]?.name ?? '';
  const guardianPhone = gc.rows[0]?.phone ?? '';
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

  // Plan-active confirmation email on a real upgrade only. Fire-and-forget; never affects the grant.
  const pr = prev.rows[0];
  const prevActive = pr && pr.status === 'active' && (pr.current_period_end == null || new Date(pr.current_period_end) > new Date());
  const prevRank = prevActive ? tierRank(pr.tier as Tier) : 0;
  if (tierRank(tier) > prevRank) {
    const label = TIER_LABELS[tier] ?? tier;
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

  // Admin purchase notification (fire-and-forget; never affects the grant). Sent on every confirmed
  // purchase with the family + plan details. Recipients from ADMIN_NOTIFY_EMAILS (comma-separated) or the
  // two Concept Mastery admin addresses by default.
  try {
    const label = TIER_LABELS[tier] ?? tier;
    const amt = args.amount ?? expected ?? '';
    let students = 'No account yet — parent paid before signing up.';
    {
      const stu = await db.query(
        `select s.display_name, g.grade_number, g.name as grade_name
           from ccat.student_guardians sg
           join ccat.students s on s.id = sg.student_id and s.status <> 'purged'
           join ccat.guardian_contacts gc2 on gc2.id = sg.guardian_id
           left join ccat.grades g on g.id = s.grade_id
          where lower(gc2.email::text) = $1
          order by sg.is_primary desc, s.display_name`,
        [guardianEmail],
      );
      if (stu.rows.length > 0) {
        students = stu.rows.map((r: any) => {
          const grade = r.grade_name || (r.grade_number != null ? `Grade ${r.grade_number}` : '—');
          return `${escapeHtml(r.display_name || '—')} (${escapeHtml(grade)})`;
        }).join(', ');
      }
    }
    const cell = 'padding:5px 12px;border:1px solid #e7eaf3';
    const rowsHtml = ([
      ['Plan', `${escapeHtml(label)}${amt ? ` (${escapeHtml(String(amt))} CAD)` : ''}`],
      ['Student(s) &amp; grade', students],
      ['Parent name', escapeHtml(guardianName || '—')],
      ['Parent email', escapeHtml(guardianEmail)],
      ['Parent phone', escapeHtml(guardianPhone || '—')],
      ['PayPal capture id', escapeHtml(args.captureId)],
    ] as [string, string][]).map(([k, v]) => `<tr><td style="${cell};font-weight:600">${k}</td><td style="${cell}">${v}</td></tr>`).join('');
    const adminHtml = `<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:15px;color:#1f2340">
      <h2 style="color:#5b3ff0;margin:0 0 8px">New CCAT plan purchase — ${escapeHtml(label)}</h2>
      <table style="border-collapse:collapse;margin:8px 0">${rowsHtml}</table>
      <p style="color:#8a90a6;font-size:13px">— CCAT Practice (automated admin notification)</p>
    </div>`;
    const admins = (process.env.ADMIN_NOTIFY_EMAILS || 'cmtechno2026@gmail.com,admin@conceptmastery.ca')
      .split(',').map((e) => e.trim()).filter(Boolean);
    for (const to of admins) {
      void sendEmail(cfg, { to, subject: `New purchase: ${label} — ${guardianName || guardianEmail}`, html: adminHtml }, args.log as any);
    }
  } catch (err) { args.log?.warn?.({ err: (err as Error).message }, 'admin purchase notification failed'); }

  return 'granted';
}
