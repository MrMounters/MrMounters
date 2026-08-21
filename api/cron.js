// ---------------------------------------------------------------------------
// api/cron.js — daily automated follow-up nudges.
//
// Runs once a day (see vercel.json → crons). For every rep, it finds their prospects/leads
// that have gone COLD — still being worked, not archived, and not contacted in a few days —
// and sends that rep a single digest email (plus an optional SMS if we have their number),
// so nothing quietly rots at the top of the funnel. It then stamps each nudged lead's
// `last_nudged_at` so the same rows aren't re-nudged before the cooldown passes.
//
// v1 nudges the REP, never the prospect directly — no TCPA/CAN-SPAM exposure, no risk of
// messaging a lead the rep hasn't chosen to contact. Auto-messaging prospects would be a
// separate, consent-gated feature.
//
// Security: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on scheduled invocations
// when CRON_SECRET is set as an env var. We require it, so a random internet POST can't spam
// every rep. If CRON_SECRET isn't set the endpoint refuses to run (fail closed).
//
// Env vars:
//   CRON_SECRET                              — shared secret Vercel Cron presents (required)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — service-role DB access
//   RESEND_API_KEY, RESEND_FROM_EMAIL        — email digests (dormant until set)
//   TWILIO_* (see lib/notify.js)             — optional SMS pings
//
// Tunables (env-overridable):
//   FOLLOWUP_COLD_DAYS   (default 3)  — no contact for this many days → cold
//   FOLLOWUP_COOLDOWN_DAYS (default 3) — don't re-nudge a lead within this window
//   FOLLOWUP_MAX_ROWS    (default 25) — cap rows listed per rep in the digest
// ---------------------------------------------------------------------------

const { sendEmail, sendSms, emailShell } = require('../lib/notify');

// Statuses that are terminal / not worth nudging (dead or already advanced past the funnel).
const TERMINAL_STATUSES = new Set([
  'Converted', 'Qualified', 'Do Not Contact', 'Bad Data', 'Wrong Number',
  'Duplicate', 'Disqualified', 'Lost', 'Archived',
]);

function daysAgoIso(days) {
  // Cron/serverless can't use Date.now()? It can here — this is runtime, not a workflow script.
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

module.exports = async function handler(req, res) {
  // Vercel Cron issues GET; allow POST too for manual/testing triggers.
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) return res.status(503).json({ error: 'cron_not_configured', detail: 'CRON_SECRET not set' });
  const auth = req.headers && req.headers.authorization;
  if (auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'unauthorized' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const coldDays = Number(process.env.FOLLOWUP_COLD_DAYS) || 3;
  const cooldownDays = Number(process.env.FOLLOWUP_COOLDOWN_DAYS) || 3;
  const maxRows = Number(process.env.FOLLOWUP_MAX_ROWS) || 25;

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const coldBefore = daysAgoIso(coldDays);
    const cooldownBefore = daysAgoIso(cooldownDays);

    // Pull working prospects/leads that are assigned, not archived, and cold. A row is "cold"
    // when it hasn't been contacted since `coldBefore` — treating a never-contacted row
    // (last_contacted_at IS NULL) as cold via the OR below.
    const { data: leads, error } = await supabaseAdmin
      .from('leads')
      .select('id, full_name, business, status, lifecycle, assigned_rep_id, last_contacted_at, last_nudged_at, next_action')
      .is('archived_at', null)
      .not('assigned_rep_id', 'is', null)
      .or(`last_contacted_at.is.null,last_contacted_at.lt.${coldBefore}`)
      .or(`last_nudged_at.is.null,last_nudged_at.lt.${cooldownBefore}`)
      .order('assigned_rep_id', { ascending: true });

    if (error) return res.status(500).json({ error: 'query_failed', detail: error.message });

    // Drop terminal statuses in JS (long vocab is app-enforced, not a DB CHECK).
    const working = (leads || []).filter((l) => !TERMINAL_STATUSES.has(l.status));

    // Group by rep.
    const byRep = new Map();
    for (const l of working) {
      if (!byRep.has(l.assigned_rep_id)) byRep.set(l.assigned_rep_id, []);
      byRep.get(l.assigned_rep_id).push(l);
    }

    let repsNotified = 0;
    let leadsNudged = 0;
    const nudgedIds = [];

    for (const [repId, rows] of byRep) {
      // Resolve rep contact info.
      const { data: repUser } = await supabaseAdmin.auth.admin.getUserById(repId);
      const repEmail = repUser && repUser.user && repUser.user.email;
      const { data: profile } = await supabaseAdmin
        .from('profiles').select('full_name, phone').eq('user_id', repId).single();

      // Build the digest. Cap the visible list; count the overflow.
      const shown = rows.slice(0, maxRows);
      const overflow = rows.length - shown.length;
      const firstName = (profile && profile.full_name || '').split(' ')[0] || 'there';

      const items = shown.map((l) => {
        const who = l.full_name + (l.business ? ` — ${l.business}` : '');
        const tag = l.lifecycle === 'lead' ? 'Lead' : 'Prospect';
        const st = l.status ? ` · ${l.status}` : '';
        const na = l.next_action ? `<br><span style="color:#666;font-size:12px">Next: ${l.next_action}</span>` : '';
        return `<li style="margin:0 0 10px"><b>${who}</b> <span style="color:#888;font-size:12px">(${tag}${st})</span>${na}</li>`;
      }).join('');

      const overflowLine = overflow > 0
        ? `<p style="color:#888;font-size:12px">…and ${overflow} more waiting in your pipeline.</p>` : '';

      if (repEmail) {
        await sendEmail({
          to: repEmail,
          subject: `${rows.length} follow-up${rows.length === 1 ? '' : 's'} waiting — Meridion AI`,
          html: emailShell('Your follow-ups for today', `
            <p>Hi ${firstName}, these prospects and leads have gone quiet — a quick touch keeps them warm:</p>
            <ul style="padding-left:18px;margin:12px 0">${items}</ul>
            ${overflowLine}
            <p style="margin-top:16px"><a href="https://www.meridionai.com/rep.html" style="color:#4C59F7">Open your pipeline →</a></p>`),
        });
      }

      // Optional SMS ping (best-effort; skipped when Twilio unconfigured or no number).
      if (profile && profile.phone) {
        await sendSms({
          to: profile.phone,
          body: `Meridion AI: you have ${rows.length} follow-up${rows.length === 1 ? '' : 's'} going cold. Open rep.html to keep them warm.`,
        });
      }

      // Stamp last_nudged_at on every row we surfaced (whether email/SMS actually sent or was
      // skipped) so the cooldown advances and we don't re-scan the same rows tomorrow.
      const ids = rows.map((r) => r.id);
      nudgedIds.push(...ids);
      leadsNudged += ids.length;
      if (repEmail || (profile && profile.phone)) repsNotified += 1;
    }

    if (nudgedIds.length) {
      const nowIso = new Date().toISOString();
      // Chunk updates to keep the IN list reasonable.
      for (let i = 0; i < nudgedIds.length; i += 200) {
        const chunk = nudgedIds.slice(i, i + 200);
        await supabaseAdmin.from('leads').update({ last_nudged_at: nowIso }).in('id', chunk);
      }
    }

    return res.status(200).json({ ok: true, reps_notified: repsNotified, leads_nudged: leadsNudged });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
};
