// Vercel serverless function — single consolidated endpoint for every app action that isn't
// a fixed-URL external webhook/telephony callback. Vercel's Hobby plan caps a deployment at
// 12 serverless functions; this app had grown past that with one file per action, so they're
// merged here behind an `action` dispatcher. Each case below is the exact, unmodified body of
// what used to be its own /api/<name>.js file — same auth checks, same status codes, same
// behavior, just routed through one entry point instead of one file each.
//
// Call as: POST /api/actions?action=<name>  (body is the same JSON each action always took)
//   or:    GET  /api/actions?action=<name>&...  (for the two read-only/query-string actions)
//
// Kept OUT of this file on purpose (still their own serverless functions):
//   - api/stripe-webhook.js — needs the raw request body (bodyParser disabled) for Stripe's
//     signature verification, and its URL is already configured in the Stripe Dashboard.
//   - api/twiml.js — Twilio's own servers call this directly as a fixed "Voice URL" configured
//     in the Twilio Console, and it returns XML rather than JSON.
// That keeps this deployment at 3 functions total, with headroom well under the 12 limit.
//
// Actions: create-checkout-session, create-deposit-session, create-portal-session,
//   create-connect-account, close-opportunity, invite-rep, create-signing-request,
//   documenso-webhook, impersonate, cal-bookings, twilio-token.

const crypto = require('crypto');

function bearerToken(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

// Verifies the caller's Supabase JWT and returns their auth user. Shared by every action that
// needs "who is asking" before doing privileged work or sending a notification on someone's
// behalf.
async function requireUser(supabaseAdmin, req) {
  const token = bearerToken(req);
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Resend — best-effort transactional email. Never throws: a failed/unconfigured send should
// never break the action that triggered it (e.g. an assignment still saves even if the
// notification email fails). Returns { skipped } when RESEND_API_KEY / RESEND_FROM_EMAIL
// aren't set yet, or { ok, id|detail } once they are.
//
// Required env vars once you're ready to send real email:
//   RESEND_API_KEY     (from Resend → API Keys)
//   RESEND_FROM_EMAIL  (an address on your verified sending domain, e.g. notifications@yourdomain.com)
// Optional:
//   ADMIN_NOTIFY_EMAIL (where "demo booked" pings go when the rep has no manager on file)
// ---------------------------------------------------------------------------
// sendEmail / emailShell / sendSms now live in ../lib/notify.js so the cron endpoint can
// share them without duplicating code (and without adding another Vercel function — lib/ is
// bundled into whichever function requires it). Both remain best-effort and never throw.
const { sendEmail, emailShell } = require('../lib/notify');

// In-app companion to sendEmail — writes a row to the notifications table (M5's recipient_id)
// so the recipient sees a real bell/badge in rep.html or manager.html, not just an email that
// can get lost in an inbox. Best-effort and never throws, matching sendEmail's contract.
async function notifyInApp(supabaseAdmin, recipientId, title, body) {
  if (!recipientId) return { skipped: true };
  try {
    const { error } = await supabaseAdmin.from('notifications').insert({ recipient_id: recipientId, title, body });
    if (error) { console.error('in-app notify failed', error); return { ok: false, detail: error.message }; }
    return { ok: true };
  } catch (e) {
    console.error('in-app notify error', e);
    return { ok: false, detail: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// create-checkout-session — Stripe Checkout for the two fixed-price Web Dev plans.
// ---------------------------------------------------------------------------
async function createCheckoutSession(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) return res.status(503).json({ error: 'stripe_not_configured' });

  const PLANS = {
    onetime: { mode: 'payment', name: 'Website — One-Time Build', amount: 350000 },
    monthly: { mode: 'subscription', name: 'Website — Monthly Plan', amount: 29400 },
  };
  const plan = req.body && req.body.plan;
  const config = PLANS[plan];
  if (!config) return res.status(400).json({ error: 'invalid_plan', detail: 'plan must be "onetime" or "monthly"' });

  try {
    const Stripe = require('stripe');
    const stripe = Stripe(STRIPE_SECRET_KEY);
    const origin = (req.headers.origin) || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: config.mode,
      line_items: [{
        price_data: {
          currency: 'usd', unit_amount: config.amount, product_data: { name: config.name },
          ...(config.mode === 'subscription' ? { recurring: { interval: 'month' } } : {}),
        },
        quantity: 1,
      }],
      success_url: `${origin}/web-development.html?checkout=success#pricing`,
      cancel_url: `${origin}/web-development.html?checkout=cancelled#pricing`,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'checkout_session_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// create-deposit-session — Stripe Checkout for a project's deposit (amount read from DB).
// ---------------------------------------------------------------------------
async function createDepositSession(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'deposit_checkout_not_configured' });

  const stageId = req.body && req.body.stageId;
  if (!stageId) return res.status(400).json({ error: 'missing_stage_id' });

  try {
    const Stripe = require('stripe');
    const { createClient } = require('@supabase/supabase-js');
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: stage, error: stageErr } = await supabaseAdmin
      .from('project_stages').select('id, stage_key, status, data, project_id, projects(name)').eq('id', stageId).single();

    if (stageErr || !stage) return res.status(404).json({ error: 'stage_not_found' });
    if (stage.stage_key !== 'deposit_paid') return res.status(400).json({ error: 'not_a_deposit_stage' });
    if (stage.status === 'done') return res.status(400).json({ error: 'already_paid' });

    const amount = Number(stage.data && stage.data.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'deposit_amount_not_set', detail: 'Ask your project admin to set the deposit amount first.' });

    const stripe = Stripe(STRIPE_SECRET_KEY);
    const origin = (req.headers.origin) || `https://${req.headers.host}`;
    const projectName = (stage.projects && stage.projects.name) || 'Your Project';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price_data: { currency: 'usd', unit_amount: Math.round(amount * 100), product_data: { name: 'Deposit — ' + projectName } }, quantity: 1 }],
      metadata: { kind: 'project_deposit', stage_id: stage.id, project_id: stage.project_id },
      success_url: `${origin}/portal.html?stage_paid=${stage.id}`,
      cancel_url: `${origin}/portal.html`,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'deposit_session_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// create-portal-session — Stripe Billing Portal for the SIGNED-IN caller only.
// ---------------------------------------------------------------------------
async function createPortalSession(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!STRIPE_SECRET_KEY) return res.status(503).json({ error: 'stripe_not_configured' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'unauthorized' });
    const user = userData.user;

    let customerId = null;
    const { data: clientRow } = await supabaseAdmin.from('clients').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
    if (clientRow && clientRow.stripe_customer_id) customerId = clientRow.stripe_customer_id;

    const Stripe = require('stripe');
    const stripe = Stripe(STRIPE_SECRET_KEY);
    const origin = (req.headers.origin) || `https://${req.headers.host}`;

    if (!customerId) {
      const email = user.email;
      if (!email) return res.status(400).json({ error: 'no_customer_for_user' });
      const existing = await stripe.customers.list({ email, limit: 1 });
      const customer = existing.data[0] || (await stripe.customers.create({ email }));
      customerId = customer.id;
    }

    const portal = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${origin}/portal.html` });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url: portal.url });
  } catch (e) {
    return res.status(500).json({ error: 'portal_session_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// create-connect-account — Admin creates/regenerates a Stripe Connect Express onboarding link.
// ---------------------------------------------------------------------------
function mapConnectStatus(acct) {
  if (acct && acct.charges_enabled && acct.payouts_enabled) return 'enabled';
  if (acct && acct.requirements && Array.isArray(acct.requirements.currently_due) && acct.requirements.disabled_reason) return 'restricted';
  if (acct && (acct.details_submitted || (acct.requirements && acct.requirements.currently_due && acct.requirements.currently_due.length))) return 'pending';
  return 'pending';
}
async function createConnectAccount(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!STRIPE_SECRET_KEY) return res.status(503).json({ error: 'stripe_not_configured' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) return res.status(401).json({ error: 'unauthorized' });
    const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('user_id', callerData.user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') return res.status(403).json({ error: 'forbidden', detail: 'Only admins can manage Connect onboarding.' });

    const targetUserId = req.body && req.body.user_id;
    if (!targetUserId) return res.status(400).json({ error: 'user_id_required' });

    const { data: target } = await supabaseAdmin.from('profiles').select('role, stripe_connect_account_id').eq('user_id', targetUserId).single();
    if (!target || !['rep', 'manager'].includes(target.role)) return res.status(400).json({ error: 'ineligible', detail: 'Connect is only for reps and managers.' });

    const { data: targetUser } = await supabaseAdmin.auth.admin.getUserById(targetUserId);
    const email = targetUser && targetUser.user && targetUser.user.email;

    const Stripe = require('stripe');
    const stripe = Stripe(STRIPE_SECRET_KEY);
    let accountId = target.stripe_connect_account_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express', email: email || undefined,
        capabilities: { transfers: { requested: true } },
        metadata: { supabase_user_id: targetUserId },
      });
      accountId = account.id;
      await supabaseAdmin.from('profiles').update({ stripe_connect_account_id: accountId, connect_status: 'pending' }).eq('user_id', targetUserId);
    } else {
      const acct = await stripe.accounts.retrieve(accountId);
      await supabaseAdmin.from('profiles').update({ connect_status: mapConnectStatus(acct) }).eq('user_id', targetUserId);
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/admin.html?connect=refresh`,
      return_url: `${origin}/admin.html?connect=done`,
      type: 'account_onboarding',
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, url: link.url, account_id: accountId });
  } catch (e) {
    return res.status(500).json({ error: 'connect_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// close-opportunity — Admin confirms payment cleared; closes the Opportunity Won.
// ---------------------------------------------------------------------------
async function closeOpportunity(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'not_configured', detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.' });

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) return res.status(401).json({ error: 'unauthorized' });
    const caller = callerData.user;
    const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('user_id', caller.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') return res.status(403).json({ error: 'forbidden', detail: 'Only admins can confirm payment and close an opportunity.' });

    const { deal_id, payment_ref } = req.body || {};
    if (!deal_id) return res.status(400).json({ error: 'deal_id_required' });
    if (!payment_ref) return res.status(400).json({ error: 'payment_ref_required', detail: 'Record the confirmed Stripe payment / reference id.' });

    const { data, error } = await supabaseAdmin.rpc('convert_opportunity_to_client', {
      p_deal_id: deal_id, p_payment_ref: String(payment_ref), p_actor: caller.id,
    });
    if (error) {
      const code = /not_found/.test(error.message) ? 404 : 400;
      return res.status(code).json({ error: 'close_failed', detail: error.message });
    }

    // Best-effort welcome email — only fires if the opportunity traces back to a lead with an
    // email on file (opportunities entered without one, e.g. via the admin "Add Opportunity"
    // form, simply have no recipient yet). Never blocks the response either way.
    try {
      const { data: client } = await supabaseAdmin.from('clients').select('business_name, contact_name, contact_email').eq('id', data).single();
      if (client && client.contact_email) {
        await sendEmail({
          to: client.contact_email,
          subject: `Welcome to Meridion AI, ${client.business_name || client.contact_name || ''}!`,
          html: emailShell('You’re all set 🎉', `<p>Hi ${client.contact_name || 'there'},</p>
            <p>Thanks for signing on with Meridion AI — your project is officially underway. Your rep will be in touch shortly with next steps.</p>`),
        });
      }
    } catch (e) { console.error('welcome email failed', e); }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, client_id: data });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// invite-rep — Admin invites a new Sales Rep or Team Manager account.
// ---------------------------------------------------------------------------
async function inviteRep(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'not_configured', detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in Vercel env vars.' });

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) return res.status(401).json({ error: 'unauthorized' });
    const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('user_id', callerData.user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') return res.status(403).json({ error: 'forbidden', detail: 'Only admins can invite reps.' });

    const { email, full_name, role, manager_id, team_id } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email_required' });

    const newRole = role === 'manager' ? 'manager' : 'rep';

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const { data: invited, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: origin + '/onboarding.html',
      data: full_name ? { full_name } : undefined,
    });
    if (inviteErr || !invited || !invited.user) return res.status(400).json({ error: 'invite_failed', detail: inviteErr ? inviteErr.message : 'Unknown error inviting user.' });

    const patch = { role: newRole };
    if (manager_id) patch.manager_id = manager_id;
    if (team_id) patch.team_id = team_id;
    // Also persist to profiles.full_name — inviteUserByEmail's `data` option only writes
    // auth.users.raw_user_meta_data, which nothing reads for the admin Team table. Without
    // this, every invited rep/manager shows "Unnamed" until they separately fill out
    // onboarding.html or their profile page.
    if (full_name) patch.full_name = full_name;
    const { error: roleErr } = await supabaseAdmin.from('profiles').update(patch).eq('user_id', invited.user.id);
    if (roleErr) return res.status(500).json({ error: 'role_update_failed', detail: roleErr.message });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, user_id: invited.user.id, role: newRole });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// create-signing-request — starts/resumes a Documenso e-signature request for a rep.
// ---------------------------------------------------------------------------
const DOCUMENSO_BASE = 'https://app.documenso.com/api/v1';

async function createSigningRequest(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DOCUMENSO_API_KEY, DOCUMENSO_NDA_TEMPLATE_ID, DOCUMENSO_NC_TEMPLATE_ID } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });
  if (!DOCUMENSO_API_KEY) return res.status(503).json({ error: 'documenso_not_configured', detail: 'DOCUMENSO_API_KEY missing in Vercel env vars.' });

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const doc_type = req.body && req.body.doc_type === 'non_compete' ? 'non_compete' : (req.body && req.body.doc_type === 'nda' ? 'nda' : null);
  if (!doc_type) return res.status(400).json({ error: 'invalid_doc_type', detail: 'doc_type must be "nda" or "non_compete".' });

  const templateId = doc_type === 'nda' ? DOCUMENSO_NDA_TEMPLATE_ID : DOCUMENSO_NC_TEMPLATE_ID;
  if (!templateId) return res.status(503).json({ error: 'template_not_configured', detail: `DOCUMENSO_${doc_type === 'nda' ? 'NDA' : 'NC'}_TEMPLATE_ID missing.` });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) return res.status(401).json({ error: 'unauthorized' });
    const caller = callerData.user;

    const { data: profile } = await supabaseAdmin.from('profiles').select('full_name').eq('user_id', caller.id).single();
    const name = (profile && profile.full_name) || caller.user_metadata?.full_name || caller.email || 'Sales Rep';
    const email = caller.email;
    if (!email) return res.status(400).json({ error: 'email_required', detail: 'Your account needs a verified email to sign documents.' });

    const { data: existing } = await supabaseAdmin.from('agreements').select('*').eq('rep_id', caller.id).eq('doc_type', doc_type).maybeSingle();

    if (existing && existing.status === 'signed') return res.status(200).json({ ok: true, status: 'signed', signed_pdf_path: existing.signed_pdf_path });
    if (existing && existing.status === 'pending' && existing.signing_url) return res.status(200).json({ ok: true, status: 'pending', signing_url: existing.signing_url });

    const { data: agreement, error: upsertErr } = await supabaseAdmin.from('agreements')
      .upsert({ rep_id: caller.id, doc_type, status: 'pending' }, { onConflict: 'rep_id,doc_type' }).select().single();
    if (upsertErr || !agreement) return res.status(500).json({ error: 'agreement_row_failed', detail: upsertErr && upsertErr.message });

    const docRes = await fetch(`${DOCUMENSO_BASE}/templates/${templateId}/create-document`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: DOCUMENSO_API_KEY },
      body: JSON.stringify({ externalId: agreement.id, recipients: [{ name, email }] }),
    });
    const docJson = await docRes.json().catch(() => null);
    if (!docRes.ok || !docJson || !docJson.recipients || !docJson.recipients[0]) {
      return res.status(502).json({ error: 'documenso_create_failed', detail: (docJson && (docJson.message || docJson.error)) || `Documenso returned ${docRes.status}` });
    }

    const signingUrl = docJson.recipients[0].signingUrl;
    await supabaseAdmin.from('agreements').update({ documenso_document_id: docJson.documentId, signing_url: signingUrl }).eq('id', agreement.id);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, status: 'pending', signing_url: signingUrl });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// documenso-webhook — receives document.completed, stores the signed PDF, marks it signed.
// Configure this action's full URL (…/api/actions?action=documenso-webhook) as the webhook
// endpoint in the Documenso dashboard.
// ---------------------------------------------------------------------------
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
async function documensoWebhook(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DOCUMENSO_API_KEY, DOCUMENSO_WEBHOOK_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DOCUMENSO_API_KEY || !DOCUMENSO_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'documenso_webhook_not_configured' });
  }

  const providedSecret = req.headers['x-documenso-secret'];
  if (!safeEqual(providedSecret, DOCUMENSO_WEBHOOK_SECRET)) return res.status(401).json({ error: 'invalid_signature' });

  const body = req.body || {};
  const event = body.event;
  const payload = body.payload;

  if (event !== 'document.completed' || !payload) return res.status(200).json({ received: true, ignored: true });

  const agreementId = payload.externalId;
  const documensoDocumentId = payload.id;
  if (!agreementId) return res.status(200).json({ received: true, ignored: true });

  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: agreement, error: findErr } = await supabaseAdmin.from('agreements').select('*').eq('id', agreementId).single();
    if (findErr || !agreement) {
      console.error('documenso webhook: agreement not found for externalId', agreementId);
      return res.status(200).json({ received: true, ignored: true });
    }
    if (agreement.status === 'signed') return res.status(200).json({ received: true, already_signed: true });

    const dlRes = await fetch(`${DOCUMENSO_BASE}/documents/${documensoDocumentId}/download`, { headers: { Authorization: DOCUMENSO_API_KEY } });
    const dlJson = await dlRes.json().catch(() => null);
    if (!dlRes.ok || !dlJson || !dlJson.downloadUrl) {
      console.error('documenso webhook: could not get download URL', dlJson);
      return res.status(500).json({ error: 'download_url_failed' });
    }

    const pdfRes = await fetch(dlJson.downloadUrl);
    if (!pdfRes.ok) {
      console.error('documenso webhook: PDF fetch failed', pdfRes.status);
      return res.status(500).json({ error: 'pdf_fetch_failed' });
    }
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

    const path = `${agreement.rep_id}/${agreement.doc_type}-signed.pdf`;
    const { error: uploadErr } = await supabaseAdmin.storage.from('rep-docs').upload(path, pdfBuffer, { upsert: true, contentType: 'application/pdf' });
    if (uploadErr) {
      console.error('documenso webhook: storage upload failed', uploadErr.message);
      return res.status(500).json({ error: 'storage_upload_failed' });
    }

    await supabaseAdmin.from('agreements').update({
      status: 'signed', signed_at: new Date().toISOString(), signed_pdf_path: path, documenso_document_id: documensoDocumentId,
    }).eq('id', agreement.id);

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('documenso webhook error', e);
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// impersonate — Admin gets a one-time magic link to view the portal as a specific client.
// ---------------------------------------------------------------------------
async function impersonate(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'not_configured', detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in Vercel env vars.' });

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) return res.status(401).json({ error: 'unauthorized' });
    const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('user_id', callerData.user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') return res.status(403).json({ error: 'forbidden', detail: 'Only admins can sign in as another user.' });

    const { client_id } = req.body || {};
    if (!client_id) return res.status(400).json({ error: 'client_id_required' });

    const { data: targetUser, error: targetErr } = await supabaseAdmin.auth.admin.getUserById(client_id);
    if (targetErr || !targetUser || !targetUser.user || !targetUser.user.email) return res.status(404).json({ error: 'client_not_found' });

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink', email: targetUser.user.email, options: { redirectTo: origin + '/portal.html?impersonating=1' },
    });
    if (linkErr || !linkData || !linkData.properties || !linkData.properties.action_link) {
      return res.status(400).json({ error: 'link_generation_failed', detail: linkErr ? linkErr.message : 'Unknown error.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url: linkData.properties.action_link });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// cal-bookings — upcoming Cal.com bookings for the admin dashboard (read-only, no auth).
// ---------------------------------------------------------------------------
async function calBookings(req, res) {
  const CALCOM_API_KEY = process.env.CALCOM_API_KEY;
  if (!CALCOM_API_KEY) return res.status(200).json({ configured: false, bookings: [] });

  const CAL_API_VERSION = '2024-08-13';
  try {
    const take = Math.min(Math.max(parseInt(req.query && req.query.take, 10) || 25, 1), 100);
    const url = 'https://api.cal.com/v2/bookings?status=upcoming&take=' + take;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + CALCOM_API_KEY, 'cal-api-version': CAL_API_VERSION } });
    if (!r.ok) return res.status(200).json({ configured: true, bookings: [], error: 'calcom_api_error_' + r.status });
    const data = await r.json();
    const list = data.data || data.bookings || [];
    const bookings = list.map(b => ({
      id: b.id || b.uid, uid: b.uid, title: b.title,
      attendeeName: (b.attendees && b.attendees[0] && b.attendees[0].name) || null,
      attendeeEmail: (b.attendees && b.attendees[0] && b.attendees[0].email) || null,
      start: b.start || b.startTime, end: b.end || b.endTime, status: b.status,
    }));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ configured: true, bookings });
  } catch (e) {
    return res.status(200).json({ configured: true, bookings: [], error: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// cancel-booking — admin cancels a Cal.com booking (used from the admin Consultations
// calendar). Rescheduling is handled client-side by opening Cal.com's own hosted reschedule
// page (https://cal.com/reschedule/{uid}) rather than reimplementing a slot picker here.
// ---------------------------------------------------------------------------
async function cancelBooking(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { CALCOM_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!CALCOM_API_KEY) return res.status(503).json({ error: 'calcom_not_configured' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const caller = await requireUser(supabaseAdmin, req);
  if (!caller) return res.status(401).json({ error: 'unauthorized' });

  try {
    const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('user_id', caller.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const { booking_uid, reason } = req.body || {};
    if (!booking_uid) return res.status(400).json({ error: 'booking_uid_required' });

    const CAL_API_VERSION = '2024-08-13';
    const r = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(booking_uid)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CALCOM_API_KEY, 'cal-api-version': CAL_API_VERSION },
      body: JSON.stringify({ cancellationReason: (reason && reason.trim()) || 'Cancelled by admin' }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) return res.status(502).json({ error: 'calcom_cancel_failed', detail: data });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// twilio-token — short-lived Twilio Voice access token for the browser dialer.
// ---------------------------------------------------------------------------
function twilioToken(req, res) {
  const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET || !TWILIO_TWIML_APP_SID) {
    return res.status(503).json({ error: 'twilio_not_configured' });
  }
  try {
    const twilio = require('twilio');
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const identity = (req.query && req.query.identity) || 'rep';

    const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, { identity });
    token.addGrant(new VoiceGrant({ outgoingApplicationSid: TWILIO_TWIML_APP_SID, incomingAllow: false }));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ token: token.toJwt(), identity });
  } catch (e) {
    return res.status(500).json({ error: 'token_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// notify-assignment — best-effort email to a rep when a prospect/lead is assigned to them.
// Called from the browser right after the assignment write already succeeded (RLS already
// proved the caller was allowed to make it); this only sends the notification.
// ---------------------------------------------------------------------------
async function notifyAssignment(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const caller = await requireUser(supabaseAdmin, req);
  if (!caller) return res.status(401).json({ error: 'unauthorized' });

  try {
    const { lead_id } = req.body || {};
    if (!lead_id) return res.status(400).json({ error: 'lead_id_required' });

    const { data: lead } = await supabaseAdmin.from('leads').select('full_name, business, lifecycle, assigned_rep_id').eq('id', lead_id).single();
    if (!lead || !lead.assigned_rep_id) return res.status(200).json({ ok: true, skipped: true });

    const kind = lead.lifecycle === 'lead' ? 'lead' : 'prospect';
    const inApp = await notifyInApp(supabaseAdmin, lead.assigned_rep_id, `New ${kind} assigned`,
      `${lead.full_name}${lead.business ? ' — ' + lead.business : ''}`);

    const { data: rep } = await supabaseAdmin.auth.admin.getUserById(lead.assigned_rep_id);
    const repEmail = rep && rep.user && rep.user.email;
    if (!repEmail) return res.status(200).json({ ok: true, in_app: inApp, email: { skipped: true } });

    const result = await sendEmail({
      to: repEmail,
      subject: `New ${kind} assigned: ${lead.full_name}`,
      html: emailShell('New assignment', `<p>${lead.full_name}${lead.business ? ' — ' + lead.business : ''} has been assigned to you as a ${kind}.</p><p>Open rep.html to follow up.</p>`),
    });
    return res.status(200).json({ ok: true, in_app: inApp, email: result });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// notify-demo-booked — best-effort email to the rep's manager (or ADMIN_NOTIFY_EMAIL as a
// fallback) when a rep books a demo, so someone besides the rep knows a hot one just landed.
// ---------------------------------------------------------------------------
async function notifyDemoBooked(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const caller = await requireUser(supabaseAdmin, req);
  if (!caller) return res.status(401).json({ error: 'unauthorized' });

  try {
    const { deal_id } = req.body || {};
    if (!deal_id) return res.status(400).json({ error: 'deal_id_required' });

    const { data: deal } = await supabaseAdmin.from('deals').select('contact, business, rep_id').eq('id', deal_id).single();
    if (!deal) return res.status(200).json({ ok: true, skipped: true });

    const { data: repProfile } = await supabaseAdmin.from('profiles').select('full_name, manager_id').eq('user_id', deal.rep_id).single();
    const repName = (repProfile && repProfile.full_name) || 'A rep';

    let toEmail = null;
    let inApp = { skipped: true };
    if (repProfile && repProfile.manager_id) {
      inApp = await notifyInApp(supabaseAdmin, repProfile.manager_id, 'Demo booked',
        `${repName} just booked a demo with ${deal.contact}${deal.business ? ' — ' + deal.business : ''}.`);
      const { data: manager } = await supabaseAdmin.auth.admin.getUserById(repProfile.manager_id);
      toEmail = manager && manager.user && manager.user.email;
    }
    if (!toEmail) toEmail = process.env.ADMIN_NOTIFY_EMAIL || null;
    if (!toEmail) return res.status(200).json({ ok: true, in_app: inApp, skipped: true });

    const result = await sendEmail({
      to: toEmail,
      subject: `Demo booked: ${deal.contact}${deal.business ? ' (' + deal.business + ')' : ''}`,
      html: emailShell('Demo booked', `<p>${repName} just booked a demo with ${deal.contact}${deal.business ? ' — ' + deal.business : ''}. An Opportunity has been created.</p>`),
    });
    return res.status(200).json({ ok: true, in_app: inApp, email: result });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// notify-commission-status — best-effort email to a rep when admin advances their commission
// through Pending -> Approved -> Payable -> Paid (or Reverses it).
// ---------------------------------------------------------------------------
async function notifyCommissionStatus(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const caller = await requireUser(supabaseAdmin, req);
  if (!caller) return res.status(401).json({ error: 'unauthorized' });

  try {
    const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('user_id', caller.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const { commission_id } = req.body || {};
    if (!commission_id) return res.status(400).json({ error: 'commission_id_required' });

    const { data: commission } = await supabaseAdmin.from('commissions').select('rep_id, amount, status, kind, revenue_type').eq('id', commission_id).single();
    if (!commission) return res.status(200).json({ ok: true, skipped: true });

    const amount = '$' + Number(commission.amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const inApp = await notifyInApp(supabaseAdmin, commission.rep_id, 'Commission update',
      `Your ${commission.kind === 'override' ? 'override ' : ''}commission of ${amount} is now ${commission.status}.`);

    const { data: rep } = await supabaseAdmin.auth.admin.getUserById(commission.rep_id);
    const repEmail = rep && rep.user && rep.user.email;
    if (!repEmail) return res.status(200).json({ ok: true, in_app: inApp, email: { skipped: true } });

    const result = await sendEmail({
      to: repEmail,
      subject: `Commission update: ${amount} is now ${commission.status}`,
      html: emailShell('Commission status updated', `<p>Your ${commission.kind === 'override' ? 'override ' : ''}commission of ${amount} is now <b>${commission.status}</b>.</p>`),
    });
    return res.status(200).json({ ok: true, in_app: inApp, email: result });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// admin-update-team-member — admin sets/fixes a rep/manager/admin's name (and business_name).
// Needed because profiles RLS only allows a user to update their own row — an admin fixing a
// teammate's "Unnamed" entry (e.g. an account created before onboarding.html was filled out)
// has to go through the service role.
// ---------------------------------------------------------------------------
async function adminUpdateTeamMember(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) return res.status(401).json({ error: 'unauthorized' });
    const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('user_id', callerData.user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') return res.status(403).json({ error: 'forbidden', detail: 'Only admins can edit team members.' });

    const { user_id, full_name, business_name } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id_required' });
    if (!full_name || !full_name.trim()) return res.status(400).json({ error: 'full_name_required' });

    const { data: target } = await supabaseAdmin.from('profiles').select('role').eq('user_id', user_id).single();
    if (!target || !['rep', 'manager', 'admin'].includes(target.role)) return res.status(400).json({ error: 'not_a_team_member' });

    const patch = { full_name: full_name.trim() };
    if (business_name !== undefined) patch.business_name = (business_name || '').trim() || null;
    const { error } = await supabaseAdmin.from('profiles').update(patch).eq('user_id', user_id);
    if (error) return res.status(500).json({ error: 'update_failed', detail: error.message });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// admin-backfill-names — auto-fills profiles.full_name from auth.users metadata for any team
// member missing it. Covers accounts invited before invite-rep started writing full_name to
// profiles directly (it used to only reach auth.users.raw_user_meta_data via the
// inviteUserByEmail `data` option) — their real name was captured at invite time, it just
// never got copied over. Run automatically whenever the admin Team page loads (best-effort,
// no-op if there's nothing to fill), so this fixes itself with no manual clicking wherever the
// name already exists somewhere. Accounts with no name on file anywhere (never invited with
// one, never completed onboarding) still need a human to type it once via the Edit button.
// ---------------------------------------------------------------------------
async function adminBackfillNames(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) return res.status(401).json({ error: 'unauthorized' });
    const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('user_id', callerData.user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const { data: missing } = await supabaseAdmin.from('profiles').select('user_id')
      .in('role', ['rep', 'manager', 'admin']).is('full_name', null);
    if (!missing || !missing.length) return res.status(200).json({ ok: true, filled: 0 });

    let filled = 0;
    for (const row of missing) {
      const { data: u } = await supabaseAdmin.auth.admin.getUserById(row.user_id);
      const meta = u && u.user && u.user.user_metadata;
      const name = meta && (meta.full_name || meta.name);
      if (!name) continue;
      const { error } = await supabaseAdmin.from('profiles').update({ full_name: name }).eq('user_id', row.user_id);
      if (!error) filled++;
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, filled });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// send-lead-email — a rep/manager/admin emails a prospect or lead straight from the pipeline,
// via Resend, with the sender's own signature and Reply-To (so replies land in the sender's
// real inbox, not a noreply address). Every send is logged to activity_log so the contact's
// "Sent" history is visible to anyone who could already see that lead (rep who owns it,
// their manager, or admin) — reusing the existing table/policies rather than adding a new one.
// ---------------------------------------------------------------------------
async function sendLeadEmail(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const caller = await requireUser(supabaseAdmin, req);
  if (!caller) return res.status(401).json({ error: 'unauthorized' });

  try {
    const { lead_id, subject, body } = req.body || {};
    if (!lead_id) return res.status(400).json({ error: 'lead_id_required' });
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'subject_required' });
    if (!body || !body.trim()) return res.status(400).json({ error: 'body_required' });

    const { data: lead } = await supabaseAdmin.from('leads').select('id, full_name, email, assigned_rep_id').eq('id', lead_id).single();
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });
    if (!lead.email) return res.status(400).json({ error: 'lead_has_no_email' });

    // Authorization: same scoping RLS would apply in the browser — own lead (rep), downline
    // (manager, one hop — matches the commission-override MVP design elsewhere), or admin.
    // Needed here because this write goes through the service role, which bypasses RLS.
    const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role, full_name, phone').eq('user_id', caller.id).single();
    const role = callerProfile && callerProfile.role;
    let allowed = role === 'admin' || lead.assigned_rep_id === caller.id;
    if (!allowed && role === 'manager' && lead.assigned_rep_id) {
      const { data: repProfile } = await supabaseAdmin.from('profiles').select('manager_id').eq('user_id', lead.assigned_rep_id).single();
      allowed = !!(repProfile && repProfile.manager_id === caller.id);
    }
    if (!allowed) return res.status(403).json({ error: 'forbidden' });

    const senderName = (callerProfile && callerProfile.full_name) || caller.email || 'Meridion AI';
    const bodyHtml = escapeHtml(body).replace(/\n/g, '<br>');
    const signatureHtml = `<p style="margin-top:1.5rem;color:#666;font-size:0.85rem">
      ${escapeHtml(senderName)}<br>Growth Advisor, Meridion AI
      ${callerProfile && callerProfile.phone ? '<br>' + escapeHtml(callerProfile.phone) : ''}</p>`;

    const result = await sendEmail({
      to: lead.email,
      subject: subject.trim(),
      html: emailShell(subject.trim(), `<p>${bodyHtml}</p>${signatureHtml}`),
      replyTo: caller.email || undefined,
    });
    if (result && result.skipped) return res.status(503).json({ error: 'email_not_configured' });
    if (result && result.ok === false) return res.status(502).json({ error: 'send_failed', detail: result.detail });

    await supabaseAdmin.from('activity_log').insert({
      entity_type: 'lead', entity_id: lead_id, action: 'email_sent', actor_id: caller.id,
      detail: { to: lead.email, subject: subject.trim(), preview: body.trim().slice(0, 200), resend_id: result && result.id },
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------------------
// create-audit-lead-brief — public, low-friction audit capture used by the
// homepage. It creates a lead and, when OPENAI_API_KEY is configured, produces
// a concise internal sales brief plus a human-reviewable first follow-up.
//
// This deliberately does not browse the submitted website or make claims about
// it. The URL and email are enough to draft a useful first touch, keep cost
// predictable, and avoid handling sensitive customer/patient data.
// ---------------------------------------------------------------------------
function normalizeAuditWebsite(raw) {
  if (typeof raw !== 'string') return '';
  const value = raw.trim().slice(0, 512);
  if (!value) return '';
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) return '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function cleanAuditEmail(raw) {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 254) : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : '';
}

function cleanAuditUtm(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allowed = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  const result = {};
  allowed.forEach(key => {
    if (typeof raw[key] === 'string' && raw[key].trim()) result[key] = raw[key].trim().slice(0, 160);
  });
  return Object.keys(result).length ? result : null;
}

function auditFallbackBrief(hostname) {
  return {
    business_type: 'Website audit request',
    priority: 'medium',
    opening_sms: `Hi — thanks for requesting a Meridion site audit for ${hostname}. We’ll review the conversion path and send a few focused opportunities within 24 hours.`,
    opening_email_subject: `Your ${hostname} site audit is underway`,
    opening_email_body: `Thanks for requesting a Meridion site audit for ${hostname}. Our team is reviewing the conversion path, messaging, and lead capture experience. We’ll send a focused set of opportunities within 24 hours.`,
    discovery_questions: ['What would make this audit a win for you in the next 90 days?', 'Which service or offer is the highest priority right now?', 'Where do most new customers currently find you?'],
    next_action: 'Review the request, then send the audit and invite the contact to a 15-minute strategy call.',
  };
}

function extractResponseText(payload) {
  if (payload && typeof payload.output_text === 'string') return payload.output_text;
  const output = payload && Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    for (const content of (item && item.content) || []) {
      if (content && content.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return '';
}

async function generateAuditLeadBrief({ websiteUrl, email, hostname }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const fallback = auditFallbackBrief(hostname);
  if (!apiKey) return { brief: fallback, status: 'not_configured', model: null };

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      business_type: { type: 'string' },
      priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      opening_sms: { type: 'string' },
      opening_email_subject: { type: 'string' },
      opening_email_body: { type: 'string' },
      discovery_questions: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
      next_action: { type: 'string' },
    },
    required: ['business_type', 'priority', 'opening_sms', 'opening_email_subject', 'opening_email_body', 'discovery_questions', 'next_action'],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_LEAD_BRIEF_MODEL || 'gpt-5.4',
        store: false,
        instructions: 'You are Meridion AI’s sales operations copilot. Create a concise internal lead brief and a warm first follow-up for a website audit request. Do not claim you reviewed the site. Do not mention AI. Do not invent facts. Do not provide medical, legal, or financial advice. Do not request sensitive personal information or patient information. Keep the email under 110 words and the SMS under 260 characters. The draft is for human review before sending.',
        input: `Website: ${websiteUrl}\nContact email: ${email}\nReturn the requested JSON only.`,
        max_output_tokens: 450,
        text: { format: { type: 'json_schema', name: 'meridion_audit_lead_brief', strict: true, schema } },
      }),
    });
    if (!response.ok) {
      console.error('OpenAI lead brief failed:', response.status);
      return { brief: fallback, status: 'fallback', model: null };
    }
    const payload = await response.json();
    const text = extractResponseText(payload);
    if (!text) return { brief: fallback, status: 'fallback', model: payload && payload.model };
    const brief = JSON.parse(text);
    return { brief, status: 'completed', model: payload && payload.model };
  } catch (error) {
    console.error('OpenAI lead brief error:', String((error && error.message) || error));
    return { brief: fallback, status: 'fallback', model: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function createAuditLeadBrief(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'lead_capture_not_configured' });

  const body = req.body || {};
  // A hidden field that should remain blank. It quietly accepts bots so they do not learn
  // which validation they tripped, while preventing an AI request or database write.
  if (body.company_website) return res.status(202).json({ ok: true });
  const email = cleanAuditEmail(body.email);
  const websiteUrl = normalizeAuditWebsite(body.website_url);
  if (!email || !websiteUrl) return res.status(400).json({ error: 'valid_email_and_website_required' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const hostname = new URL(websiteUrl).hostname.replace(/^www\./, '');
  try {
    // A short database-backed cooldown limits accidental double submits across serverless
    // instances before a model call. A production traffic spike should additionally use WAF
    // or Turnstile, rather than relying on a browser-only control.
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: prior } = await supabaseAdmin.from('ai_lead_briefs')
      .select('id, lead_id, brief, status').eq('email', email).eq('website_url', websiteUrl)
      .gte('created_at', since).order('created_at', { ascending: false }).limit(1);
    if (prior && prior[0]) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, duplicate: true, lead_id: prior[0].lead_id, ai_status: prior[0].status });
    }

    const { data: lead, error: leadError } = await supabaseAdmin.from('leads').insert({
      full_name: hostname,
      email,
      business: hostname,
      lifecycle: 'lead',
      status: 'New',
      source: 'site_audit',
      notes: `Website audit request for ${websiteUrl}`,
      utm: cleanAuditUtm(body.utm),
    }).select('id').single();
    if (leadError) throw leadError;

    const generated = await generateAuditLeadBrief({ websiteUrl, email, hostname });
    const { error: briefError } = await supabaseAdmin.from('ai_lead_briefs').insert({
      lead_id: lead.id, website_url: websiteUrl, email,
      brief: generated.brief, model: generated.model, status: generated.status,
    });
    if (briefError) throw briefError;

    await supabaseAdmin.from('activity_log').insert({
      entity_type: 'lead', entity_id: lead.id, action: 'audit_brief_created',
      detail: { website_url: websiteUrl, ai_status: generated.status, model: generated.model },
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, lead_id: lead.id, ai_status: generated.status });
  } catch (e) {
    console.error('audit lead brief error:', e);
    return res.status(500).json({ error: 'lead_capture_failed' });
  }
}

// ---------------------------------------------------------------------------
// generate-site-draft — rep-facing tool (rep.html "AI Site Builder"). A rep pastes whatever
// they have on a prospect (GMB listing text, business card, existing site URL) and picks the
// closest niche; this calls an LLM to draft one-page site copy using the ICP/pain/offer-angle
// framing from campaign/09-niche-playbooks.md as the rubric, condensed inline below so the
// prompt stays small and doesn't require reading the repo file at request time.
//
// Returns copy JSON only (not full HTML) — rep.html owns the actual page template so design
// tweaks don't require redeploying this function.
// ---------------------------------------------------------------------------
const NICHE_RUBRIC = {
  dental: 'Dental & Orthodontics. ICP/pain: solo or small-group dental/ortho practices where the front desk is juggling phones and patients-in-chair, so new-patient calls and treatment-plan follow-up (Invisalign, implants) go to voicemail and the practice loses the case to whoever calls back first. Offer angle: fast response to every new-patient inquiry. Never make clinical/treatment-outcome claims.',
  home_services: 'Home Services (HVAC, Roofing, Plumbing, Electrical). ICP/pain: owner-operators and small crews (2-20 trucks) who are on jobs, not on the phone — emergency and quote calls go unanswered mid-job and the homeowner calls the next name on Google, a lost job that can be $500-$15k. Offer angle: never miss an emergency or quote call, even mid-job. Proof stays to response time/coverage, never guaranteed-jobs-booked claims.',
  law: 'Law Firms (Personal Injury, Family, Criminal). ICP/pain: small-to-mid firms where intake calls come in around the clock and the firm that responds first usually signs the client; slow response is the #1 reason PI/criminal leads go to a competitor. Offer angle: answer every intake call the moment it comes in. Zero legal-outcome or case-value claims, ever.',
  real_estate: 'Real Estate Teams / Brokerages. ICP/pain: team leads/brokerages running paid lead gen where speed-to-lead is the #1 conversion factor, but agents are in showings, not on the phone, so leads sit and go cold. Offer angle: respond to every buyer/seller lead in seconds. No earnings/commission guarantees.',
  wellness: 'Chiropractic / PT / Wellness (incl. IV therapy, peptides). ICP/pain: cash-pay/insurance-mixed practices where inquiries come by call, text, and DM throughout the day but front desk is with a patient, so leads sit unanswered and book elsewhere. Offer angle: answer every inquiry and book the first visit. No clinical outcome or treatment-result claims.',
  cosmetic: 'Cosmetic / Dermatology & Plastic Surgery. ICP/pain: higher-ticket ($2k-$20k+), consult-heavy sales cycle where a slow reply to a DM/form inquiry means a five-figure lead books a consult elsewhere. Offer angle: fast, discreet response and consult booking. Zero outcome/results or before/after claims.',
  auto: 'Auto (Dealerships, Repair & Detailing). ICP/pain: service departments/shops where phones ring constantly while techs are heads-down, so a caller who can\'t get through calls the next shop. Offer angle: answer every service/sales call, even during busiest hours. No guaranteed-sales or revenue claims.',
  fitness: 'Fitness (Gyms, Studios, Personal Training). ICP/pain: boutique studios where trial/membership inquiries come through website/IG/calls while staff is coaching a class, so unanswered leads rarely follow up themselves. Offer angle: respond instantly and book the first session. No fabricated membership-growth or revenue numbers.',
  other: 'General local service business. ICP/pain: owner-operated or small-team business where inbound calls/messages go unanswered during busy hours and the prospect goes to a competitor instead. Offer angle: respond to every inquiry fast and get it booked. No fabricated stats, reviews, or outcome guarantees.',
};

function siteDraftFallback(bizName) {
  return {
    hero_eyebrow: 'Built For Your Business',
    hero_headline: `${bizName} — Always There When Customers Call.`,
    hero_subheadline: 'A modern, mobile-friendly site that makes it easy for new customers to find you, trust you, and reach out.',
    hooks: ['Fast to load on any phone', 'Built around how customers actually search for you', 'Easy to update as your business grows'],
    services: [
      { name: 'Service One', desc: 'Describe your core service and what makes it different.' },
      { name: 'Service Two', desc: 'Describe a second offering or specialty.' },
      { name: 'Service Three', desc: 'Describe a third offering or specialty.' },
    ],
    process_steps: [
      { title: 'Reach Out', desc: 'A customer calls, texts, or fills out a form.' },
      { title: 'Get a Quote', desc: 'You respond quickly with pricing and availability.' },
      { title: 'Get It Done', desc: 'The job gets scheduled and completed.' },
    ],
    faq: [{ q: 'How do I get a quote?', a: 'Reach out using the contact button above and we\'ll get back to you quickly.' }],
    cta_headline: 'Ready to Get Started?',
    cta_sub: 'Reach out today and see how we can help.',
  };
}

async function generateSiteDraftCopy({ bizName, niche, city, url, rawInfo }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const fallback = siteDraftFallback(bizName);
  if (!apiKey) return { copy: fallback, status: 'not_configured', model: null };

  const rubric = NICHE_RUBRIC[niche] || NICHE_RUBRIC.other;
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      hero_eyebrow: { type: 'string' },
      hero_headline: { type: 'string' },
      hero_subheadline: { type: 'string' },
      hooks: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
      services: {
        type: 'array', minItems: 4, maxItems: 6,
        items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, desc: { type: 'string' } }, required: ['name', 'desc'] },
      },
      process_steps: {
        type: 'array', minItems: 3, maxItems: 4,
        items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, desc: { type: 'string' } }, required: ['title', 'desc'] },
      },
      faq: {
        type: 'array', minItems: 3, maxItems: 4,
        items: { type: 'object', additionalProperties: false, properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] },
      },
      cta_headline: { type: 'string' },
      cta_sub: { type: 'string' },
    },
    required: ['hero_eyebrow', 'hero_headline', 'hero_subheadline', 'hooks', 'services', 'process_steps', 'faq', 'cta_headline', 'cta_sub'],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_LEAD_BRIEF_MODEL || 'gpt-5.4',
        store: false,
        instructions: `You are drafting one-page website copy for a local service business, to be shown to that business as a sales sample. Niche rubric (use this ICP/pain framing, do not deviate from its claim restrictions): ${rubric} General rules: use only facts given in the business info — never invent review counts, awards, years in business, or credentials that weren't provided. Keep tone confident and local, not generic corporate. Return the requested JSON only.`,
        input: `Business name: ${bizName}\nCity/region: ${city || 'not provided'}\nExisting website: ${url || 'not provided'}\nPasted business info:\n${rawInfo}\n\nReturn the requested JSON only.`,
        max_output_tokens: 1400,
        text: { format: { type: 'json_schema', name: 'meridion_site_draft', strict: true, schema } },
      }),
    });
    if (!response.ok) {
      console.error('OpenAI site draft failed:', response.status);
      return { copy: fallback, status: 'fallback', model: null };
    }
    const payload = await response.json();
    const text = extractResponseText(payload);
    if (!text) return { copy: fallback, status: 'fallback', model: payload && payload.model };
    const copy = JSON.parse(text);
    return { copy, status: 'completed', model: payload && payload.model };
  } catch (error) {
    console.error('OpenAI site draft error:', String((error && error.message) || error));
    return { copy: fallback, status: 'fallback', model: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSiteDraft(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const { createClient } = require('@supabase/supabase-js');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const caller = await requireUser(supabaseAdmin, req);
  if (!caller) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body || {};
  const bizName = typeof body.business_name === 'string' ? body.business_name.trim().slice(0, 160) : '';
  const rawInfo = typeof body.raw_info === 'string' ? body.raw_info.trim().slice(0, 4000) : '';
  if (!bizName || !rawInfo) return res.status(400).json({ error: 'business_name_and_raw_info_required' });
  const niche = typeof body.niche === 'string' && NICHE_RUBRIC[body.niche] ? body.niche : 'other';
  const city = typeof body.city === 'string' ? body.city.trim().slice(0, 120) : '';
  const url = typeof body.website_url === 'string' ? body.website_url.trim().slice(0, 300) : '';

  try {
    const generated = await generateSiteDraftCopy({ bizName, niche, city, url, rawInfo });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, copy: generated.copy, ai_status: generated.status });
  } catch (e) {
    console.error('generate site draft error:', e);
    return res.status(500).json({ error: 'generation_failed' });
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
const ACTIONS = {
  'create-checkout-session': createCheckoutSession,
  'create-deposit-session': createDepositSession,
  'create-portal-session': createPortalSession,
  'create-connect-account': createConnectAccount,
  'close-opportunity': closeOpportunity,
  'invite-rep': inviteRep,
  'admin-update-team-member': adminUpdateTeamMember,
  'admin-backfill-names': adminBackfillNames,
  'create-audit-lead-brief': createAuditLeadBrief,
  'generate-site-draft': generateSiteDraft,
  'send-lead-email': sendLeadEmail,
  'create-signing-request': createSigningRequest,
  'documenso-webhook': documensoWebhook,
  'impersonate': impersonate,
  'cal-bookings': calBookings,
  'cancel-booking': cancelBooking,
  'twilio-token': twilioToken,
  'notify-assignment': notifyAssignment,
  'notify-demo-booked': notifyDemoBooked,
  'notify-commission-status': notifyCommissionStatus,
};

module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || (req.body && req.body.action);
  const fn = ACTIONS[action];
  if (!fn) return res.status(400).json({ error: 'unknown_action', detail: 'Pass ?action=<name>. See api/actions.js for the list.' });
  return fn(req, res);
};
