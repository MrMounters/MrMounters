/* ────────────────────────────────────────────────────────────
   SUPABASE CONFIG  —  edit these two values, nothing else.
   Find them in your Supabase dashboard:
     Project Settings → API → Project URL  and  Project API keys → anon / public
   The anon key is safe to expose in the browser (it is protected by
   Row Level Security). Do NOT paste the service_role key here.
   ──────────────────────────────────────────────────────────── */
window.SUPABASE_URL = 'https://yvyreidpysqawormbvwy.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2eXJlaWRweXNxYXdvcm1idnd5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyNzkxNzAsImV4cCI6MjA5Nzg1NTE3MH0.TD_2NS4frYtXQn4N0gxe_G15A7apSdH_V67BBOrm8lY';

/* After filling these in:
   1. SQL Editor → New query → paste the contents of supabase-schema.sql → Run.
      This creates deals/agreements/academy_progress (rep side) AND profiles/domains/
      change_requests (client side), all with Row Level Security already scoped per user.
   2. Authentication → Providers → enable Google, Apple, Azure (Microsoft),
      Phone (SMS), and Email (turn on "Email OTP / Magic Link").
   3. Authentication → URL Configuration → add your site URL and
      <your-site>/portal.html + <your-site>/rep.html to the "Redirect URLs" allow list.
   4. For SMS you'll need an SMS provider (e.g. Twilio) connected in Supabase.

   ROLES: every new signup automatically gets a `profiles` row with role='client' and
   lands in portal.html. There is no self-service way to become a sales rep — to promote
   someone, open Table Editor → profiles, find their row (match by user_id — cross-reference
   Authentication → Users to find the email), and change role to 'rep'. They'll land in
   rep.html on their next sign-in. The demo accounts (user@user.com / password1 on either
   login screen) bypass all of this — they're pure frontend demos with no real backend. */
