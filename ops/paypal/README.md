# PayPal payments — setup & test (sandbox first)

In-app PayPal checkout, mirroring the old Stripe flow. The web "My Plan" Upgrade buttons create a PayPal
order on the gateway, redirect the buyer to PayPal, and on return the gateway captures the order and grants
the tier. A `PAYMENT.CAPTURE.COMPLETED` webhook is the idempotent backstop (both paths key on the PayPal
capture id, so a tier is granted exactly once). All behind `PAYMENTS_ENABLED` / `VITE_PAYMENTS_ENABLED`.

## Gateway env (Render) — sandbox
```
PAYMENTS_ENABLED=true
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=<sandbox client id>
PAYPAL_SECRET=<sandbox secret>
PAYPAL_WEBHOOK_ID=<from the webhook you create, below>
PAYPAL_PRICE_T50=50.00
PAYPAL_PRICE_T250=250.00
PAYPAL_PRICE_T500=500.00
WEB_APP_ORIGIN=https://ccat.conceptmastery.com   # used for the PayPal return/cancel URLs
```
Web/admin (Vercel): `VITE_PAYMENTS_ENABLED=true`.

## Webhook (PayPal developer dashboard → your sandbox app → Webhooks)
- URL: `https://ccat-gateway-payment.onrender.com/v1/webhooks/paypal`  (the GATEWAY, not the web domain)
- Event to subscribe: **PAYMENT.CAPTURE.COMPLETED** (CHECKOUT.ORDER.APPROVED optional).
- Copy the generated **Webhook ID** into `PAYPAL_WEBHOOK_ID`, redeploy the gateway.

## DB
Apply `packages/contracts/migrations/0044_paypal_payment_events.sql` (idempotency ledger) to prod before
deploying the gateway with PayPal enabled — same as the other migrations, via Supabase.

## Sandbox test
1. As a student whose guardian has an email, open My Plan → Upgrade to $50.
2. Approve with the sandbox buyer account at PayPal.
3. On return, the plan unlocks (capture grants; the poll confirms). Verify:
   - `select tier, grant_reason, source from ccat.entitlements where lower(guardian_email)=lower('<guardian>')` → t50 / paid / webhook.
   - one row in `ccat.paypal_payment_events`.
4. Re-deliver the webhook from the PayPal dashboard → gateway returns `{outcome:"deduped"}` (no double grant).

## Trust model (same as Stripe)
Student authenticated; guardian resolved from the session. Tier validated server-side (sellable, strictly
higher than current). Amount comes from the server tier→amount map (CAD) — the client sends only a tier.
Webhook verified via PayPal's verify-webhook-signature API using `PAYPAL_WEBHOOK_ID`. A paid entitlement is
written only by the shared grant helper, idempotent on the capture id, and cross-checks the captured amount
against the tier price. `grant_reason='paid'` overrides any prior comp/sale grant.
