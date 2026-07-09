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
