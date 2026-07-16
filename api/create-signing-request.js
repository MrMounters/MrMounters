// Vercel serverless function — starts (or resumes) a REAL e-signature request for a rep's
// NDA or Non-Compete via Documenso (documenso.com — open-source, free tier). Replaces the
// old "type your name" fake signature: the rep gets a real Documenso signing link, and the
// signed, audit-trailed PDF is stored once Documenso's webhook confirms completion (see
// api/documenso-webhook.js).
//
// Uses the Documenso PUBLIC API v1 (stable, "deprecated but will continue to be supported" —
// deliberately NOT the v2 beta, which is still subject to breaking changes).
// Docs: https://docs.documenso.com/docs/developers/api/templates
//
// One-time setup (Documenso dashboard — nothing here can automate this part):
//   1. Create a free Documenso account at https://documenso.com.
//   2. Upload the NDA PDF as a Template, place a signature + date field for one recipient
//      ("Representative"), and note the template's numeric ID (visible in its URL).
//      Repeat for the Non-Compete PDF.
//   3. Settings -> API Tokens -> create a token -> DOCUMENSO_API_KEY (starts "api_...").
//   4. Settings -> Webhooks -> add https://<your-domain>/api/documenso-webhook, event
//      "document.completed", set a secret -> DOCUMENSO_WEBHOOK_SECRET.
//   5. Set these four env vars in Vercel: DOCUMENSO_API_KEY, DOCUMENSO_WEBHOOK_SECRET,
//      DOCUMENSO_NDA_TEMPLATE_ID, DOCUMENSO_NC_TEMPLATE_ID.
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DOCUMENSO_API_KEY,
//   DOCUMENSO_NDA_TEMPLATE_ID, DOCUMENSO_NC_TEMPLATE_ID.

const { createClient } = require('@supabase/supabase-js');

const DOCUMENSO_BASE = 'https://app.documenso.com/api/v1';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DOCUMENSO_API_KEY, DOCUMENSO_NDA_TEMPLATE_ID, DOCUMENSO_NC_TEMPLATE_ID } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'supabase_not_configured' });
  if (!DOCUMENSO_API_KEY) return res.status(503).json({ error: 'documenso_not_configured', detail: 'DOCUMENSO_API_KEY missing in Vercel env vars.' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const doc_type = req.body && req.body.doc_type === 'non_compete' ? 'non_compete' : (req.body && req.body.doc_type === 'nda' ? 'nda' : null);
  if (!doc_type) return res.status(400).json({ error: 'invalid_doc_type', detail: 'doc_type must be "nda" or "non_compete".' });

  const templateId = doc_type === 'nda' ? DOCUMENSO_NDA_TEMPLATE_ID : DOCUMENSO_NC_TEMPLATE_ID;
  if (!templateId) return res.status(503).json({ error: 'template_not_configured', detail: `DOCUMENSO_${doc_type === 'nda' ? 'NDA' : 'NC'}_TEMPLATE_ID missing.` });

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Verify the caller is a real, signed-in user — never trust a client-supplied rep id.
    const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerData || !callerData.user) return res.status(401).json({ error: 'unauthorized' });
    const caller = callerData.user;

    const { data: profile } = await supabaseAdmin.from('profiles').select('full_name').eq('user_id', caller.id).single();
    const name = (profile && profile.full_name) || caller.user_metadata?.full_name || caller.email || 'Sales Rep';
    const email = caller.email;
    if (!email) return res.status(400).json({ error: 'email_required', detail: 'Your account needs a verified email to sign documents.' });

    // Idempotent: reuse the existing row for this rep+doc_type. If already signed, don't
    // create a second Documenso document — just report it's done.
    const { data: existing } = await supabaseAdmin.from('agreements')
      .select('*').eq('rep_id', caller.id).eq('doc_type', doc_type).maybeSingle();

    if (existing && existing.status === 'signed') {
      return res.status(200).json({ ok: true, status: 'signed', signed_pdf_path: existing.signed_pdf_path });
    }
    if (existing && existing.status === 'pending' && existing.signing_url) {
      // Already has an in-flight signing link — resend the same one instead of creating a duplicate.
      return res.status(200).json({ ok: true, status: 'pending', signing_url: existing.signing_url });
    }

    // Upsert the agreement row first so we have a stable id to pass as Documenso's externalId
    // (the webhook uses externalId to match the completed document back to this row).
    const { data: agreement, error: upsertErr } = await supabaseAdmin.from('agreements')
      .upsert({ rep_id: caller.id, doc_type, status: 'pending' }, { onConflict: 'rep_id,doc_type' })
      .select().single();
    if (upsertErr || !agreement) return res.status(500).json({ error: 'agreement_row_failed', detail: upsertErr && upsertErr.message });

    const docRes = await fetch(`${DOCUMENSO_BASE}/templates/${templateId}/create-document`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: DOCUMENSO_API_KEY },
      body: JSON.stringify({
        externalId: agreement.id,
        recipients: [{ name, email }],
      }),
    });
    const docJson = await docRes.json().catch(() => null);
    if (!docRes.ok || !docJson || !docJson.recipients || !docJson.recipients[0]) {
      return res.status(502).json({ error: 'documenso_create_failed', detail: (docJson && (docJson.message || docJson.error)) || `Documenso returned ${docRes.status}` });
    }

    const signingUrl = docJson.recipients[0].signingUrl;
    await supabaseAdmin.from('agreements').update({
      documenso_document_id: docJson.documentId,
      signing_url: signingUrl,
    }).eq('id', agreement.id);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, status: 'pending', signing_url: signingUrl });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
};
