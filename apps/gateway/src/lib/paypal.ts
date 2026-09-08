import type { Config } from '../config.js';
import type { Tier } from './entitlements.js';

// CCAT Payments — PayPal REST client (Orders v2). Thin fetch wrapper; no SDK dependency. The client id
// + secret are SERVER-ONLY (never a browser bundle). Nothing here runs unless a route has already
// checked cfg.paymentsEnabled and the caller has PayPal configured (routes fail closed otherwise).

export function paypalBase(cfg: Config): string {
  return cfg.paypal.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

export function paypalConfigured(cfg: Config): boolean {
  return !!(cfg.paypal.clientId && cfg.paypal.secret);
}

// Server-owned amount (CAD) per tier. The ONLY source of a charge amount; a client-supplied amount is
// never accepted. Returns '' when unconfigured (caller fails closed).
export function amountForTier(cfg: Config, tier: Tier): string {
  if (tier === 't50') return cfg.paypal.prices.t50;
  if (tier === 't250') return cfg.paypal.prices.t250;
  if (tier === 't500') return cfg.paypal.prices.t500;
  return '';
}

// OAuth2 client-credentials access token. Cached per (base+clientId) until ~60s before expiry.
const tokenCache = new Map<string, { token: string; exp: number }>();
export async function getAccessToken(cfg: Config): Promise<string> {
  if (!paypalConfigured(cfg)) throw new Error('PayPal is not configured');
  const base = paypalBase(cfg);
  const key = `${base}:${cfg.paypal.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.token;
  const basic = Buffer.from(`${cfg.paypal.clientId}:${cfg.paypal.secret}`).toString('base64');
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`PayPal token failed: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  tokenCache.set(key, { token: json.access_token, exp: Date.now() + Math.max(0, (Number(json.expires_in) || 300) - 60) * 1000 });
  return json.access_token;
}

export interface CreatedOrder { id: string; approveUrl: string | null; status: string; }

// Create a one-time CAPTURE order. custom_id carries the guardian key + tier + student so the capture
// and webhook can grant to the right guardian without trusting the client.
export async function createOrder(cfg: Config, args: {
  tier: Tier; amount: string; customId: string; returnUrl: string; cancelUrl: string;
}): Promise<CreatedOrder> {
  const base = paypalBase(cfg);
  const token = await getAccessToken(cfg);
  const res = await fetch(`${base}/v2/checkout/orders`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'CAD', value: args.amount },
        custom_id: args.customId.slice(0, 127),
        description: `CCAT membership (${args.tier})`.slice(0, 127),
      }],
      application_context: {
        brand_name: 'Concept Mastery CCAT',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: args.returnUrl,
        cancel_url: args.cancelUrl,
      },
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.id) throw new Error(`PayPal create order failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  const approve = Array.isArray(json.links) ? json.links.find((l: any) => l.rel === 'approve') : null;
  return { id: json.id, approveUrl: approve?.href ?? null, status: json.status };
}

export interface CaptureResult {
  orderId: string; captureId: string | null; status: string;
  customId: string | null; amount: string | null; currency: string | null; payerEmail: string | null;
}

// Capture an approved order. Returns the capture id + custom_id + amount from the first capture, which
// the grant path uses (idempotency key = captureId).
export async function captureOrder(cfg: Config, orderId: string): Promise<CaptureResult> {
  const base = paypalBase(cfg);
  const token = await getAccessToken(cfg);
  const res = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal capture failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  const pu = json.purchase_units?.[0];
  const cap = pu?.payments?.captures?.[0];
  return {
    orderId: json.id ?? orderId,
    captureId: cap?.id ?? null,
    status: cap?.status ?? json.status ?? 'UNKNOWN',
    customId: cap?.custom_id ?? pu?.custom_id ?? null,
    amount: cap?.amount?.value ?? null,
    currency: cap?.amount?.currency_code ?? null,
    payerEmail: json.payer?.email_address ?? null,
  };
}

// Verify an inbound webhook via PayPal's verify-webhook-signature API (PayPal signs with a cert, not an
// HMAC secret). Returns true only on verification_status === 'SUCCESS'. Fails closed on any error.
export async function verifyWebhook(cfg: Config, headers: Record<string, any>, rawBody: string): Promise<boolean> {
  if (!cfg.paypal.webhookId) return false;
  const base = paypalBase(cfg);
  const h = (k: string) => (headers[k] ?? headers[k.toLowerCase()] ?? '') as string;
  const payload = {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: cfg.paypal.webhookId,
    webhook_event: JSON.parse(rawBody),
  };
  try {
    const token = await getAccessToken(cfg);
    const res = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json: any = await res.json().catch(() => ({}));
    return res.ok && json.verification_status === 'SUCCESS';
  } catch {
    return false;
  }
}

// custom_id format shared by create/capture/webhook: "<guardian_email>|<tier>|<student_id>".
export function encodeCustomId(guardianEmail: string, tier: Tier, studentId: string): string {
  return `${guardianEmail}|${tier}|${studentId}`;
}
export function decodeCustomId(customId: string | null | undefined): { guardianEmail: string; tier: string; studentId: string } | null {
  if (!customId) return null;
  const [guardianEmail, tier, studentId] = customId.split('|');
  if (!guardianEmail || !tier) return null;
  return { guardianEmail: guardianEmail.trim().toLowerCase(), tier, studentId: studentId ?? '' };
}
