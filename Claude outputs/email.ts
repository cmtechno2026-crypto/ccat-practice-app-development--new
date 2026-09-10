import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config.js';

// Single outbound-email helper for the gateway. Two transports:
//   1. HTTPS API (ZeptoMail Email Sending API, port 443) — used when an API URL is configured or can be
//      derived from a ZeptoMail SMTP host. REQUIRED on hosts that block outbound SMTP ports (e.g. Render's
//      free tier drops 25/465/587 → SMTP connection timeouts).
//   2. SMTP via nodemailer — the fallback for any other provider.
// Secrets are gateway-only (never a browser bundle). When neither transport is configured this is a LOGGING
// NO-OP so dev/prod without email set up never crashes. sendEmail NEVER throws — on missing config or a
// send error it logs and returns false, so callers treat every email as fire-and-forget. Callers that must
// NOT claim success on a silent no-op (OTP delivery) check emailConfigured() up front AND treat a false
// return as a hard failure.

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
  });
  cachedKey = key;
  return cached;
}

// Resolve the ZeptoMail Email Sending API URL: explicit EMAIL_API_URL wins; otherwise derive it from a
// ZeptoMail SMTP host so the same env that names smtp.zeptomail.in also enables the API on api.zeptomail.in
// (the API base must match the account's data center). Returns '' when no API transport applies.
export function emailApiUrl(e: Config['email']): string {
  if (e.apiUrl) return e.apiUrl;
  const m = /^smtp\.(zeptomail\.[a-z.]+)$/i.exec(e.host || '');
  return m && m[1] ? `https://api.${m[1]}/v1.1/email` : '';
}

// True when email is configured enough to actually send (via either transport).
export function emailConfigured(cfg: Config): boolean {
  const e = cfg.email;
  const from = e.from || e.user;
  if (emailApiUrl(e)) return !!(from && e.pass);   // API needs URL + a send token + a From
  return !!(e.host && from);                        // SMTP needs a host + a From
}

export interface EmailMessage { to: string; subject: string; html: string; text?: string; }
interface MiniLog { info?: (...a: any[]) => void; warn?: (...a: any[]) => void }

// Parse EMAIL_FROM ("Name <addr@x>" or bare "addr@x", tolerating wrapping quotes) into {name, address}.
function parseFrom(from: string): { name: string; address: string } {
  const s = from.trim().replace(/^"(.*)"$/, '$1').trim();
  const m = /^(.*?)\s*<([^>]+)>$/.exec(s);
  if (m && m[2]) return { name: (m[1] ?? '').trim().replace(/^"(.*)"$/, '$1'), address: m[2].trim() };
  return { name: '', address: s };
}

// Send via the ZeptoMail HTTPS API (port 443). Never throws; returns true only on a 2xx.
async function sendViaApi(url: string, cfg: Config, msg: EmailMessage, log?: MiniLog): Promise<boolean> {
  const from = parseFrom(cfg.email.from || cfg.email.user);
  // The send token is EMAIL_PASS; the API expects it prefixed with "Zoho-enczapikey ". Tolerate a value the
  // user already pasted with that prefix so we never double it.
  const token = (cfg.email.pass || '').replace(/^Zoho-enczapikey\s+/i, '');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Zoho-enczapikey ${token}`,
      },
      body: JSON.stringify({
        from: { address: from.address, name: from.name || undefined },
        to: [{ email_address: { address: msg.to } }],
        subject: msg.subject,
        htmlbody: msg.html,
        textbody: msg.text ?? htmlToText(msg.html),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log?.warn?.({ status: res.status, body: body.slice(0, 300), subject: msg.subject }, 'email send failed (zepto api)');
      return false;
    }
    log?.info?.({ to: msg.to, subject: msg.subject }, 'email sent (zepto api)');
    return true;
  } catch (e) {
    log?.warn?.({ err: (e as Error).message, subject: msg.subject }, 'email send failed (zepto api)');
    return false;
  }
}

// Returns true only on a successful send; false on no-op (unconfigured) or failure. Never throws.
// Note: only `to` + `subject` are ever logged — never the body — so OTP codes never reach the logs.
export async function sendEmail(cfg: Config, msg: EmailMessage, log?: MiniLog): Promise<boolean> {
  const from = cfg.email.from || cfg.email.user;
  if (!from || !msg.to) {
    log?.info?.({ to: msg.to, subject: msg.subject }, 'email skipped (not configured)');
    return false;
  }

  // Prefer the HTTPS API when available (works where SMTP ports are blocked).
  const apiUrl = emailApiUrl(cfg.email);
  if (apiUrl) return sendViaApi(apiUrl, cfg, msg, log);

  // SMTP fallback.
  const t = transporterFor(cfg.email);
  if (!t) {
    log?.info?.({ to: msg.to, subject: msg.subject, configured: false }, 'email skipped (SMTP not configured)');
    return false;
  }
  try {
    await t.sendMail({ from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text ?? htmlToText(msg.html) });
    log?.info?.({ to: msg.to, subject: msg.subject }, 'email sent');
    return true;
  } catch (e) {
    log?.warn?.({ err: (e as Error).message, subject: msg.subject }, 'email send failed');
    return false;
  }
}

// Minimal HTML→text fallback for the plain-text part when a caller doesn't supply one.
function htmlToText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
