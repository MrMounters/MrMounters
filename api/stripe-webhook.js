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
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log('checkout.session.completed', session.id);

      // Project deposit payments are only ever confirmed here, never client-side — this is
      // the one place that can be trusted, since it's verified by Stripe's signature above.
      if (session.metadata && session.metadata.kind === 'project_deposit' && session.metadata.stage_id) {
        const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
        if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          const { createClient } = require('@supabase/supabase-js');
          const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
          const { error } = await supabaseAdmin.from('project_stages').update({
            status: 'done', completed_at: new Date().toISOString(),
          }).eq('id', session.metadata.stage_id);
          if (error) console.error('deposit stage update failed', error.message);
        } else {
          console.error('deposit paid but SUPABASE_SERVICE_ROLE_KEY not configured — stage not marked done');
        }
      }
      break;
    }
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
