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
      id: b.id || b.uid, title: b.title,
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

    const { data: rep } = await supabaseAdmin.auth.admin.getUserById(lead.assigned_rep_id);
    const repEmail = rep && rep.user && rep.user.email;
    if (!repEmail) return res.status(200).json({ ok: true, skipped: true });

    const kind = lead.lifecycle === 'lead' ? 'lead' : 'prospect';
    const result = await sendEmail({
      to: repEmail,
      subject: `New ${kind} assigned: ${lead.full_name}`,
      html: emailShell('New assignment', `<p>${lead.full_name}${lead.business ? ' — ' + lead.business : ''} has been assigned to you as a ${kind}.</p><p>Open rep.html to follow up.</p>`),
    });
    return res.status(200).json({ ok: true, email: result });
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

    let toEmail = null;
    if (repProfile && repProfile.manager_id) {
      const { data: manager } = await supabaseAdmin.auth.admin.getUserById(repProfile.manager_id);
      toEmail = manager && manager.user && manager.user.email;
    }
    if (!toEmail) toEmail = process.env.ADMIN_NOTIFY_EMAIL || null;
    if (!toEmail) return res.status(200).json({ ok: true, skipped: true });

    const repName = (repProfile && repProfile.full_name) || 'A rep';
    const result = await sendEmail({
      to: toEmail,
      subject: `Demo booked: ${deal.contact}${deal.business ? ' (' + deal.business + ')' : ''}`,
      html: emailShell('Demo booked', `<p>${repName} just booked a demo with ${deal.contact}${deal.business ? ' — ' + deal.business : ''}. An Opportunity has been created.</p>`),
    });
    return res.status(200).json({ ok: true, email: result });
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

    const { data: rep } = await supabaseAdmin.auth.admin.getUserById(commission.rep_id);
    const repEmail = rep && rep.user && rep.user.email;
    if (!repEmail) return res.status(200).json({ ok: true, skipped: true });

    const amount = '$' + Number(commission.amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const result = await sendEmail({
      to: repEmail,
      subject: `Commission update: ${amount} is now ${commission.status}`,
      html: emailShell('Commission status updated', `<p>Your ${commission.kind === 'override' ? 'override ' : ''}commission of ${amount} is now <b>${commission.status}</b>.</p>`),
    });
    return res.status(200).json({ ok: true, email: result });
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
  'create-signing-request': createSigningRequest,
  'documenso-webhook': documensoWebhook,
  'impersonate': impersonate,
  'cal-bookings': calBookings,
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
