// Vercel serverless function — returns a Stripe-hosted Billing Portal session URL for the
// SIGNED-IN caller only. The Stripe customer is derived server-side from the caller's own
// verified identity, never from a client-supplied email.
//
// Security: the browser sends its Supabase access token in the Authorization header. We look
// the user up with it (service role), then resolve their Stripe customer from the clients
// table (or, failing that, from their verified auth email). A caller can never open another
// customer's portal by passing a different email.
//
// Required env vars:
//   STRIPE_SECRET_KEY          (starts sk_... — server-side only)
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (server-only — bypasses RLS; NEVER expose to the browser)

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!STRIPE_SECRET_KEY) return res.status(503).json({ error: 'stripe_not_configured' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });

  // 1) Verify the caller's Supabase session — no token, no portal.
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'unauthorized' });
    const user = userData.user;

    // 2) Resolve THIS user's Stripe customer server-side. Prefer a stored customer id on
    //    their client record; otherwise fall back to their verified auth email.
    let customerId = null;
    const { data: clientRow } = await supabaseAdmin
      .from('clients').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
    if (clientRow && clientRow.stripe_customer_id) customerId = clientRow.stripe_customer_id;

    const stripe = Stripe(STRIPE_SECRET_KEY);
    const origin = (req.headers.origin) || `https://${req.headers.host}`;

    if (!customerId) {
      const email = user.email;
      if (!email) return res.status(400).json({ error: 'no_customer_for_user' });
      const existing = await stripe.customers.list({ email, limit: 1 });
      const customer = existing.data[0] || (await stripe.customers.create({ email }));
      customerId = customer.id;
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/portal.html`,
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url: portal.url });
  } catch (e) {
    return res.status(500).json({ error: 'portal_session_error', detail: String((e && e.message) || e) });
  }
};
