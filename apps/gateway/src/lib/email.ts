import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config.js';

// Single outbound-email helper for the gateway (SMTP via nodemailer, configured from env). Secrets are
// gateway-only (never a browser bundle). When EMAIL_HOST is empty this is a LOGGING NO-OP so dev/prod
// without SMTP configured never crashes. sendEmail NEVER throws — on missing config or an SMTP error it
// logs and returns false, so callers can treat every email as fire-and-forget and never fail the main
// request because a send failed.

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

// True when SMTP is configured enough to actually send (a host and a usable From). Callers that must
// NOT claim success on a silent no-op (e.g. OTP delivery) check this up front and fail explicitly.
export function emailConfigured(cfg: Config): boolean {
  return !!(cfg.email.host && (cfg.email.from || cfg.email.user));
}

export interface EmailMessage { to: string; subject: string; html: string; text?: string; }
interface MiniLog { info?: (...a: any[]) => void; warn?: (...a: any[]) => void }

// Returns true only on a successful send; false on no-op (unconfigured) or failure. Never throws.
// Note: only `to` + `subject` are ever logged — never the body — so OTP codes never reach the logs.
export async function sendEmail(cfg: Config, msg: EmailMessage, log?: MiniLog): Promise<boolean> {
  const t = transporterFor(cfg.email);
  const from = cfg.email.from || cfg.email.user;
  if (!t || !from || !msg.to) {
    log?.info?.({ to: msg.to, subject: msg.subject, configured: !!t }, 'email skipped (SMTP not configured)');
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
