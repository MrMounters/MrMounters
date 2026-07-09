// Vercel serverless function — admin.html's "Sign in as this client" button calls this to get
// a one-time magic-link URL for a specific client, so an admin can view the portal exactly as
// that client sees it. Requires the service_role key for two things a plain client-side call
// can never do: (1) look up a user's email from just their id (profiles has no email column —
// only auth.users does, which isn't exposed to the anon key), and (2) generate a sign-in link
// without knowing that user's password.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (server-only — bypasses RLS; NEVER expose this to the browser)

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'not_configured', detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in Vercel env vars.' });
  }

  // Verify the caller is a real, currently-signed-in admin — never trust the client to
  // self-report this.
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('user_id', callerData.user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden', detail: 'Only admins can sign in as another user.' });
    }

    const { client_id } = req.body || {};
    if (!client_id) return res.status(400).json({ error: 'client_id_required' });

    const { data: targetUser, error: targetErr } = await supabaseAdmin.auth.admin.getUserById(client_id);
    if (targetErr || !targetUser || !targetUser.user || !targetUser.user.email) {
      return res.status(404).json({ error: 'client_not_found' });
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: targetUser.user.email,
      options: { redirectTo: origin + '/portal.html?impersonating=1' },
    });
    if (linkErr || !linkData || !linkData.properties || !linkData.properties.action_link) {
      return res.status(400).json({ error: 'link_generation_failed', detail: linkErr ? linkErr.message : 'Unknown error.' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url: linkData.properties.action_link });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
};
