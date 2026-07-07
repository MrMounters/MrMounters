// Vercel serverless function — Stripe webhook receiver.
// Point a webhook endpoint at https://<your-domain>/api/stripe-webhook in the Stripe
// Dashboard (Developers → Webhooks), select the events below, then copy the signing
// secret into STRIPE_WEBHOOK_SECRET.
//
// Required env vars:
//   STRIPE_SECRET_KEY     (starts sk_...)
//   STRIPE_WEBHOOK_SECRET (starts whsec_... — from the Stripe Dashboard webhook endpoint)
//
// Signature verification needs the RAW request body, so automatic body parsing is disabled
// below and the body is read as a raw buffer before handing it to stripe.webhooks.constructEvent.

const Stripe = require('stripe');

module.exports.config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'stripe_webhook_not_configured' });
  }

  const stripe = Stripe(STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: 'invalid_signature', detail: String((e && e.message) || e) });
  }

  switch (event.type) {
    case 'checkout.session.completed':
      // TODO: a purchase completed. event.data.object is the Checkout Session —
      // e.g. write the client/subscription record to Supabase here.
      console.log('checkout.session.completed', event.data.object.id);
      break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      // TODO: sync subscription status (active/canceled/past_due) to Supabase here.
      console.log(event.type, event.data.object.id);
      break;
    default:
      break;
  }

  return res.status(200).json({ received: true });
};
