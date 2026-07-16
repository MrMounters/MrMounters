// Vercel serverless function — Admin initiates (or regenerates) a Stripe Connect Express
// onboarding link for an eligible Sales Rep or Team Manager. Creates the connected account
// on first use, stores its id + status on the user's profile, and returns a hosted
// account-onboarding link (KYC). No funds move here — this only establishes the account
// that future commission payouts (a later phase) will transfer to.
//
// Privileged: verifies the caller is a signed-in admin via their Supabase JWT, then uses the
// service role. The Stripe secret key never leaves the server.
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

function mapStatus(acct) {
  // Map Stripe capability flags to our four-state vocabulary.
  if (acct && acct.charges_enabled && acct.payouts_enabled) return 'enabled';
  if (acct && acct.requirements && Array.isArray(acct.requirements.currently_due)
      && acct.requirements.disabled_reason) return 'restricted';
  if (acct && (acct.details_submitted || (acct.requirements && acct.requirements.currently_due
      && acct.requirements.currently_due.length))) return 'pending';
  return 'pending';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!STRIPE_SECRET_KEY) return res.status(503).json({ error: 'stripe_not_configured' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Caller must be a signed-in admin.
    const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) return res.status(401).json({ error: 'unauthorized' });
    const { data: callerProfile } = await supabaseAdmin
      .from('profiles').select('role').eq('user_id', callerData.user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden', detail: 'Only admins can manage Connect onboarding.' });
    }

    const targetUserId = req.body && req.body.user_id;
    if (!targetUserId) return res.status(400).json({ error: 'user_id_required' });

    // Target must be an eligible staff member (rep or manager).
    const { data: target } = await supabaseAdmin
      .from('profiles').select('role, stripe_connect_account_id').eq('user_id', targetUserId).single();
    if (!target || !['rep', 'manager'].includes(target.role)) {
      return res.status(400).json({ error: 'ineligible', detail: 'Connect is only for reps and managers.' });
    }

    const { data: targetUser } = await supabaseAdmin.auth.admin.getUserById(targetUserId);
    const email = targetUser && targetUser.user && targetUser.user.email;

    const stripe = Stripe(STRIPE_SECRET_KEY);
    let accountId = target.stripe_connect_account_id;

    // Create the Express account once; reuse it on regenerate.
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: email || undefined,
        capabilities: { transfers: { requested: true } },
        metadata: { supabase_user_id: targetUserId },
      });
      accountId = account.id;
      await supabaseAdmin.from('profiles')
        .update({ stripe_connect_account_id: accountId, connect_status: 'pending' })
        .eq('user_id', targetUserId);
    } else {
      // Refresh status from Stripe on regenerate.
      const acct = await stripe.accounts.retrieve(accountId);
      await supabaseAdmin.from('profiles')
        .update({ connect_status: mapStatus(acct) }).eq('user_id', targetUserId);
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
};
