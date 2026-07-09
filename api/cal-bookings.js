// Vercel serverless function — fetches upcoming Cal.com bookings for the admin dashboard's
// calendar/consults sections.
//
// Required env var:
//   CALCOM_API_KEY   (starts cal_live_... or cal_test_... — server-side only, never client-side)
//
// Without it, this returns an empty list and the admin dashboard falls back to demo data,
// same pattern as every other real/demo split in this app.

module.exports = async function handler(req, res) {
  const CALCOM_API_KEY = process.env.CALCOM_API_KEY;
  if (!CALCOM_API_KEY) {
    return res.status(200).json({ configured: false, bookings: [] });
  }

  try {
    const url = 'https://api.cal.com/v1/bookings?apiKey=' + encodeURIComponent(CALCOM_API_KEY) + '&status=upcoming';
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(200).json({ configured: true, bookings: [], error: 'calcom_api_error_' + r.status });
    }
    const data = await r.json();
    const bookings = (data.bookings || []).map(b => ({
      id: b.id,
      title: b.title,
      attendeeName: (b.attendees && b.attendees[0] && b.attendees[0].name) || null,
      attendeeEmail: (b.attendees && b.attendees[0] && b.attendees[0].email) || null,
      start: b.startTime,
      end: b.endTime,
      status: b.status,
    }));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ configured: true, bookings });
  } catch (e) {
    return res.status(200).json({ configured: true, bookings: [], error: String((e && e.message) || e) });
  }
};
