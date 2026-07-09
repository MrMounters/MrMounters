// Vercel serverless function — admin.html's "Invite Rep" form calls this to create (or
// promote) a rep account. Two things a plain client-side Supabase call can never do safely:
//   1. Invite a brand-new user by email and learn their user_id back, in one step.
//   2. Set profiles.role — RLS deliberately does NOT let anyone (even admins) update someone
//      else's role from the browser, so promotion has to go through a trusted server route.
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
  // self-report this. The browser sends its own Supabase access token in the Authorization
  // header; we look the user up with it and check their role server-side.
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
      return res.status(403).json({ error: 'forbidden', detail: 'Only admins can invite reps.' });
    }

    const { email, full_name } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email_required' });

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const { data: invited, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: origin + '/onboarding.html',
      data: full_name ? { full_name } : undefined,
    });
    if (inviteErr || !invited || !invited.user) {
      return res.status(400).json({ error: 'invite_failed', detail: inviteErr ? inviteErr.message : 'Unknown error inviting user.' });
    }

    // handle_new_user() already created their profiles row (default role 'client') the
    // instant the auth.users row was created above — promote it now.
    const { error: roleErr } = await supabaseAdmin.from('profiles').update({ role: 'rep' }).eq('user_id', invited.user.id);
    if (roleErr) {
      return res.status(500).json({ error: 'role_update_failed', detail: roleErr.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, user_id: invited.user.id });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
};
