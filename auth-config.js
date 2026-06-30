/* ────────────────────────────────────────────────────────────
   SUPABASE CONFIG  —  edit these two values, nothing else.
   Find them in your Supabase dashboard:
     Project Settings → API → Project URL  and  Project API keys → anon / public
   The anon key is safe to expose in the browser (it is protected by
   Row Level Security). Do NOT paste the service_role key here.
   ──────────────────────────────────────────────────────────── */
window.SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
window.SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

/* After filling these in, also do this once in the Supabase dashboard:
   1. Authentication → Providers → enable Google, Apple, Azure (Microsoft),
      Phone (SMS), and Email (turn on "Email OTP / Magic Link").
   2. Authentication → URL Configuration → add your site URL and
      <your-site>/portal.html to the "Redirect URLs" allow list.
   3. For SMS you'll need an SMS provider (e.g. Twilio) connected in Supabase. */
