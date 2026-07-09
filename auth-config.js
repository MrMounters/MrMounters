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
   1. SQL Editor → New query → paste the contents of supabase-schema.sql → Run (safe to
      re-run any time — every CREATE POLICY is preceded by DROP POLICY IF EXISTS, and table/
      column changes use IF NOT EXISTS). Creates deals/agreements/academy_progress (rep side),
      profiles/domains/change_requests (client side), and leads (staff side).
   2. Authentication → Providers → enable Email ("Email OTP / Magic Link") and Phone (SMS —
      needs an SMS provider like Twilio connected under this same Providers page). Login.html
      only offers Email + SMS now — no password, no OAuth.
   3. Authentication → URL Configuration → set Site URL to your real domain (not the default
      localhost:3000 — a wrong Site URL is why magic links can silently fail with
      otp_expired/access_denied), and add <your-site>/login.html, /portal.html, /rep.html,
      /admin.html, and /onboarding.html to the Redirect URLs allow list.
   4. Authentication → Email Templates → paste the branded HTML from email-templates/*.html
      into "Confirm signup", "Magic Link", and "Invite user" (replacing Supabase's plain
      default templates).

   ROLES: every new signup automatically gets a `profiles` row with role='client' and
   lands in portal.html. There is no self-service way to become a rep or admin — to promote
   someone, open Table Editor → profiles, find their row (match by user_id — cross-reference
   Authentication → Users to find the email), and set role to 'rep' or 'admin'. They'll land
   in rep.html or admin.html on their next sign-in. New client accounts land on
   onboarding.html first (collects name/phone/company) before portal.html unlocks.
   The demo account (the "Try the demo portal" link on login.html) bypasses all of this —
   it's a pure frontend demo with no real backend. */
