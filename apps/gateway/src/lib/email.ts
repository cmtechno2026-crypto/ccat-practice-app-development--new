import type { Config } from '../config.js';

// Single outbound-email helper for the gateway. ZeptoMail ONLY: every send goes over the ZeptoMail
// HTTPS API (443) — set EMAIL_API_KEY (+ EMAIL_FROM, and EMAIL_API_URL for the region). There is no SMTP
// fallback. Secrets are gateway-only (never a browser bundle). When EMAIL_API_KEY is unset this is a
// LOGGING NO-OP.
// sendEmail NEVER throws — on missing config or a send error it logs and returns false, so callers treat
// every email as fire-and-forget and never fail the main request because a send failed.

// True when email is configured enough to actually send (an API key OR an SMTP host, plus a usable From).
// Callers that must NOT claim success on a silent no-op (e.g. OTP delivery) check this up front.
export function emailConfigured(cfg: Config): boolean {
  const e = cfg.email;
  return !!(e.apiKey && (e.from || e.user));
}

export interface EmailMessage { to: string; subject: string; html: string; text?: string; }
interface MiniLog { info?: (...a: any[]) => void; warn?: (...a: any[]) => void }

// ---------------------------------------------------------------------------
// Branded email shell. Every transactional email the app sends to a
// parent/guardian is a `bodyHtml` fragment wrapped by renderEmail(), so the
// Concept Mastery logo, the support block and the footer are identical
// everywhere and new emails inherit them for free. The design mirrors the
// approved template (centred white card on a light-grey page).
// ---------------------------------------------------------------------------

// The public origin the emails link to (sign-in) and load the logo from. Falls back to the production
// CCAT origin when WEB_APP_ORIGIN is unset, so links/logo never break.
export function emailOrigin(cfg: Config): string {
  return cfg.webAppOrigin || 'https://ccat.conceptmastery.com';
}

// Support/footer block, identical in every email. Phone + Call/WhatsApp, then the legal footer + address.
function emailFooter(): string {
  return `
      <div style="border-top:1px solid #edeff3;margin:34px 0 0;padding-top:22px">
        <p style="margin:0 0 10px;color:#1c3f6e;font-weight:700;font-size:14px;text-align:center">Need help? We're here.</p>
        <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.7;text-align:center">
          Phone support: <a href="tel:+19054696087" style="color:#1a5eab;text-decoration:none">+1 905-469-6087</a><br>
          Call / WhatsApp: <a href="tel:+16477656606" style="color:#1a5eab;text-decoration:none">+1 (647) 765-6606</a>
        </p>
        <p style="margin:20px 0 0;color:#aab2bf;font-size:12px;line-height:1.7;text-align:center">
          © 2026 Concept Mastery. All Rights Reserved.<br>
          This is a service message about a CCAT Practice account linked to your email address.<br>
          Concept Mastery, 2161 Overfield Rd, Oakville, ON L6M 3T1, Canada
        </p>
      </div>`;
}

// Wrap a body fragment in the branded card (logo header + body + support/footer).
export function renderEmail(cfg: Config, bodyHtml: string): string {
  const logo = `${emailOrigin(cfg)}/email-logo.png`;
  return `<div style="background:#f4f5f7;padding:28px 14px">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #eceef2;border-radius:14px;padding:36px 40px;font-family:'Segoe UI',system-ui,Arial,sans-serif">
        <div style="margin:0 0 22px"><img src="${logo}" width="180" alt="Concept Mastery" style="width:180px;max-width:60%;height:auto;display:block;margin:0 auto"></div>
        ${bodyHtml}
        ${emailFooter()}
      </div>
    </div>`;
}

// Small body-fragment builders shared by the templates, so every email uses identical typography.
export const emailUI = {
  h1: (t: string) => `<h1 style="margin:0 0 6px;color:#1c3f6e;font-size:22px;font-weight:800;text-align:center">${t}</h1>`,
  sub: (t: string) => `<p style="margin:0 0 22px;color:#6b7280;font-size:15px;text-align:center;line-height:1.6">${t}</p>`,
  p: (t: string) => `<p style="margin:0 0 14px;color:#455065;font-size:15px;line-height:1.7;text-align:center">${t}</p>`,
  muted: (t: string) => `<p style="margin:0 0 14px;color:#455065;font-size:15px;line-height:1.7;text-align:center"><span style="color:#9aa3af;font-size:13px">${t}</span></p>`,
  card: (inner: string) => `<div style="background:#eef3fb;border-radius:10px;padding:20px;margin:0 0 22px;text-align:center">${inner}</div>`,
  button: (label: string, href: string) => `<div style="text-align:center;margin:8px 0 22px"><a href="${href}" style="display:inline-block;background:#e5443f;color:#fff;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:1px;text-transform:uppercase;padding:14px 36px;border-radius:999px">${label}</a></div>`,
};

// Returns true only on a successful send; false on no-op (unconfigured) or failure. Never throws.
// Only `to` + `subject` are ever logged — never the body — so OTP codes never reach the logs.
export async function sendEmail(cfg: Config, msg: EmailMessage, log?: MiniLog): Promise<boolean> {
  const from = cfg.email.from || cfg.email.user;
  if (!from || !msg.to) {
    log?.info?.({ to: msg.to, subject: msg.subject }, 'email skipped (not configured)');
    return false;
  }
  // ZeptoMail ONLY — all gateway email goes over the HTTPS API. No SMTP fallback.
  if (!cfg.email.apiKey) { log?.info?.({ to: msg.to, subject: msg.subject }, 'email skipped (ZeptoMail API key not set)'); return false; }
  return sendViaApi(cfg, from, msg, log);
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
