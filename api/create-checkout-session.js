// Vercel serverless function — creates a Stripe Checkout Session for the two fixed-price
// Web Dev plans (one-time site build, monthly plan). App Dev and Ad Campaigns are custom-
// quoted and are NOT wired here — they stay as sms: contact links on the pricing page.
//
// Required env var (set in Vercel: Project → Settings → Environment Variables):
//   STRIPE_SECRET_KEY   (starts sk_... — server-side only, never expose to the browser)
//
// Uses inline price_data so no Products/Prices need to be pre-created in the Stripe Dashboard.

const Stripe = require('stripe');

const PLANS = {
  onetime: {
    mode: 'payment',
    name: 'Website — One-Time Build',
    amount: 350000, // $3,500.00, in cents
  },
  monthly: {
    mode: 'subscription',
    name: 'Website — Monthly Plan',
    amount: 29400, // $294.00/mo, in cents
  },
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'stripe_not_configured' });
  }

  const plan = req.body && req.body.plan;
  const config = PLANS[plan];
  if (!config) {
    return res.status(400).json({ error: 'invalid_plan', detail: 'plan must be "onetime" or "monthly"' });
  }

  try {
    const stripe = Stripe(STRIPE_SECRET_KEY);
    const origin = (req.headers.origin) || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: config.mode,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: config.amount,
            product_data: { name: config.name },
            ...(config.mode === 'subscription' ? { recurring: { interval: 'month' } } : {}),
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/index.html?checkout=success#pricing`,
      cancel_url: `${origin}/index.html?checkout=cancelled#pricing`,
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'checkout_session_error', detail: String((e && e.message) || e) });
  }
};
