// Vercel serverless function — issues a short-lived Twilio Voice access token
// so a rep can place calls from the browser dialer.
//
// Set these Environment Variables in Vercel (Project → Settings → Environment Variables):
//   TWILIO_ACCOUNT_SID    (starts AC...)
//   TWILIO_API_KEY        (starts SK...)   — create under Account → API keys
//   TWILIO_API_SECRET
//   TWILIO_TWIML_APP_SID  (starts AP...)   — a TwiML App whose Voice URL points to /api/twiml
//
// Without these, the dialer falls back to the device's phone (tel:) automatically.

module.exports = function handler(req, res) {
  const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET || !TWILIO_TWIML_APP_SID) {
    return res.status(503).json({ error: 'twilio_not_configured' });
  }
  try {
    const twilio = require('twilio');
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const identity = (req.query && req.query.identity) || 'rep';

    const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, { identity });
    token.addGrant(new VoiceGrant({ outgoingApplicationSid: TWILIO_TWIML_APP_SID, incomingAllow: false }));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ token: token.toJwt(), identity });
  } catch (e) {
    return res.status(500).json({ error: 'token_error', detail: String(e && e.message || e) });
  }
};
