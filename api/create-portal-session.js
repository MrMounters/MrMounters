// Vercel serverless function — finds or creates a Stripe Customer by email and returns a
// Stripe-hosted Billing Portal session URL (real payment method, real invoice history, plan
// management — no custom UI needed).
//
// Required env var:
//   STRIPE_SECRET_KEY   (starts sk_... — server-side only)
//
// KNOWN LIMITATION: this trusts the client-supplied email as-is. There is no server-side
// verification of the caller's Supabase session/JWT anywhere in this app yet, so before
// handling real customers, verify the requester's identity server-side (e.g. validate the
// Supabase access token against SUPABASE_URL) rather than trusting req.body.email directly.

const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'stripe_not_configured' });
  }

  const email = req.body && req.body.email;
  if (!email) {
    return res.status(400).json({ error: 'missing_email' });
  }

  try {
    const stripe = Stripe(STRIPE_SECRET_KEY);
    const origin = (req.headers.origin) || `https://${req.headers.host}`;

    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer = existing.data[0] || (await stripe.customers.create({ email }));

    const portal = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: `${origin}/portal.html`,
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url: portal.url });
  } catch (e) {
    return res.status(500).json({ error: 'portal_session_error', detail: String((e && e.message) || e) });
  }
};
