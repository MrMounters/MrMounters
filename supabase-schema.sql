-- ============================================================
-- Meridion AI — Supabase schema
-- Run this once in your Supabase project: SQL Editor → New query → Run.
-- Then put your Project URL + anon key in auth-config.js.
-- ============================================================

-- ---------- keep updated_at fresh (used by several tables below) ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

-- ============================================================
-- PROFILES (client / rep / admin role) — defined first since almost every
-- other table's staff-access policy needs to check the caller's role here.
-- ============================================================
create table if not exists public.profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  role          text not null default 'client' check (role in ('client','rep','admin')),
  business_name text,
  created_at    timestamptz default now()
);

alter table public.profiles enable row level security;

-- A user can only see and edit their own profile row.
drop policy if exists "profiles are private to the user" on public.profiles;
create policy "profiles are private to the user"
  on public.profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Role-check helper, used by every "staff can manage everything" policy in this file.
-- MUST be security definer: without it, a policy that queries profiles from within another
-- policy ON profiles (like the staff-view-all policy below) causes Postgres to re-evaluate
-- profiles' own RLS on the inner query — which re-triggers the same policy — infinite
-- recursion ("infinite recursion detected in policy for relation profiles"). A security
-- definer function runs as its owner and bypasses RLS internally, breaking that cycle.
create or replace function public.current_user_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from public.profiles where user_id = auth.uid();
$$;

-- Staff can also VIEW every profile (needed for admin.html to show client names against
-- leads/projects/onboarding progress).
drop policy if exists "staff can view all profiles" on public.profiles;
create policy "staff can view all profiles"
  on public.profiles for select
  using (public.current_user_role() in ('rep','admin'));

-- Auto-create a profile (default role 'client') for every new signup.
-- To make someone a rep: Table Editor → profiles → find their user_id → set role to 'rep'.
-- There is no self-service way to become a rep — this is intentional.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id) values (new.id);
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- One-time backfill: give a 'client' profile to any account that signed up before this
-- table existed (the trigger above only fires on new signups going forward).
insert into public.profiles (user_id)
select id from auth.users
where id not in (select user_id from public.profiles)
on conflict (user_id) do nothing;

-- Extra profile fields collected at account setup (invited client clicks the invite link,
-- which authenticates them, then fills these in on onboarding.html before the portal
-- dashboard unlocks). business_name above doubles as "Company name" here.
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists terms_accepted_at timestamptz;

-- ============================================================
-- COMPANIES — a client can run more than one business under one login, each with its own
-- fully separate project (switched via the dropdown under their business name in
-- portal.html's menu). profiles.business_name above becomes just the FIRST company's name,
-- kept for backward compatibility; companies is the real source of truth going forward.
-- ============================================================
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  created_at  timestamptz default now()
);

alter table public.companies enable row level security;

drop policy if exists "clients manage their own companies" on public.companies;
create policy "clients manage their own companies"
  on public.companies for all
  using (auth.uid() = client_id)
  with check (auth.uid() = client_id);

drop policy if exists "staff manage all companies" on public.companies;
create policy "staff manage all companies"
  on public.companies for all
  using (public.current_user_role() in ('rep','admin'))
  with check (public.current_user_role() in ('rep','admin'));

-- One-time backfill: give every existing client a company from their profile's business_name,
-- so pre-existing accounts aren't left companyless when this feature ships.
insert into public.companies (client_id, name)
select p.user_id, coalesce(nullif(p.business_name, ''), 'My Company')
from public.profiles p
where p.role = 'client'
  and not exists (select 1 from public.companies c where c.client_id = p.user_id);

-- ---------- DEALS (sales rep pipeline) ----------
create table if not exists public.deals (
  id          uuid primary key default gen_random_uuid(),
  rep_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  contact     text not null,
  business    text,
  service     text,
  value       numeric default 0,
  stage       text not null default 'New',   -- New | Contacted | Quoted | Won | Lost
  notes       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table public.deals enable row level security;

-- A rep can only see and manage their own deals.
drop policy if exists "deals are private to the rep" on public.deals;
create policy "deals are private to the rep"
  on public.deals for all
  using (auth.uid() = rep_id)
  with check (auth.uid() = rep_id);

create index if not exists deals_rep_idx on public.deals(rep_id, updated_at desc);

-- Admins see and manage every rep's deals (needed for the admin dashboard's
-- business-wide Deals/Projects view). Multiple permissive policies on a table
-- are OR'd together, so this adds to — doesn't replace — the rep-private policy above.
drop policy if exists "admins manage all deals" on public.deals;
create policy "admins manage all deals"
  on public.deals for all
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

drop trigger if exists deals_touch on public.deals;
create trigger deals_touch before update on public.deals
  for each row execute function public.touch_updated_at();

-- ---------- AGREEMENTS (NDA / non-compete signatures) ----------
create table if not exists public.agreements (
  id          uuid primary key default gen_random_uuid(),
  rep_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  doc_type    text not null,                  -- 'nda' | 'non_compete'
  signed_name text not null,
  signed_at   timestamptz default now()
);

alter table public.agreements enable row level security;

drop policy if exists "agreements are private to the rep" on public.agreements;
create policy "agreements are private to the rep"
  on public.agreements for all
  using (auth.uid() = rep_id)
  with check (auth.uid() = rep_id);

-- ---------- STORAGE: rep tax docs (W-9 / 1099) ----------
-- Create a PRIVATE bucket named "rep-docs" (Storage → New bucket, public = off).
insert into storage.buckets (id, name, public)
values ('rep-docs', 'rep-docs', false)
on conflict (id) do nothing;

-- Each rep can only read/write files under a folder named with their own user id:
drop policy if exists "reps manage their own docs" on storage.objects;
create policy "reps manage their own docs"
  on storage.objects for all
  using (bucket_id = 'rep-docs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'rep-docs' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- ACADEMY PROGRESS (rep training modules) ----------
create table if not exists public.academy_progress (
  rep_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  module_id   text not null,                  -- 'm0'..'m4'
  completed_at timestamptz default now(),
  primary key (rep_id, module_id)
);

alter table public.academy_progress enable row level security;

drop policy if exists "academy progress is private to the rep" on public.academy_progress;
create policy "academy progress is private to the rep"
  on public.academy_progress for all
  using (auth.uid() = rep_id)
  with check (auth.uid() = rep_id);

-- ---------- DOMAINS (client-owned, read-only from the client portal) ----------
create table if not exists public.domains (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  domain_name text not null,
  status      text not null default 'active',    -- active | redirect | pending
  ssl_status  text not null default 'valid',      -- valid | expiring | none
  renews_at   date,
  created_at  timestamptz default now()
);

alter table public.domains enable row level security;

drop policy if exists "clients see only their own domains" on public.domains;
create policy "clients see only their own domains"
  on public.domains for select
  using (auth.uid() = client_id);

-- Rows are added by staff (Table Editor / future admin tool), not by clients themselves —
-- no insert/update/delete policy is granted to clients on purpose.

-- ---------- CHANGE REQUESTS (client-submitted site edits) ----------
create table if not exists public.change_requests (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  request_text text not null,
  priority     text default 'Normal priority',
  status       text not null default 'Received',  -- Received | In progress | Done
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

alter table public.change_requests enable row level security;

drop policy if exists "clients manage their own requests" on public.change_requests;
create policy "clients manage their own requests"
  on public.change_requests for all
  using (auth.uid() = client_id)
  with check (auth.uid() = client_id);

drop trigger if exists change_requests_touch on public.change_requests;
create trigger change_requests_touch before update on public.change_requests
  for each row execute function public.touch_updated_at();

-- ============================================================
-- ADMIN — leads (staff-only, feeds the admin dashboard)
-- ============================================================
create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null,
  email       text not null,
  phone       text,
  business    text,
  status      text not null default 'New',   -- New | Contacted | Meeting Set | Invited | Converted
  notes       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table public.leads enable row level security;

-- ============================================================
-- AI LEAD BRIEFS — server-generated internal follow-up drafts for audit leads.
-- The browser never receives the service-role credentials or OpenAI key. Public visitors
-- cannot read this table; staff access is enforced by the policy below.
-- ============================================================
create table if not exists public.ai_lead_briefs (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads(id) on delete cascade,
  website_url text not null,
  email       text not null,
  brief       jsonb not null default '{}'::jsonb,
  model       text,
  status      text not null default 'completed' check (status in ('completed','fallback','not_configured')),
  created_at  timestamptz not null default now()
);
alter table public.ai_lead_briefs enable row level security;
revoke all on table public.ai_lead_briefs from anon, authenticated;
grant select on table public.ai_lead_briefs to authenticated;
grant select, insert, update, delete on table public.ai_lead_briefs to service_role;
create index if not exists ai_lead_briefs_email_url_created_idx
  on public.ai_lead_briefs(email, website_url, created_at desc);

drop policy if exists "admins manage ai lead briefs" on public.ai_lead_briefs;
create policy "admins manage ai lead briefs"
  on public.ai_lead_briefs for all to authenticated
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- Only staff (rep or admin) can see/manage leads — clients never touch this table.
drop policy if exists "staff manage leads" on public.leads;
create policy "staff manage leads"
  on public.leads for all
  using (public.current_user_role() in ('rep','admin'))
  with check (public.current_user_role() in ('rep','admin'));

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();

-- Lets a newly-invited client's own session read (SELECT only) the lead record that matches
-- their own email, so onboarding.html can pre-fill name/phone/company we already collected —
-- without granting them any access to other leads.
drop policy if exists "users can read their own matching lead" on public.leads;
create policy "users can read their own matching lead"
  on public.leads for select
  using (lower(email) = lower(auth.jwt() ->> 'email'));

-- ============================================================
-- PROJECTS — feeds the client portal dashboard's status card + timeline,
-- and gates the "Start Setup" 12-step onboarding wizard.
-- ============================================================
create table if not exists public.projects (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references auth.users(id) on delete cascade,
  company_id        uuid references public.companies(id) on delete set null,
  name              text not null default 'Website Redesign',
  status            text not null default 'Project Setup',
  -- Each item: {"label": "...", "done": bool, "current": bool (optional)}
  timeline          jsonb not null default '[
    {"label":"Discovery Call","done":true},
    {"label":"Contract Signed","done":true},
    {"label":"Deposit Paid","done":true},
    {"label":"Complete Setup","done":false,"current":true},
    {"label":"Homepage Design","done":false},
    {"label":"Development","done":false},
    {"label":"Launch","done":false}
  ]'::jsonb,
  estimated_launch  date,
  setup_complete    boolean not null default false,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- Existing installs: add the column and backfill every project onto its client's
-- (single, just-backfilled-above) company, so nothing is left unlinked.
alter table public.projects add column if not exists company_id uuid references public.companies(id) on delete set null;
update public.projects pr set company_id = c.id
from public.companies c
where pr.company_id is null and pr.client_id = c.client_id;

alter table public.projects enable row level security;

-- Clients can view their own project(s), read-only — rows are created/managed by staff
-- (Table Editor / admin.html), same pattern as domains.
drop policy if exists "clients see only their own projects" on public.projects;
create policy "clients see only their own projects"
  on public.projects for select
  using (auth.uid() = client_id);

drop policy if exists "staff manage all projects" on public.projects;
create policy "staff manage all projects"
  on public.projects for all
  using (public.current_user_role() in ('rep','admin'))
  with check (public.current_user_role() in ('rep','admin'));

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

-- Clients can also update their own project row — needed so submitting the setup wizard can
-- flip setup_complete and advance the timeline client-side, same trust level already given
-- for change_requests.
drop policy if exists "clients can update their own project" on public.projects;
create policy "clients can update their own project"
  on public.projects for update
  using (auth.uid() = client_id)
  with check (auth.uid() = client_id);

-- And insert one for themselves — covers the case where staff never pre-created a project
-- row before the client finished onboarding (setup.html creates one on submit if missing).
drop policy if exists "clients can create their own project" on public.projects;
create policy "clients can create their own project"
  on public.projects for insert
  with check (auth.uid() = client_id);

-- ============================================================
-- PROJECT SETUP — the 12-step client onboarding wizard (setup.html)
-- ============================================================
create table if not exists public.project_setup (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid references public.projects(id) on delete cascade,
  client_id     uuid not null references auth.users(id) on delete cascade,
  data          jsonb not null default '{}'::jsonb,   -- keyed by step: {business:{...}, goals:{...}, ...}
  current_step  int not null default 1,
  submitted     boolean not null default false,
  submitted_at  timestamptz,
  -- Manual admin override of portal-lock state, independent of `submitted`. NULL = automatic
  -- (locked until submitted), true = force-unlocked, false = force-locked. Set from admin.html's
  -- Clients panel; read by portal.html's loadProject() alongside the normal `submitted` check.
  admin_lock_override boolean default null,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
alter table public.project_setup add column if not exists admin_lock_override boolean default null;

alter table public.project_setup enable row level security;

-- A client fully owns their own setup row (insert/select/update as they progress).
drop policy if exists "clients manage their own project setup" on public.project_setup;
create policy "clients manage their own project setup"
  on public.project_setup for all
  using (auth.uid() = client_id)
  with check (auth.uid() = client_id);

drop policy if exists "staff view all project setup" on public.project_setup;
create policy "staff view all project setup"
  on public.project_setup for select
  using (public.current_user_role() in ('rep','admin'));

-- Staff can edit a client's submitted answers and flip the manual lock override
-- (admin.html's Clients detail panel).
drop policy if exists "staff update all project setup" on public.project_setup;
create policy "staff update all project setup"
  on public.project_setup for update
  using (public.current_user_role() in ('rep','admin'))
  with check (public.current_user_role() in ('rep','admin'));

drop trigger if exists project_setup_touch on public.project_setup;
create trigger project_setup_touch before update on public.project_setup
  for each row execute function public.touch_updated_at();

-- ---------- STORAGE: client-uploaded setup assets (logo, brand guide, photos, videos) ----------
-- Create a PRIVATE bucket named "client-assets" (Storage → New bucket, public = off).
insert into storage.buckets (id, name, public)
values ('client-assets', 'client-assets', false)
on conflict (id) do nothing;

-- Each client can only read/write files under a folder named with their own user id —
-- same pattern as the "reps manage their own docs" policy above.
drop policy if exists "clients manage their own setup assets" on storage.objects;
create policy "clients manage their own setup assets"
  on storage.objects for all
  using (bucket_id = 'client-assets' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'client-assets' and (storage.foldername(name))[1] = auth.uid()::text);

-- Staff can manage files in ANY client's folder too — needed so admin.html can upload a
-- homepage design mockup into a client's own asset folder for them to review.
drop policy if exists "staff manage all client assets" on storage.objects;
create policy "staff manage all client assets"
  on storage.objects for all
  using (bucket_id = 'client-assets' and public.current_user_role() in ('rep','admin'))
  with check (bucket_id = 'client-assets' and public.current_user_role() in ('rep','admin'));

-- ============================================================
-- PROJECT STAGES — the real, interactive project pipeline. Each project gets 7 rows
-- (seeded automatically below) covering its full delivery lifecycle. This replaces
-- projects.timeline as the source of truth for the dashboard's timeline display —
-- that jsonb column stays for backward compatibility but the app no longer reads it.
--
-- Per-stage interactivity (built into portal.html / admin.html, not enforced by SQL):
--   business_profile_setup — client fills out the 12-step wizard (setup.html). This is the
--                       ONLY place in the client portal that links to setup.html — every
--                       other "go finish your setup" shortcut was removed so there's a
--                       single, unambiguous entry point. Mirrors project_setup.submitted,
--                       marked done automatically on wizard submit.
--   discovery_call   — client books via the Cal.com link shown on this stage; admin marks
--                       it done once the consult has actually happened
--   contract_signed  — client types their name to sign (data.signed_name/signed_at)
--   deposit_paid     — client pays via Stripe; ONLY the webhook (service_role, bypasses
--                       RLS) marks this done — client-side code can create a checkout
--                       session but can never mark payment as complete itself
--   in_progress      — we're actively building the site; admin posts progress via
--                       client_note, no client action
--   approval         — admin uploads a preview (data.image_path), client approves or
--                       requests a revision (data.decision/revision_notes)
--   launch           — admin marks done, optionally sets data.live_url
--
-- The rest of the client portal (Inbox, AI Voice/Chat, Visitors, Billing, Files, Domains,
-- Change Requests) stays teaser-locked until the `launch` stage is done/approved — NOT just
-- once setup is submitted. Staff can override this per-client at any point in the timeline
-- via project_setup.admin_lock_override (see below).
-- ============================================================
create table if not exists public.project_stages (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  client_id     uuid not null references auth.users(id) on delete cascade,
  stage_key     text not null,   -- business_profile_setup | discovery_call | contract_signed | deposit_paid | in_progress | approval | launch
  label         text not null,
  stage_order   int not null,
  status        text not null default 'pending' check (status in ('pending','in_progress','needs_review','revision_requested','approved','done')),
  client_note   text,            -- admin-written status message shown to the client
  admin_note    text,            -- staff-only internal notes
  data          jsonb not null default '{}'::jsonb,  -- stage-specific extras, see comment above
  due_date      date,
  completed_at  timestamptz,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table public.project_stages enable row level security;

-- Clients can view and update (not insert/delete — stages are seeded automatically) their
-- own project's stages, needed for the client-driven actions above (signing, approving).
drop policy if exists "clients manage their own project stages" on public.project_stages;
create policy "clients manage their own project stages"
  on public.project_stages for select
  using (auth.uid() = client_id);

drop policy if exists "clients can update their own project stages" on public.project_stages;
create policy "clients can update their own project stages"
  on public.project_stages for update
  using (auth.uid() = client_id)
  with check (auth.uid() = client_id);

drop policy if exists "staff manage all project stages" on public.project_stages;
create policy "staff manage all project stages"
  on public.project_stages for all
  using (public.current_user_role() in ('rep','admin'))
  with check (public.current_user_role() in ('rep','admin'));

drop trigger if exists project_stages_touch on public.project_stages;
create trigger project_stages_touch before update on public.project_stages
  for each row execute function public.touch_updated_at();

-- Auto-seed the 7 default stages whenever a project is created — whether by staff
-- (admin.html) or by a client's own setup.html submission auto-creating one.
create or replace function public.seed_project_stages()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  stages jsonb := '[
    {"key":"business_profile_setup","label":"Business Profile Setup"},
    {"key":"discovery_call","label":"Discovery Call"},
    {"key":"contract_signed","label":"Contract"},
    {"key":"deposit_paid","label":"Deposit"},
    {"key":"in_progress","label":"In Progress"},
    {"key":"approval","label":"Approval"},
    {"key":"launch","label":"Launch & Deploy"}
  ]'::jsonb;
  s jsonb;
  i int := 0;
begin
  for s in select * from jsonb_array_elements(stages) loop
    insert into public.project_stages (project_id, client_id, stage_key, label, stage_order)
    values (new.id, new.client_id, s->>'key', s->>'label', i);
    i := i + 1;
  end loop;
  return new;
end; $$;

drop trigger if exists on_project_created on public.projects;
create trigger on_project_created after insert on public.projects
  for each row execute function public.seed_project_stages();

-- One-time backfill: seed stages for any project created before this table existed.
insert into public.project_stages (project_id, client_id, stage_key, label, stage_order)
select p.id, p.client_id, s.key, s.label, s.ord
from public.projects p
cross join (values
  ('business_profile_setup','Business Profile Setup',0), ('discovery_call','Discovery Call',1),
  ('contract_signed','Contract',2), ('deposit_paid','Deposit',3),
  ('in_progress','In Progress',4), ('approval','Approval',5),
  ('launch','Launch & Deploy',6)
) as s(key, label, ord)
where not exists (select 1 from public.project_stages ps where ps.project_id = p.id);

-- Migration: earlier installs seeded stages under the old key names/labels/order below —
-- relabel and re-key any rows created before this pass (idempotent: a second run finds no
-- rows still using the old key names and is a no-op).
update public.project_stages set stage_key = 'in_progress', label = 'In Progress', stage_order = 4 where stage_key = 'development';
update public.project_stages set stage_key = 'approval', label = 'Approval', stage_order = 5 where stage_key = 'homepage_design';
update public.project_stages set label = 'Contract' where stage_key = 'contract_signed' and label = 'Contract Signed';
update public.project_stages set label = 'Deposit' where stage_key = 'deposit_paid' and label = 'Deposit Paid';
update public.project_stages set label = 'Launch & Deploy' where stage_key = 'launch' and label = 'Launch';

-- Migration: Business Profile Setup (the 12-step wizard) moved from position 4 to position 1
-- — it's now the very first thing a client does, before their discovery call is even
-- scheduled. Re-key/relabel any rows still on the old name, then fix stage_order for every
-- stage in the pipeline to match the new sequence (idempotent — a second run is a no-op).
update public.project_stages set stage_key = 'business_profile_setup', label = 'Business Profile Setup' where stage_key = 'complete_setup';
update public.project_stages set stage_order = 0 where stage_key = 'business_profile_setup';
update public.project_stages set stage_order = 1 where stage_key = 'discovery_call';
update public.project_stages set stage_order = 2 where stage_key = 'contract_signed';
update public.project_stages set stage_order = 3 where stage_key = 'deposit_paid';
update public.project_stages set stage_order = 4 where stage_key = 'in_progress';
update public.project_stages set stage_order = 5 where stage_key = 'approval';
update public.project_stages set stage_order = 6 where stage_key = 'launch';

-- The reorder above can leave a project's timeline reading out of sequence: e.g. Discovery
-- Call was completed back when IT was stage 1 (before Business Profile Setup existed), so it
-- shows done while the new stage 1 is still pending — a stage that comes later than an
-- unfinished one has no business showing as done. Enforce the invariant that a stage can only
-- be done/approved if every earlier-order stage in the same project is too (idempotent — once
-- consistent, this finds nothing to fix).
update public.project_stages ps
set status = 'pending', completed_at = null
where ps.status in ('done','approved')
  and exists (
    select 1 from public.project_stages earlier
    where earlier.project_id = ps.project_id
      and earlier.stage_order < ps.stage_order
      and earlier.status not in ('done','approved')
  );

-- ============================================================
-- NOTIFICATIONS — staff-facing feed of client-driven project events (admin.html's bell).
-- Populated automatically by a trigger on project_stages, not written to directly by the
-- app, so every client action that changes a stage's status is guaranteed to surface here
-- regardless of which code path triggered it (e.g. a revision request previously had no
-- signal on the admin side at all).
-- ============================================================
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references public.projects(id) on delete cascade,
  stage_id     uuid references public.project_stages(id) on delete cascade,
  client_id    uuid references auth.users(id) on delete cascade,
  title        text not null,
  body         text,
  read         boolean not null default false,
  created_at   timestamptz default now()
);

alter table public.notifications enable row level security;

drop policy if exists "staff manage all notifications" on public.notifications;
create policy "staff manage all notifications"
  on public.notifications for all
  using (public.current_user_role() in ('rep','admin'))
  with check (public.current_user_role() in ('rep','admin'));

create or replace function public.notify_stage_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  proj_name text;
begin
  if new.status = old.status then return new; end if;
  -- Only notify staff about CLIENT-driven transitions. auth.uid() is the client's own id
  -- when they make the change themselves in the portal, or null when the Stripe webhook
  -- (service_role, bypasses RLS) confirms a deposit payment on their behalf. A staff member
  -- editing a stage from admin.html (auth.uid() = their own id, never new.client_id) never
  -- generates a notification for its own action.
  if not (auth.uid() is null or auth.uid() = new.client_id) then return new; end if;

  select name into proj_name from public.projects where id = new.project_id;
  proj_name := coalesce(proj_name, 'Project');

  if new.stage_key = 'business_profile_setup' and new.status in ('done','approved') then
    insert into public.notifications (project_id, stage_id, client_id, title, body)
    values (new.project_id, new.id, new.client_id, proj_name || ' — business profile submitted', null);
  elsif new.stage_key = 'discovery_call' and new.status = 'in_progress' then
    insert into public.notifications (project_id, stage_id, client_id, title, body)
    values (new.project_id, new.id, new.client_id, proj_name || ' — discovery call requested', null);
  elsif new.stage_key = 'contract_signed' and new.status in ('done','approved') then
    insert into public.notifications (project_id, stage_id, client_id, title, body)
    values (new.project_id, new.id, new.client_id, proj_name || ' — contract signed', 'Signed by ' || coalesce(new.data->>'signed_name', 'client'));
  elsif new.stage_key = 'deposit_paid' and new.status in ('done','approved') then
    insert into public.notifications (project_id, stage_id, client_id, title, body)
    values (new.project_id, new.id, new.client_id, proj_name || ' — deposit paid', null);
  elsif new.stage_key = 'approval' and new.status = 'revision_requested' then
    insert into public.notifications (project_id, stage_id, client_id, title, body)
    values (new.project_id, new.id, new.client_id, proj_name || ' — revision requested', new.data->>'revision_notes');
  elsif new.stage_key = 'approval' and new.status in ('done','approved') then
    insert into public.notifications (project_id, stage_id, client_id, title, body)
    values (new.project_id, new.id, new.client_id, proj_name || ' — design approved', null);
  end if;
  return new;
end; $$;

drop trigger if exists on_stage_status_change on public.project_stages;
create trigger on_stage_status_change after update on public.project_stages
  for each row execute function public.notify_stage_change();

-- ============================================================
-- MESSAGES — real two-way chat backing the client portal's "Team Chat" and "Meridion
-- Support" inbox tabs, and admin.html's Messages page. `project_id` is nullable so a client
-- can reach Support even before they have a project yet; `channel` keeps the two threads
-- (team vs. support) separate within the same client's conversation history.
-- ============================================================
create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references public.projects(id) on delete cascade,
  client_id    uuid not null references auth.users(id) on delete cascade,
  channel      text not null default 'team' check (channel in ('team','support')),
  sender_role  text not null check (sender_role in ('client','staff')),
  sender_name  text,
  body         text not null,
  created_at   timestamptz default now()
);

alter table public.messages enable row level security;

-- A client owns their whole conversation history (both channels) — read/send freely.
drop policy if exists "clients manage their own messages" on public.messages;
create policy "clients manage their own messages"
  on public.messages for all
  using (auth.uid() = client_id)
  with check (auth.uid() = client_id);

-- Staff can read and reply into ANY client's thread (admin.html's Messages page).
drop policy if exists "staff manage all messages" on public.messages;
create policy "staff manage all messages"
  on public.messages for all
  using (public.current_user_role() in ('rep','admin'))
  with check (public.current_user_role() in ('rep','admin'));

-- Notify staff (reusing the same notifications feed/bell as stage changes) whenever a
-- client sends a new message — a staff reply doesn't notify itself.
create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  label text;
begin
  if new.sender_role <> 'client' then return new; end if;
  if new.project_id is not null then
    select name into label from public.projects where id = new.project_id;
  end if;
  if label is null then
    select coalesce(business_name, full_name) into label from public.profiles where user_id = new.client_id;
  end if;
  label := coalesce(label, 'A client');
  insert into public.notifications (project_id, client_id, title, body)
  values (new.project_id, new.client_id,
    label || ' — new ' || (case when new.channel = 'support' then 'support' else 'team chat' end) || ' message',
    left(new.body, 140));
  return new;
end; $$;

drop trigger if exists on_message_created on public.messages;
create trigger on_message_created after insert on public.messages
  for each row execute function public.notify_new_message();

-- ############################################################
-- ############################################################
-- M1 — SALES / DELIVERY SEPARATION, PHASE 1  (idempotent — safe to re-run)
--
-- Introduces the sales CRM vertical slice that the sales-rep / team-manager
-- onboarding runs on:
--   Prospect -> Lead -> Opportunity -> Client -> Commission ledger.
--
-- ROLE NAMING NOTE: the product speaks of "Sales Rep", "Team Manager", "Admin".
-- The database keeps the EXISTING role values to avoid breaking every existing
-- account and every role-gate already shipped (login/rep/admin/portal + invite-rep):
--     sales_rep    == role 'rep'
--     team_manager == role 'manager'   (NEW)
--     admin        == role 'admin'
-- The UI labels these "Sales Rep" / "Team Manager" / "Admin".
--
-- Authorization is enforced here in RLS (server side), not just in the UI:
--   * Delivery / "kitchen" tables  -> ADMIN ONLY (reps & managers get no policy)
--   * Sales tables (leads/deals/clients/commissions/activity)
--        rep     -> only records assigned to them
--        manager -> records owned by their downline (profiles.manager_id tree)
--        admin   -> everything
-- ############################################################
-- ############################################################

-- ============================================================
-- PROFILES — add the team-manager role, the org-tree edge, offboarding status,
-- and Stripe Connect fields. All additive / non-breaking.
-- ============================================================
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('client','rep','manager','admin'));

alter table public.profiles add column if not exists manager_id uuid references auth.users(id) on delete set null;   -- reports_to edge (org tree)
alter table public.profiles add column if not exists team_id uuid;                                                    -- optional team tag
alter table public.profiles add column if not exists status text not null default 'active' check (status in ('active','inactive'));
alter table public.profiles add column if not exists stripe_connect_account_id text;                                  -- Stripe Express connected account
alter table public.profiles add column if not exists connect_status text not null default 'not_started'
  check (connect_status in ('not_started','pending','restricted','enabled'));
alter table public.profiles add column if not exists updated_at timestamptz default now();

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ============================================================
-- RLS HELPERS — SECURITY DEFINER so they bypass RLS internally and never
-- re-trigger a policy on profiles (same anti-recursion pattern as
-- current_user_role() defined above).
-- ============================================================

-- me + everyone who transitively reports to me, via profiles.manager_id.
create or replace function public.my_team_ids()
returns table(user_id uuid)
language sql security definer set search_path = public stable as $$
  with recursive tree as (
    select auth.uid() as id
    union all
    select p.user_id from public.profiles p join tree t on p.manager_id = t.id
  )
  select id from tree;
$$;

-- true when the caller is admin or team-manager (delivery stays admin-only, so this
-- is used for sales-side "staff" checks, not kitchen access).
create or replace function public.is_staff()
returns boolean language sql security definer set search_path = public stable as $$
  select public.current_user_role() in ('admin','manager');
$$;

-- ============================================================
-- NARROW THE DELIVERY / "KITCHEN" TABLES TO ADMIN-ONLY.
-- Previously these granted current_user_role() in ('rep','admin'); a rep could
-- read every client's delivery data, internal notes, and margins. Reps and
-- managers now get NO policy on these tables at all -> zero rows.
-- (leads/deals are handled separately below — they are the SALES funnel, not the kitchen.)
-- ============================================================
drop policy if exists "staff manage all companies" on public.companies;
drop policy if exists "admins manage all companies" on public.companies;
create policy "admins manage all companies" on public.companies for all
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "staff manage all projects" on public.projects;
drop policy if exists "admins manage all projects" on public.projects;
create policy "admins manage all projects" on public.projects for all
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "staff view all project setup" on public.project_setup;
drop policy if exists "admins view all project setup" on public.project_setup;
create policy "admins view all project setup" on public.project_setup for select
  using (public.current_user_role() = 'admin');
drop policy if exists "staff update all project setup" on public.project_setup;
drop policy if exists "admins update all project setup" on public.project_setup;
create policy "admins update all project setup" on public.project_setup for update
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "staff manage all project stages" on public.project_stages;
drop policy if exists "admins manage all project stages" on public.project_stages;
create policy "admins manage all project stages" on public.project_stages for all
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "staff manage all notifications" on public.notifications;
drop policy if exists "admins manage all notifications" on public.notifications;
create policy "admins manage all notifications" on public.notifications for all
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "staff manage all messages" on public.messages;
drop policy if exists "admins manage all messages" on public.messages;
create policy "admins manage all messages" on public.messages for all
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

-- Storage: client-assets is a delivery bucket -> admin only. (rep-docs stays rep-owned.)
drop policy if exists "staff manage all client assets" on storage.objects;
drop policy if exists "admins manage all client assets" on storage.objects;
create policy "admins manage all client assets" on storage.objects for all
  using (bucket_id = 'client-assets' and public.current_user_role() = 'admin')
  with check (bucket_id = 'client-assets' and public.current_user_role() = 'admin');

-- Managers need to read their downline's profiles (to render rep names / assignments).
drop policy if exists "staff can view all profiles" on public.profiles;
drop policy if exists "admins can view all profiles" on public.profiles;
create policy "admins can view all profiles" on public.profiles for select
  using (public.current_user_role() = 'admin');
drop policy if exists "managers can view downline profiles" on public.profiles;
create policy "managers can view downline profiles" on public.profiles for select
  using (public.current_user_role() = 'manager' and user_id in (select user_id from public.my_team_ids()));

-- ============================================================
-- LEADS  ==  PROSPECT + LEAD  (single object, discriminated by `lifecycle`).
-- Extend in place; add audit + assignment; re-scope RLS rep/manager/admin.
--   Prospect statuses: New, Assigned, Researching, Ready to Contact,
--     Attempted Contact, Bad Data, Wrong Number, Duplicate, Do Not Contact, Archived
--   Lead statuses:     New Lead, Contacted, Discovery Scheduled, Discovery Completed,
--     Follow-Up, Nurture, Qualified, Disqualified, Lost
-- (Long vocabularies are validated in the app; `lifecycle` is CHECK-constrained.)
-- ============================================================
alter table public.leads add column if not exists lifecycle text not null default 'prospect'
  check (lifecycle in ('prospect','lead'));
alter table public.leads add column if not exists assigned_rep_id uuid references auth.users(id) on delete set null;
alter table public.leads add column if not exists created_by uuid references auth.users(id) on delete set null default auth.uid();
alter table public.leads add column if not exists team_id uuid;
alter table public.leads add column if not exists source text;               -- bot | scraped | imported | manual
alter table public.leads add column if not exists next_action text;
alter table public.leads add column if not exists next_action_at timestamptz;
alter table public.leads add column if not exists archived_at timestamptz;    -- archive, never hard-delete
alter table public.leads add column if not exists qualified_at timestamptz;
alter table public.leads add column if not exists became_lead_at timestamptz;

create index if not exists leads_assigned_idx on public.leads(assigned_rep_id, updated_at desc);

-- Replace the old admin/rep "staff manage leads" with rep-own / manager-downline / admin-all.
drop policy if exists "staff manage leads" on public.leads;

drop policy if exists "reps work their assigned leads" on public.leads;
create policy "reps work their assigned leads" on public.leads for all
  using (auth.uid() = assigned_rep_id or auth.uid() = created_by)
  with check (auth.uid() = assigned_rep_id or auth.uid() = created_by);

drop policy if exists "managers work downline leads" on public.leads;
create policy "managers work downline leads" on public.leads for all
  using (public.current_user_role() = 'manager'
         and (assigned_rep_id in (select user_id from public.my_team_ids())
              or created_by in (select user_id from public.my_team_ids())))
  with check (public.current_user_role() = 'manager'
         and (assigned_rep_id in (select user_id from public.my_team_ids())
              or created_by in (select user_id from public.my_team_ids())));

drop policy if exists "admins manage all leads" on public.leads;
create policy "admins manage all leads" on public.leads for all
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');
-- (the pre-existing "users can read their own matching lead" email-match policy is kept as-is)

-- ============================================================
-- DEALS  ==  OPPORTUNITY. Extend in place; add audit, financials, commission-plan
-- snapshot; re-scope RLS to add manager-downline. rep_id (existing) = assigned rep.
--   Opportunity stages: Opportunity Created, Audit or Concept Sent, Proposal Sent,
--     Negotiating, Verbal Yes, Contract Sent, Payment Pending, Won, Lost
-- ============================================================
alter table public.deals add column if not exists lead_id uuid references public.leads(id) on delete set null;
alter table public.deals add column if not exists assigned_manager_id uuid references auth.users(id) on delete set null; -- override recipient
alter table public.deals add column if not exists created_by uuid references auth.users(id) on delete set null default auth.uid();
alter table public.deals add column if not exists team_id uuid;
alter table public.deals add column if not exists setup_revenue numeric not null default 0;   -- one-time
alter table public.deals add column if not exists mrr numeric not null default 0;             -- monthly recurring
alter table public.deals add column if not exists probability int not null default 0 check (probability between 0 and 100);
alter table public.deals add column if not exists expected_close date;
alter table public.deals add column if not exists services jsonb not null default '[]'::jsonb;
alter table public.deals add column if not exists commission_plan_id uuid;                     -- FK added after commission_plans exists
alter table public.deals add column if not exists commission_plan_snapshot jsonb;              -- plan captured at close (never recompute from current %)
alter table public.deals add column if not exists client_id uuid;                              -- FK added after clients exists
alter table public.deals add column if not exists archived_at timestamptz;
alter table public.deals add column if not exists won_at timestamptz;

-- One Opportunity per Lead — structurally prevents duplicate lead->opportunity conversion.
create unique index if not exists deals_one_per_lead on public.deals(lead_id) where lead_id is not null;

-- Normalize legacy stage values (New|Contacted|Quoted) into the Opportunity vocabulary.
-- Idempotent: a second run finds none of the old values left. Won/Lost already match.
update public.deals set stage = 'Opportunity Created'   where stage = 'New';
update public.deals set stage = 'Audit or Concept Sent' where stage = 'Contacted';
update public.deals set stage = 'Proposal Sent'         where stage = 'Quoted';
alter table public.deals alter column stage set default 'Opportunity Created';

-- Add the manager-downline policy (rep-private + admin-all already exist).
drop policy if exists "managers manage downline deals" on public.deals;
create policy "managers manage downline deals" on public.deals for all
  using (public.current_user_role() = 'manager'
         and (rep_id in (select user_id from public.my_team_ids())
              or assigned_manager_id = auth.uid()))
  with check (public.current_user_role() = 'manager'
         and (rep_id in (select user_id from public.my_team_ids())
              or assigned_manager_id = auth.uid()));

-- ============================================================
-- COMMISSION PLANS — named rate cards. A snapshot is copied onto the opportunity
-- at close so historical commissions never recompute from a rep's current %.
-- ============================================================
create table if not exists public.commission_plans (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  setup_rate    numeric not null default 0,   -- fraction of setup_revenue, e.g. 0.10 = 10%
  mrr_rate      numeric not null default 0,    -- fraction of first-month MRR
  override_rate numeric not null default 0,    -- manager override, fraction of the rep's direct amount
  active        boolean not null default true,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
alter table public.commission_plans enable row level security;

drop policy if exists "staff can read commission plans" on public.commission_plans;
create policy "staff can read commission plans" on public.commission_plans for select
  using (public.current_user_role() in ('rep','manager','admin'));
drop policy if exists "admins manage commission plans" on public.commission_plans;
create policy "admins manage commission plans" on public.commission_plans for all
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop trigger if exists commission_plans_touch on public.commission_plans;
create trigger commission_plans_touch before update on public.commission_plans
  for each row execute function public.touch_updated_at();

-- Seed a single default plan (idempotent).
insert into public.commission_plans (name, setup_rate, mrr_rate, override_rate, active)
select 'Standard Plan', 0.10, 1.0, 0.05, true
where not exists (select 1 from public.commission_plans);

-- Now that commission_plans exists, wire the FK from deals (guarded so re-runs don't error).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_commission_plan_fk') then
    alter table public.deals add constraint deals_commission_plan_fk
      foreign key (commission_plan_id) references public.commission_plans(id) on delete set null;
  end if;
end $$;

-- ============================================================
-- CLIENTS — commercial account record, created ONLY after Won + confirmed payment.
-- Insert/update is service-role only (no browser write policy) so "a client row exists"
-- structurally implies a confirmed payment. Reps see a summary of their own clients;
-- managers see downline; admins all.
-- ============================================================
create table if not exists public.clients (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid unique references auth.users(id) on delete set null,      -- the client login (if provisioned)
  origin_deal_id      uuid unique references public.deals(id) on delete set null,    -- UNIQUE -> no duplicate client per opportunity
  business_name       text,
  contact_name        text,
  contact_email       text,
  contact_phone       text,
  stripe_customer_id  text unique,
  assigned_rep_id     uuid references auth.users(id) on delete set null,
  assigned_manager_id uuid references auth.users(id) on delete set null,
  team_id             uuid,
  created_by          uuid references auth.users(id) on delete set null,
  lifetime_value      numeric not null default 0,
  onboarding_status   text not null default 'pending' check (onboarding_status in ('pending','in_progress','live')),
  active_services     jsonb not null default '[]'::jsonb,
  status              text not null default 'active' check (status in ('active','paused','churned','archived')),
  archived_at         timestamptz,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
alter table public.clients enable row level security;

-- Read-only for sales roles; NO insert/update/delete policy for rep/manager (service-role writes only).
drop policy if exists "reps read their assigned clients" on public.clients;
create policy "reps read their assigned clients" on public.clients for select
  using (auth.uid() = assigned_rep_id);
drop policy if exists "managers read downline clients" on public.clients;
create policy "managers read downline clients" on public.clients for select
  using (public.current_user_role() = 'manager'
         and assigned_rep_id in (select user_id from public.my_team_ids()));
drop policy if exists "admins manage all clients" on public.clients;
create policy "admins manage all clients" on public.clients for all
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop trigger if exists clients_touch on public.clients;
create trigger clients_touch before update on public.clients
  for each row execute function public.touch_updated_at();

-- Wire deals.client_id FK now that clients exists.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deals_client_fk') then
    alter table public.deals add constraint deals_client_fk
      foreign key (client_id) references public.clients(id) on delete set null;
  end if;
end $$;

-- ============================================================
-- COMMISSIONS — the internal ledger. Direct (rep) and override (manager) are
-- SEPARATE rows; setup vs recurring revenue are SEPARATE rows. rate_snapshot and
-- basis_amount are captured at close so nothing recomputes from a current %.
-- Writes happen only inside the SECURITY DEFINER convert function / service role;
-- admins may update status (approval workflow). A unique index blocks duplicate
-- entries for the same payment.
-- ============================================================
create table if not exists public.commissions (
  id            uuid primary key default gen_random_uuid(),
  rep_id        uuid not null references auth.users(id) on delete cascade,   -- who earns this row
  kind          text not null check (kind in ('direct','override')),
  revenue_type  text not null check (revenue_type in ('setup','recurring')),
  deal_id       uuid references public.deals(id) on delete set null,
  client_id     uuid references public.clients(id) on delete set null,
  source_rep_id uuid references auth.users(id) on delete set null,           -- for override: the selling rep
  team_id       uuid,
  basis_amount  numeric not null default 0,   -- revenue this was computed from
  rate_snapshot numeric not null default 0,   -- % captured at close
  amount        numeric not null default 0,   -- basis_amount * rate_snapshot
  status        text not null default 'pending'
                  check (status in ('pending','approved','payable','paid','reversed')),
  payment_ref   text,                          -- stripe session/payment id or manual ref
  stripe_event_id text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
alter table public.commissions enable row level security;

-- One row per (deal, earner, kind, revenue_type, payment) — blocks duplicate accrual.
create unique index if not exists commissions_no_dupe
  on public.commissions(deal_id, rep_id, kind, revenue_type, coalesce(payment_ref, ''));
create index if not exists commissions_rep_idx on public.commissions(rep_id, created_at desc);

drop policy if exists "reps read their own commissions" on public.commissions;
create policy "reps read their own commissions" on public.commissions for select
  using (auth.uid() = rep_id);
drop policy if exists "managers read downline commissions" on public.commissions;
create policy "managers read downline commissions" on public.commissions for select
  using (public.current_user_role() = 'manager'
         and rep_id in (select user_id from public.my_team_ids()));
drop policy if exists "admins manage all commissions" on public.commissions;
create policy "admins manage all commissions" on public.commissions for all
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop trigger if exists commissions_touch on public.commissions;
create trigger commissions_touch before update on public.commissions
  for each row execute function public.touch_updated_at();

-- ============================================================
-- ACTIVITY LOG — records lifecycle conversions and status changes (audit trail).
-- ============================================================
create table if not exists public.activity_log (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,             -- lead | deal | client | commission
  entity_id    uuid,
  action       text not null,             -- prospect_to_lead | lead_qualified | lead_to_opportunity | opportunity_won | client_created | commission_accrued | archived | status_change
  actor_id     uuid default auth.uid(),
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz default now()
);
alter table public.activity_log enable row level security;

drop policy if exists "staff insert their own activity" on public.activity_log;
create policy "staff insert their own activity" on public.activity_log for insert
  with check (public.current_user_role() in ('rep','manager','admin') and actor_id = auth.uid());
drop policy if exists "reps read their own activity" on public.activity_log;
create policy "reps read their own activity" on public.activity_log for select
  using (auth.uid() = actor_id);
drop policy if exists "managers read downline activity" on public.activity_log;
create policy "managers read downline activity" on public.activity_log for select
  using (public.current_user_role() = 'manager'
         and actor_id in (select user_id from public.my_team_ids()));
drop policy if exists "admins read all activity" on public.activity_log;
create policy "admins read all activity" on public.activity_log for all
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

-- ============================================================
-- CONVERSION FUNCTIONS (transactional).
-- ============================================================

-- Lead -> Opportunity. Runs as the caller (SECURITY INVOKER) so normal RLS applies:
-- only the assigned rep / their manager / admin can create the opportunity. Guards
-- against double conversion via the deals_one_per_lead unique index + an explicit check.
create or replace function public.convert_lead_to_opportunity(p_lead_id uuid)
returns uuid
language plpgsql
as $$
declare
  v_lead   public.leads%rowtype;
  v_deal_id uuid;
  v_plan   public.commission_plans%rowtype;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_lead.id is null then raise exception 'lead_not_found'; end if;
  if v_lead.lifecycle <> 'lead' or coalesce(v_lead.status,'') <> 'Qualified' then
    raise exception 'lead_not_qualified';
  end if;

  select id into v_deal_id from public.deals where lead_id = p_lead_id limit 1;
  if v_deal_id is not null then raise exception 'opportunity_already_exists'; end if;

  select * into v_plan from public.commission_plans where active order by created_at limit 1;

  insert into public.deals (rep_id, lead_id, assigned_manager_id, created_by, team_id,
                            contact, business, stage, value, commission_plan_id)
  values (coalesce(v_lead.assigned_rep_id, auth.uid()), v_lead.id,
          (select manager_id from public.profiles where user_id = coalesce(v_lead.assigned_rep_id, auth.uid())),
          auth.uid(), v_lead.team_id,
          v_lead.full_name, v_lead.business, 'Opportunity Created', 0, v_plan.id)
  returning id into v_deal_id;

  insert into public.activity_log (entity_type, entity_id, action, detail)
  values ('deal', v_deal_id, 'lead_to_opportunity',
          jsonb_build_object('lead_id', p_lead_id, 'business', v_lead.business));
  return v_deal_id;
end;
$$;
revoke all on function public.convert_lead_to_opportunity(uuid) from public;
grant execute on function public.convert_lead_to_opportunity(uuid) to authenticated;

-- Opportunity -> Won + Client + Commission ledger. SECURITY DEFINER because it must
-- insert the service-role-only clients/commissions rows. It is NOT granted to browser
-- roles — only the service role (Stripe webhook / admin serverless action, both of
-- which verify a confirmed payment first) may call it. Fully idempotent:
--   * a Won deal that already has a client returns that client, adds nothing
--   * commission rows collide on commissions_no_dupe and are skipped
-- The whole body is one transaction.
create or replace function public.convert_opportunity_to_client(
  p_deal_id uuid, p_payment_ref text default null, p_actor uuid default null)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_deal    public.deals%rowtype;
  v_plan    public.commission_plans%rowtype;
  v_snap    jsonb;
  v_client_id uuid;
  v_manager uuid;
  v_setup_rate numeric; v_mrr_rate numeric; v_override_rate numeric;
  v_direct_setup numeric; v_direct_mrr numeric;
  v_contact_email text; v_contact_phone text;
begin
  select * into v_deal from public.deals where id = p_deal_id for update;
  if v_deal.id is null then raise exception 'deal_not_found'; end if;

  -- Carry the contact's email/phone over from the originating lead (if any) so the new
  -- client row — and any welcome email sent off it — has someone to reach.
  if v_deal.lead_id is not null then
    select email, phone into v_contact_email, v_contact_phone from public.leads where id = v_deal.lead_id;
  end if;

  -- Idempotency: already converted?
  select id into v_client_id from public.clients where origin_deal_id = p_deal_id;
  if v_client_id is not null then
    return v_client_id;
  end if;

  -- Capture / reuse the commission plan snapshot (never recompute from current %).
  if v_deal.commission_plan_snapshot is not null then
    v_snap := v_deal.commission_plan_snapshot;
  else
    select * into v_plan from public.commission_plans
      where id = v_deal.commission_plan_id
         or (v_deal.commission_plan_id is null and active)
      order by (id = v_deal.commission_plan_id) desc, created_at limit 1;
    v_snap := jsonb_build_object(
      'commission_plan_id', v_plan.id, 'name', v_plan.name,
      'setup_rate', v_plan.setup_rate, 'mrr_rate', v_plan.mrr_rate,
      'override_rate', v_plan.override_rate);
  end if;
  v_setup_rate    := coalesce((v_snap->>'setup_rate')::numeric, 0);
  v_mrr_rate      := coalesce((v_snap->>'mrr_rate')::numeric, 0);
  v_override_rate := coalesce((v_snap->>'override_rate')::numeric, 0);

  -- Mark the opportunity Won + store the snapshot used.
  update public.deals
     set stage = 'Won', won_at = now(),
         commission_plan_snapshot = v_snap,
         updated_at = now()
   where id = p_deal_id;

  -- Create the client (unique origin_deal_id blocks duplicates under concurrency).
  insert into public.clients (origin_deal_id, business_name, contact_name, contact_email, contact_phone,
                              assigned_rep_id, assigned_manager_id, team_id, created_by,
                              lifetime_value, onboarding_status, active_services, status)
  values (p_deal_id, v_deal.business, v_deal.contact, v_contact_email, v_contact_phone,
          v_deal.rep_id, v_deal.assigned_manager_id, v_deal.team_id, coalesce(p_actor, v_deal.rep_id),
          coalesce(v_deal.setup_revenue,0) + coalesce(v_deal.mrr,0), 'pending', v_deal.services, 'active')
  on conflict (origin_deal_id) do nothing
  returning id into v_client_id;

  if v_client_id is null then
    select id into v_client_id from public.clients where origin_deal_id = p_deal_id;
  end if;

  update public.deals set client_id = v_client_id where id = p_deal_id;

  v_manager := coalesce(v_deal.assigned_manager_id,
                        (select manager_id from public.profiles where user_id = v_deal.rep_id));

  -- Direct rep commissions: setup + recurring as separate rows.
  v_direct_setup := coalesce(v_deal.setup_revenue,0) * v_setup_rate;
  v_direct_mrr   := coalesce(v_deal.mrr,0) * v_mrr_rate;

  if coalesce(v_deal.setup_revenue,0) > 0 then
    insert into public.commissions (rep_id, kind, revenue_type, deal_id, client_id,
      basis_amount, rate_snapshot, amount, status, payment_ref, created_by)
    values (v_deal.rep_id, 'direct', 'setup', p_deal_id, v_client_id,
      v_deal.setup_revenue, v_setup_rate, v_direct_setup, 'pending', p_payment_ref, p_actor)
    on conflict do nothing;
  end if;
  if coalesce(v_deal.mrr,0) > 0 then
    insert into public.commissions (rep_id, kind, revenue_type, deal_id, client_id,
      basis_amount, rate_snapshot, amount, status, payment_ref, created_by)
    values (v_deal.rep_id, 'direct', 'recurring', p_deal_id, v_client_id,
      v_deal.mrr, v_mrr_rate, v_direct_mrr, 'pending', p_payment_ref, p_actor)
    on conflict do nothing;
  end if;

  -- Manager override: separate rows, computed off the rep's direct amounts.
  if v_manager is not null and v_override_rate > 0 then
    if v_direct_setup > 0 then
      insert into public.commissions (rep_id, kind, revenue_type, deal_id, client_id,
        source_rep_id, basis_amount, rate_snapshot, amount, status, payment_ref, created_by)
      values (v_manager, 'override', 'setup', p_deal_id, v_client_id,
        v_deal.rep_id, v_direct_setup, v_override_rate, v_direct_setup * v_override_rate,
        'pending', p_payment_ref, p_actor)
      on conflict do nothing;
    end if;
    if v_direct_mrr > 0 then
      insert into public.commissions (rep_id, kind, revenue_type, deal_id, client_id,
        source_rep_id, basis_amount, rate_snapshot, amount, status, payment_ref, created_by)
      values (v_manager, 'override', 'recurring', p_deal_id, v_client_id,
        v_deal.rep_id, v_direct_mrr, v_override_rate, v_direct_mrr * v_override_rate,
        'pending', p_payment_ref, p_actor)
      on conflict do nothing;
    end if;
  end if;

  insert into public.activity_log (entity_type, entity_id, action, actor_id, detail)
  values ('client', v_client_id, 'client_created', coalesce(p_actor, v_deal.rep_id),
          jsonb_build_object('deal_id', p_deal_id, 'payment_ref', p_payment_ref));
  insert into public.activity_log (entity_type, entity_id, action, actor_id, detail)
  values ('deal', p_deal_id, 'opportunity_won', coalesce(p_actor, v_deal.rep_id),
          jsonb_build_object('client_id', v_client_id));

  return v_client_id;
end;
$$;
-- Browser roles cannot call this — only the service role (webhook / admin serverless).
revoke all on function public.convert_opportunity_to_client(uuid, text, uuid) from public;
revoke all on function public.convert_opportunity_to_client(uuid, text, uuid) from authenticated;

-- ============================================================
-- END M1
-- ============================================================

-- ############################################################
-- M2 — REP APPOINTMENT-SETTER EXPERIENCE  (idempotent — safe to re-run)
-- Rep profile (photo + swag mailing address + email signature), call
-- dispositions on prospects/leads, and a "booked on Cal" marker used to spin
-- an appointment into an Opportunity ("ready for the demo").
-- ############################################################

-- Rep profile fields
alter table public.profiles add column if not exists avatar_url      text;
alter table public.profiles add column if not exists ship_name       text;   -- name for swag shipment
alter table public.profiles add column if not exists ship_address1   text;
alter table public.profiles add column if not exists ship_address2   text;
alter table public.profiles add column if not exists ship_city       text;
alter table public.profiles add column if not exists ship_state      text;
alter table public.profiles add column if not exists ship_postal     text;
alter table public.profiles add column if not exists ship_country    text;

-- Call disposition on prospects/leads (Answered, No Answer, Voicemail, Callback, ...)
alter table public.leads add column if not exists call_outcome      text;
alter table public.leads add column if not exists last_contacted_at timestamptz;

-- Appointment-setter: when the prospect booked the demo on Cal.com.
alter table public.deals add column if not exists demo_booked_at timestamptz;

-- Avatars: a PUBLIC bucket for rep profile photos (name files under <user_id>/...).
insert into storage.buckets (id, name, public) values ('avatars','avatars',true)
on conflict (id) do nothing;

drop policy if exists "avatars are readable by anyone" on storage.objects;
create policy "avatars are readable by anyone" on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "users manage their own avatar" on storage.objects;
create policy "users manage their own avatar" on storage.objects for all
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================
-- END M2
-- ============================================================

-- ############################################################
-- M3 — REAL E-SIGNATURE FOR NDA / NON-COMPETE  (idempotent — safe to re-run)
-- Replaces the old "type your name" fake signature with a real, audit-trailed
-- e-signature via Documenso (documenso.com — open-source, free tier available).
-- Secrets (API key, webhook secret, template IDs) live only in Vercel env vars
-- and are used only inside api/actions.js (actions "create-signing-request" and
-- "documenso-webhook") — never in the browser. Configure the Documenso dashboard
-- webhook URL as .../api/actions?action=documenso-webhook.
-- ############################################################

-- De-dupe first: the old flow could insert more than one row per (rep_id, doc_type)
-- since it never checked for an existing signature. Keep the newest row per pair so the
-- unique index below can be added safely.
delete from public.agreements a using public.agreements b
where a.rep_id = b.rep_id and a.doc_type = b.doc_type
  and a.signed_at < b.signed_at;

alter table public.agreements add column if not exists status text not null default 'pending'
  check (status in ('pending','signed','voided'));
alter table public.agreements add column if not exists documenso_document_id bigint;
alter table public.agreements add column if not exists signing_url text;
alter table public.agreements add column if not exists signed_pdf_path text;
alter table public.agreements add column if not exists updated_at timestamptz default now();

-- Backfill: any legacy typed-name row counts as already "signed" (no PDF on file for those).
update public.agreements set status = 'signed' where status is distinct from 'signed' and signed_name is not null and signed_pdf_path is null and documenso_document_id is null;

drop trigger if exists agreements_touch on public.agreements;
create trigger agreements_touch before update on public.agreements
  for each row execute function public.touch_updated_at();

-- One record per rep per doc type — re-requesting a link updates the same row instead of
-- creating a duplicate (also what the "create-signing-request" action upserts against).
create unique index if not exists agreements_rep_doctype_uniq on public.agreements(rep_id, doc_type);

-- Admin can view every rep's agreement status (the existing rep-private policy is
-- untouched — this ADDS an admin read, it doesn't replace anything).
drop policy if exists "admins view all agreements" on public.agreements;
create policy "admins view all agreements" on public.agreements for select
  using (public.current_user_role() = 'admin');

-- Admin can also open reps' uploaded docs (signed NDA/NC PDFs + W-9s) in rep-docs storage
-- to review compliance; reps keep their own existing rep-docs policy.
drop policy if exists "admins manage all rep docs" on storage.objects;
create policy "admins manage all rep docs" on storage.objects for all
  using (bucket_id = 'rep-docs' and public.current_user_role() = 'admin')
  with check (bucket_id = 'rep-docs' and public.current_user_role() = 'admin');

-- Bug fix: the original leads table declared email NOT NULL, but reps can add a prospect
-- with only a name/phone (email unknown yet) — that insert was failing. Safe/idempotent:
-- DROP NOT NULL on an already-nullable column is a no-op in Postgres.
alter table public.leads alter column email drop not null;

-- ============================================================
-- END M3
-- ============================================================


-- ============================================================
-- M4 — Automated follow-up nudges (cold prospect/lead reminders)
-- ------------------------------------------------------------
-- The daily cron (api/cron.js) emails each rep a digest of their prospects/leads that have
-- gone cold (not contacted in a few days, still working, not archived). `last_nudged_at`
-- records when a lead was last included in a digest so we don't re-nudge the same rows every
-- run — a per-lead cooldown. Additive + idempotent (safe to re-run).
-- ============================================================
alter table public.leads add column if not exists last_nudged_at timestamptz;

-- Partial index over the "still working, not archived" rows the cron scans — keeps the daily
-- sweep cheap as the table grows.
create index if not exists leads_followup_idx
  on public.leads(assigned_rep_id, last_contacted_at)
  where archived_at is null;

-- ============================================================
-- END M4
-- ============================================================


-- ============================================================
-- M5 — Real in-app notifications for reps & managers (not just admin/client)
-- ------------------------------------------------------------
-- The `notifications` table only ever had `client_id` (client-facing, kitchen stage changes)
-- and got locked to admin-only SELECT by M1's kitchen lockout — so rep.html and manager.html
-- had no bell at all, even though the app already emails reps on assignment/demo-booked/
-- commission-status events. `recipient_id` is a generic "this row is for this specific staff
-- user" pointer (separate from `client_id`, which stays kitchen/admin-only), so any authenticated
-- user can see their own — and only their own — notifications without touching kitchen data.
-- ============================================================
alter table public.notifications add column if not exists recipient_id uuid references auth.users(id) on delete cascade;
create index if not exists notifications_recipient_idx on public.notifications(recipient_id, created_at desc);

drop policy if exists "users manage their own notifications" on public.notifications;
create policy "users manage their own notifications" on public.notifications for all
  using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

-- ============================================================
-- END M5
-- ============================================================


-- ============================================================
-- M6 — Acquisition / ad-attribution tracking (the admin "Acquisition Command Center")
-- ------------------------------------------------------------
-- Ties ad spend -> booked calls -> paying clients inside admin.html. `leads.utm` stores the
-- campaign attribution captured on the landing pages (source/medium/campaign/content) and
-- passed through the Cal.com booking. `campaign_spend` is a lightweight manual spend entry
-- (per utm_campaign per month) so ROAS/CPL/CAC are real without a heavy Meta/Google API sync.
-- Attribution joins: leads.utm -> deals(lead_id, demo_booked_at) -> clients(origin_deal_id,
-- lifetime_value). Additive + idempotent.
-- ============================================================
alter table public.leads add column if not exists utm jsonb;
create index if not exists leads_utm_campaign_idx on public.leads((utm->>'campaign'));

create table if not exists public.campaign_spend (
  id           uuid primary key default gen_random_uuid(),
  utm_campaign text not null,
  channel      text,                 -- meta | google | linkedin
  period       text not null,        -- 'YYYY-MM'
  amount       numeric not null default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create unique index if not exists campaign_spend_uniq on public.campaign_spend(utm_campaign, period);
alter table public.campaign_spend enable row level security;

drop policy if exists "admins manage campaign spend" on public.campaign_spend;
create policy "admins manage campaign spend" on public.campaign_spend for all
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- ============================================================
-- END M6
-- ============================================================

-- ============================================================
-- M7 — AI Site Builder history (rep.html / admin.html "AI Site Builder")
-- ------------------------------------------------------------
-- Persists each generated draft so reps/admins get a searchable history instead of losing it
-- the moment they navigate away, auto-titled by business name. Stores the input + the generated
-- copy/palette (not the full rendered HTML — that's cheap to rebuild client-side from
-- copy+niche+palette via buildSiteHtml, so a large HTML blob isn't duplicated per row) plus the
-- thinking-log step labels so reopening a history entry can show what happened. Additive +
-- idempotent.
-- ============================================================
create table if not exists public.site_drafts (
  id             uuid primary key default gen_random_uuid(),
  created_by     uuid references auth.users(id) on delete cascade,
  business_name  text not null,
  niche          text,
  city           text,
  website_url    text,
  raw_info       text,
  copy           jsonb,
  palette        jsonb,
  ai_status      text,
  palette_status text,
  thinking_log   jsonb,
  created_at     timestamptz default now()
);
create index if not exists site_drafts_created_by_idx on public.site_drafts(created_by, created_at desc);
alter table public.site_drafts enable row level security;

drop policy if exists "reps manage own site drafts" on public.site_drafts;
create policy "reps manage own site drafts" on public.site_drafts for all
  using (created_by = auth.uid() and public.current_user_role() in ('rep','admin'))
  with check (created_by = auth.uid() and public.current_user_role() in ('rep','admin'));

drop policy if exists "admins view all site drafts" on public.site_drafts;
create policy "admins view all site drafts" on public.site_drafts for select
  using (public.current_user_role() = 'admin');

-- ============================================================
-- END M7
-- ============================================================
