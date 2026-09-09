import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config.js';

// Single outbound-email helper for the gateway. Two delivery paths:
//   1. HTTPS API (ZeptoMail-compatible) when EMAIL_API_KEY is set — REQUIRED on hosts that block outbound
//      SMTP ports (Render times out on 465 AND 587). Sends over 443, which is never blocked.
//   2. SMTP via nodemailer (EMAIL_HOST/PORT/USER/PASS) otherwise.
// Secrets are gateway-only (never a browser bundle). When neither is configured this is a LOGGING NO-OP.
// sendEmail NEVER throws — on missing config or a send error it logs and returns false, so callers treat
// every email as fire-and-forget and never fail the main request because a send failed.

let cached: Transporter | null = null;
let cachedKey = '';

function transporterFor(e: Config['email']): Transporter | null {
  if (!e.host) return null;
  const key = `${e.host}:${e.port}:${e.user}`;
  if (cached && cachedKey === key) return cached;
  cached = nodemailer.createTransport({
    host: e.host,
    port: e.port,
    secure: e.port === 465,                       // implicit TLS on 465; STARTTLS on 587/25
    auth: e.user ? { user: e.user, pass: e.pass } : undefined,
    connectionTimeout: 10000, // fail fast instead of hanging the whole request when SMTP will not connect
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  cachedKey = key;
  return cached;
}

// True when email is configured enough to actually send (an API key OR an SMTP host, plus a usable From).
// Callers that must NOT claim success on a silent no-op (e.g. OTP delivery) check this up front.
export function emailConfigured(cfg: Config): boolean {
  const e = cfg.email;
  return !!((e.apiKey || e.host) && (e.from || e.user));
}

export interface EmailMessage { to: string; subject: string; html: string; text?: string; }
interface MiniLog { info?: (...a: any[]) => void; warn?: (...a: any[]) => void }

// Returns true only on a successful send; false on no-op (unconfigured) or failure. Never throws.
// Only `to` + `subject` are ever logged — never the body — so OTP codes never reach the logs.
export async function sendEmail(cfg: Config, msg: EmailMessage, log?: MiniLog): Promise<boolean> {
  const from = cfg.email.from || cfg.email.user;
  if (!from || !msg.to) {
    log?.info?.({ to: msg.to, subject: msg.subject }, 'email skipped (not configured)');
    return false;
  }
  // Prefer the HTTPS API when a key is set (works where the platform blocks outbound SMTP, e.g. Render).
  if (cfg.email.apiKey) return sendViaApi(cfg, from, msg, log);

  const t = transporterFor(cfg.email);
  if (!t) { log?.info?.({ to: msg.to, subject: msg.subject }, 'email skipped (SMTP not configured)'); return false; }
  try {
    await t.sendMail({ from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text ?? htmlToText(msg.html) });
    log?.info?.({ to: msg.to, subject: msg.subject }, 'email sent');
    return true;
  } catch (e) {
    log?.warn?.({ err: (e as Error).message, subject: msg.subject }, 'email send failed');
    return false;
  }
}

// ZeptoMail-compatible HTTPS send (POST JSON, "Zoho-enczapikey" auth). Bounded by a 15s abort so it can
// never hang the request. EMAIL_API_URL selects the region endpoint (default US: api.zeptomail.com).
async function sendViaApi(cfg: Config, from: string, msg: EmailMessage, log?: MiniLog): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const raw = cfg.email.apiKey.trim();
    const auth = /^zoho-enczapikey/i.test(raw) ? raw : `Zoho-enczapikey ${raw}`;
    const addr = extractAddress(from);
    const name = extractName(from);
    const res = await fetch(cfg.email.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: auth },
      body: JSON.stringify({
        from: name ? { address: addr, name } : { address: addr },
        to: [{ email_address: { address: msg.to } }],
        subject: msg.subject,
        htmlbody: msg.html,
        textbody: msg.text ?? htmlToText(msg.html),
      }),
      signal: ctrl.signal,
    });
    if (res.ok) { log?.info?.({ to: msg.to, subject: msg.subject }, 'email sent (api)'); return true; }
    const body = await res.text().catch(() => '');
    log?.warn?.({ status: res.status, subject: msg.subject, body: body.slice(0, 300) }, 'email send failed (api)');
    return false;
  } catch (e) {
    log?.warn?.({ err: (e as Error).message, subject: msg.subject }, 'email send failed (api)');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function extractAddress(from: string): string { const m = from.match(/<([^>]+)>/); return (m ? m[1]! : from).trim(); }
function extractName(from: string): string | undefined { const m = from.match(/^\s*"?([^"<]+?)"?\s*</); return m ? m[1]!.trim() : undefined; }

// Minimal HTML→text fallback for the plain-text part when a caller doesn't supply one.
function htmlToText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
