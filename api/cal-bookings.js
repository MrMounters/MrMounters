// Vercel serverless function — fetches upcoming Cal.com bookings for the admin dashboard's
// calendar/consults sections.
//
// Required env var:
//   CALCOM_API_KEY   (starts cal_live_... or cal_test_... — server-side only, never client-side)
//
// Without it, this returns an empty list and the admin dashboard falls back to demo data,
// same pattern as every other real/demo split in this app.
//
// Uses Cal.com API v2 (v1 was fully removed in early 2026 — this originally shipped against
// v1's `?apiKey=` query-string auth, which is why it stopped working). v2 needs a Bearer
// token and a dated `cal-api-version` header; Cal.com can bump that date and break this
// silently, so if bookings stop showing up again, that header is the first thing to check
// against https://cal.com/docs/api-reference/v2/bookings/get-all-bookings.
const CAL_API_VERSION = '2024-08-13';

module.exports = async function handler(req, res) {
  const CALCOM_API_KEY = process.env.CALCOM_API_KEY;
  if (!CALCOM_API_KEY) {
    return res.status(200).json({ configured: false, bookings: [] });
  }

  try {
    const url = 'https://api.cal.com/v2/bookings?status=upcoming&take=25';
    const r = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + CALCOM_API_KEY,
        'cal-api-version': CAL_API_VERSION,
      },
    });
    if (!r.ok) {
      return res.status(200).json({ configured: true, bookings: [], error: 'calcom_api_error_' + r.status });
    }
    const data = await r.json();
    const list = data.data || data.bookings || [];
    const bookings = list.map(b => ({
      id: b.id || b.uid,
      title: b.title,
      attendeeName: (b.attendees && b.attendees[0] && b.attendees[0].name) || null,
      attendeeEmail: (b.attendees && b.attendees[0] && b.attendees[0].email) || null,
      start: b.start || b.startTime,
      end: b.end || b.endTime,
      status: b.status,
    }));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ configured: true, bookings });
  } catch (e) {
    return res.status(200).json({ configured: true, bookings: [], error: String((e && e.message) || e) });
  }
};
