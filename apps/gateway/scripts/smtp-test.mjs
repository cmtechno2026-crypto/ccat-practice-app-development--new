// Standalone SMTP smoke test for the CCAT gateway email path. Uses the SAME env vars the gateway reads
// (EMAIL_HOST/EMAIL_PORT/EMAIL_USER/EMAIL_PASS/EMAIL_FROM) plus SMTP_TEST_TO for the recipient, so a
// green run here means the gateway will also send. Secrets stay in your shell — nothing is hardcoded.
//
// Run from apps/gateway (so nodemailer resolves), e.g.:
//   EMAIL_HOST=smtp.zoho.com EMAIL_PORT=465 EMAIL_USER=no-reply@conceptmastery.com \
//   EMAIL_PASS='********' EMAIL_FROM=no-reply@conceptmastery.com \
//   SMTP_TEST_TO=you@yourinbox.com node scripts/smtp-test.mjs
//
// Exit code 0 = verified + test message accepted; 1 = failure (reason printed).
import nodemailer from 'nodemailer';

const { EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM, SMTP_TEST_TO } = process.env;
const from = EMAIL_FROM || EMAIL_USER;
const to = SMTP_TEST_TO || from;

function fail(msg) { console.error('SMTP TEST FAILED:', msg); process.exit(1); }
if (!EMAIL_HOST) fail('EMAIL_HOST is empty — SMTP is not configured.');
if (!from) fail('EMAIL_FROM (or EMAIL_USER) is empty — no From address.');
if (!to) fail('SMTP_TEST_TO is empty — set a recipient inbox to test delivery.');

const port = Number(EMAIL_PORT || 587);
const transporter = nodemailer.createTransport({
  host: EMAIL_HOST,
  port,
  secure: port === 465,                       // implicit TLS on 465; STARTTLS on 587/25
  auth: EMAIL_USER ? { user: EMAIL_USER, pass: EMAIL_PASS } : undefined,
});

console.log(`Connecting to ${EMAIL_HOST}:${port} (secure=${port === 465}) as ${EMAIL_USER || '(no auth)'} …`);
try {
  await transporter.verify();
  console.log('✓ SMTP connection + auth OK');
} catch (e) {
  fail(`connect/auth: ${e.message}`);
}
try {
  const info = await transporter.sendMail({
    from,
    to,
    subject: 'CCAT SMTP test',
    text: 'This is a CCAT gateway SMTP smoke test. If you received it, OTP/receipt/notice emails will send.',
    html: '<p>This is a CCAT gateway SMTP smoke test. If you received it, OTP / receipt / notice emails will send.</p>',
  });
  console.log(`✓ Test message accepted for delivery → ${to} (id: ${info.messageId})`);
  console.log('Now check that inbox (and spam). If it lands in spam, publish SPF/DKIM/DMARC for the From domain.');
  process.exit(0);
} catch (e) {
  fail(`send: ${e.message}`);
}
