-- ============================================================
-- Meridion AI — Supabase schema
-- Run this once in your Supabase project: SQL Editor → New query → Run.
-- Then put your Project URL + anon key in auth-config.js.
-- ============================================================

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
create policy "deals are private to the rep"
  on public.deals for all
  using (auth.uid() = rep_id)
  with check (auth.uid() = rep_id);

create index if not exists deals_rep_idx on public.deals(rep_id, updated_at desc);

-- ---------- AGREEMENTS (NDA / non-compete signatures) ----------
create table if not exists public.agreements (
  id          uuid primary key default gen_random_uuid(),
  rep_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  doc_type    text not null,                  -- 'nda' | 'non_compete'
  signed_name text not null,
  signed_at   timestamptz default now()
);

alter table public.agreements enable row level security;

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

create policy "academy progress is private to the rep"
  on public.academy_progress for all
  using (auth.uid() = rep_id)
  with check (auth.uid() = rep_id);

-- ---------- keep updated_at fresh ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists deals_touch on public.deals;
create trigger deals_touch before update on public.deals
  for each row execute function public.touch_updated_at();
