// Vercel serverless function — Documenso webhook receiver. On document.completed, downloads
// the signed, audit-trailed PDF and stores it in Supabase (private rep-docs bucket), then
// marks the matching agreements row as signed. This is the only place a NDA/Non-Compete is
// ever marked "signed" — the browser can never set that status itself.
//
// Verification: Documenso sends the configured webhook secret back in the X-Documenso-Secret
// header on every request; we compare it (constant-time) against DOCUMENSO_WEBHOOK_SECRET.
// Docs: https://docs.documenso.com/developers/webhooks
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DOCUMENSO_API_KEY,
//   DOCUMENSO_WEBHOOK_SECRET.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const DOCUMENSO_BASE = 'https://app.documenso.com/api/v1';

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DOCUMENSO_API_KEY, DOCUMENSO_WEBHOOK_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DOCUMENSO_API_KEY || !DOCUMENSO_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'documenso_webhook_not_configured' });
  }

  const providedSecret = req.headers['x-documenso-secret'];
  if (!safeEqual(providedSecret, DOCUMENSO_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const body = req.body || {};
  const event = body.event;
  const payload = body.payload;

  // We only act on completed signatures; ack everything else so Documenso doesn't retry.
  if (event !== 'document.completed' || !payload) {
    return res.status(200).json({ received: true, ignored: true });
  }

  const agreementId = payload.externalId;
  const documensoDocumentId = payload.id;
  if (!agreementId) {
    // Not one of our agreement documents (no externalId set) — nothing to match, ack and skip.
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: agreement, error: findErr } = await supabaseAdmin.from('agreements').select('*').eq('id', agreementId).single();
    if (findErr || !agreement) {
      console.error('documenso webhook: agreement not found for externalId', agreementId);
      return res.status(200).json({ received: true, ignored: true }); // ack — retrying won't help if the row is gone
    }
    if (agreement.status === 'signed') {
      return res.status(200).json({ received: true, already_signed: true }); // idempotent — duplicate webhook delivery
    }

    // Fetch the completed, signed PDF from Documenso and store it privately.
    const dlRes = await fetch(`${DOCUMENSO_BASE}/documents/${documensoDocumentId}/download`, {
      headers: { Authorization: DOCUMENSO_API_KEY },
    });
    const dlJson = await dlRes.json().catch(() => null);
    if (!dlRes.ok || !dlJson || !dlJson.downloadUrl) {
      console.error('documenso webhook: could not get download URL', dlJson);
      return res.status(500).json({ error: 'download_url_failed' }); // non-200 -> Documenso retries
    }

    const pdfRes = await fetch(dlJson.downloadUrl);
    if (!pdfRes.ok) {
      console.error('documenso webhook: PDF fetch failed', pdfRes.status);
      return res.status(500).json({ error: 'pdf_fetch_failed' });
    }
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

    const path = `${agreement.rep_id}/${agreement.doc_type}-signed.pdf`;
    const { error: uploadErr } = await supabaseAdmin.storage.from('rep-docs')
      .upload(path, pdfBuffer, { upsert: true, contentType: 'application/pdf' });
    if (uploadErr) {
      console.error('documenso webhook: storage upload failed', uploadErr.message);
      return res.status(500).json({ error: 'storage_upload_failed' });
    }

    await supabaseAdmin.from('agreements').update({
      status: 'signed',
      signed_at: new Date().toISOString(),
      signed_pdf_path: path,
      documenso_document_id: documensoDocumentId,
    }).eq('id', agreement.id);

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('documenso webhook error', e);
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e) });
  }
};
