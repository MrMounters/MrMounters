// Vercel serverless function — Admin confirms that payment has cleared for an Opportunity and
// closes it Won. All privileged work (mark Won, create the Client, write the commission ledger)
// happens inside the Postgres SECURITY DEFINER function convert_opportunity_to_client(), which
// runs as ONE transaction and is idempotent (unique origin_deal_id + a unique commission index
// prevent duplicate client and duplicate commission entries under retries/double-clicks).
//
// This is the manual/admin path. The same DB function is also called by the Stripe webhook on a
// real checkout.session.completed for kind='opportunity_won'. Commissions are recorded as an
// obligation ledger only — no automatic transfer happens here.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (server-only — bypasses RLS; NEVER expose to the browser)

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'not_configured', detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Only an admin may confirm payment + close (separation of duties from reps/managers).
    const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) return res.status(401).json({ error: 'unauthorized' });
    const caller = callerData.user;
    const { data: callerProfile } = await supabaseAdmin
      .from('profiles').select('role').eq('user_id', caller.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden', detail: 'Only admins can confirm payment and close an opportunity.' });
    }

    const { deal_id, payment_ref } = req.body || {};
    if (!deal_id) return res.status(400).json({ error: 'deal_id_required' });
    if (!payment_ref) return res.status(400).json({ error: 'payment_ref_required', detail: 'Record the confirmed Stripe payment / reference id.' });

    const { data, error } = await supabaseAdmin.rpc('convert_opportunity_to_client', {
      p_deal_id: deal_id,
      p_payment_ref: String(payment_ref),
      p_actor: caller.id,
    });
    if (error) {
      const code = /not_found/.test(error.message) ? 404 : 400;
      return res.status(code).json({ error: 'close_failed', detail: error.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, client_id: data });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
};
