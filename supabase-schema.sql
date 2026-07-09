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
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

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
