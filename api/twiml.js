// Vercel serverless function — TwiML that bridges the browser call to a real phone number.
// Point your Twilio TwiML App's Voice URL here: https://<your-domain>/api/twiml
// Set TWILIO_CALLER_ID to a Twilio number you own (E.164, e.g. +14805890098).

module.exports = function handler(req, res) {
  const twilio = require('twilio');
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const vr = new VoiceResponse();

  const to = (req.body && req.body.To) || (req.query && req.query.To);
  const callerId = process.env.TWILIO_CALLER_ID;

  if (to) {
    const dial = vr.dial(callerId ? { callerId } : {});
    // If "To" looks like a phone number, dial it; otherwise treat as a client identity.
    if (/^[\d+\-().\s]+$/.test(to)) dial.number(to);
    else dial.client(to);
  } else {
    vr.say('No destination number was provided.');
  }

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(vr.toString());
};
