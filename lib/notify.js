// Shared notification helpers (email via Resend, SMS via Twilio). Lives OUTSIDE /api so it
// does NOT count as its own Vercel serverless function — it's bundled into whichever function
// requires it (api/actions.js and api/cron.js today).
//
// Every function here is best-effort and never throws: a failed or unconfigured send must
// never break the thing that triggered it. Each returns { skipped:true } when its provider
// env vars aren't set yet, so all of this ships dormant and turns on the moment the keys exist.
//
// Env vars:
//   RESEND_API_KEY, RESEND_FROM_EMAIL          — email
//   TWILIO_ACCOUNT_SID, TWILIO_API_KEY,
//     TWILIO_API_SECRET, TWILIO_CALLER_ID      — SMS (caller id must be an SMS-capable number)

async function sendEmail({ to, subject, html, replyTo }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL || !to) return { skipped: true };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_API_KEY },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL, to: Array.isArray(to) ? to : [to], subject, html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) { console.error('resend send failed', json); return { ok: false, detail: json }; }
    return { ok: true, id: json && json.id };
  } catch (e) {
    console.error('resend send error', e);
    return { ok: false, detail: String((e && e.message) || e) };
  }
}

async function sendSms({ to, body }) {
  const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_CALLER_ID } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET || !TWILIO_CALLER_ID || !to) return { skipped: true };
  try {
    const twilio = require('twilio');
    const client = twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid: TWILIO_ACCOUNT_SID });
    const msg = await client.messages.create({ from: TWILIO_CALLER_ID, to, body });
    return { ok: true, sid: msg.sid };
  } catch (e) {
    console.error('twilio sms error', e);
    return { ok: false, detail: String((e && e.message) || e) };
  }
}

// Wrap body HTML in a minimal branded shell.
function emailShell(title, bodyHtml) {
  return `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#111">
    <h2 style="margin:0 0 12px">${title}</h2>${bodyHtml}
    <p style="margin-top:24px;color:#888;font-size:12px">Meridion AI</p></div>`;
}

module.exports = { sendEmail, sendSms, emailShell };
