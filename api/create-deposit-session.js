// Vercel serverless function — creates a Stripe Checkout Session for a project's deposit.
//
// The deposit amount is read authoritatively from Supabase (project_stages.data.amount,
// set by staff in admin.html), never trusted from the client request — otherwise a client
// could tamper with the request and pay $1 instead of the real deposit.
//
// Required env vars:
//   STRIPE_SECRET_KEY          (starts sk_...)
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (server-only — bypasses RLS to read the amount regardless of
//                               who's asking; NEVER expose this key to the browser)

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'deposit_checkout_not_configured' });
  }

  const stageId = req.body && req.body.stageId;
  if (!stageId) {
    return res.status(400).json({ error: 'missing_stage_id' });
  }

  try {
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: stage, error: stageErr } = await supabaseAdmin
      .from('project_stages')
      .select('id, stage_key, status, data, project_id, projects(name)')
      .eq('id', stageId)
      .single();

    if (stageErr || !stage) {
      return res.status(404).json({ error: 'stage_not_found' });
    }
    if (stage.stage_key !== 'deposit_paid') {
      return res.status(400).json({ error: 'not_a_deposit_stage' });
    }
    if (stage.status === 'done') {
      return res.status(400).json({ error: 'already_paid' });
    }

    const amount = Number(stage.data && stage.data.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'deposit_amount_not_set', detail: 'Ask your project admin to set the deposit amount first.' });
    }

    const stripe = Stripe(STRIPE_SECRET_KEY);
    const origin = (req.headers.origin) || `https://${req.headers.host}`;
    const projectName = (stage.projects && stage.projects.name) || 'Your Project';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(amount * 100),
            product_data: { name: 'Deposit — ' + projectName },
          },
          quantity: 1,
        },
      ],
      metadata: { kind: 'project_deposit', stage_id: stage.id, project_id: stage.project_id },
      success_url: `${origin}/portal.html?stage_paid=${stage.id}`,
      cancel_url: `${origin}/portal.html`,
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'deposit_session_error', detail: String((e && e.message) || e) });
  }
};
