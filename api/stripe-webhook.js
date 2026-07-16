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
      const meta = session.metadata || {};
      const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
      const supaReady = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY;

      // Project deposit payments are only ever confirmed here, never client-side — this is
      // the one place that can be trusted, since it's verified by Stripe's signature above.
      if (meta.kind === 'project_deposit' && meta.stage_id) {
        if (supaReady) {
          const { createClient } = require('@supabase/supabase-js');
          const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
          const { error } = await supabaseAdmin.from('project_stages').update({
            status: 'done', completed_at: new Date().toISOString(),
          }).eq('id', meta.stage_id);
          if (error) console.error('deposit stage update failed', error.message);
        } else {
          console.error('deposit paid but SUPABASE_SERVICE_ROLE_KEY not configured — stage not marked done');
        }
      }

      // Opportunity closed-won on confirmed payment. The transactional, idempotent DB
      // function does everything (mark Won, create the client, write the commission ledger).
      // Safe to receive twice — origin_deal_id / commission unique indexes dedupe.
      if (meta.kind === 'opportunity_won' && meta.deal_id) {
        if (supaReady) {
          const { createClient } = require('@supabase/supabase-js');
          const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
          const { error } = await supabaseAdmin.rpc('convert_opportunity_to_client', {
            p_deal_id: meta.deal_id,
            p_payment_ref: session.id,
            p_actor: meta.actor_id || null,
          });
          if (error) {
            console.error('opportunity_won conversion failed', error.message);
            // Non-200 so Stripe retries — never silently drop a cleared payment.
            return res.status(500).json({ error: 'conversion_failed', detail: error.message });
          }
        } else {
          console.error('opportunity won but SUPABASE_SERVICE_ROLE_KEY not configured');
          return res.status(500).json({ error: 'supabase_not_configured' });
        }
      }
      break;
    }
    case 'account.updated': {
      // Stripe Connect onboarding progress — sync our four-state connect_status.
      const acct = event.data.object;
      const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        let status = 'pending';
        if (acct.charges_enabled && acct.payouts_enabled) status = 'enabled';
        else if (acct.requirements && acct.requirements.disabled_reason) status = 'restricted';
        const { createClient } = require('@supabase/supabase-js');
        const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const { error } = await supabaseAdmin.from('profiles')
          .update({ connect_status: status }).eq('stripe_connect_account_id', acct.id);
        if (error) console.error('connect status sync failed', error.message);
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      // Subscription status sync (active/canceled/past_due) is a postponed phase.
      console.log(event.type, event.data.object.id);
      break;
    default:
      break;
  }

  return res.status(200).json({ received: true });
};
