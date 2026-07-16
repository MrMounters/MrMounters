-- ============================================================================
-- Meridion AI — sales-CRM migration (M1 + M2 + M3), STANDALONE & idempotent.
-- HOW TO RUN: Supabase → SQL Editor → New query → paste ALL of this → Run.
-- (Paste the CONTENTS of this file, not the filename.) Safe to re-run.
-- You'll get a RESULTS TABLE at the bottom; every ok must be true.
-- ============================================================================

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
begin
  select * into v_deal from public.deals where id = p_deal_id for update;
  if v_deal.id is null then raise exception 'deal_not_found'; end if;

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
  insert into public.clients (origin_deal_id, business_name, contact_name,
                              assigned_rep_id, assigned_manager_id, team_id, created_by,
                              lifetime_value, onboarding_status, active_services, status)
  values (p_deal_id, v_deal.business, v_deal.contact,
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

-- ============================================================================
-- VERIFICATION — returns rows so you can SEE it worked. Every ok must be true.
-- ============================================================================
with checks(object, ok) as (values
  ('leads.lifecycle',            (to_regclass('public.leads') is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name='leads' and column_name='lifecycle'))),
  ('leads.call_outcome',         exists(select 1 from information_schema.columns where table_schema='public' and table_name='leads' and column_name='call_outcome')),
  ('leads.email nullable',       (select is_nullable='YES' from information_schema.columns where table_schema='public' and table_name='leads' and column_name='email')),
  ('deals.archived_at',          exists(select 1 from information_schema.columns where table_schema='public' and table_name='deals' and column_name='archived_at')),
  ('deals.demo_booked_at',       exists(select 1 from information_schema.columns where table_schema='public' and table_name='deals' and column_name='demo_booked_at')),
  ('profiles.avatar_url',        exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='avatar_url')),
  ('profiles.ship_address1',     exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='ship_address1')),
  ('table clients',              (to_regclass('public.clients') is not null)),
  ('table commissions',          (to_regclass('public.commissions') is not null)),
  ('table commission_plans',     (to_regclass('public.commission_plans') is not null)),
  ('table activity_log',         (to_regclass('public.activity_log') is not null)),
  ('bucket avatars',             exists(select 1 from storage.buckets where id='avatars')),
  ('agreements.status',          exists(select 1 from information_schema.columns where table_schema='public' and table_name='agreements' and column_name='status')),
  ('agreements.signing_url',     exists(select 1 from information_schema.columns where table_schema='public' and table_name='agreements' and column_name='signing_url')),
  ('agreements.signed_pdf_path', exists(select 1 from information_schema.columns where table_schema='public' and table_name='agreements' and column_name='signed_pdf_path')),
  ('agreements rep+doctype unique', exists(select 1 from pg_indexes where schemaname='public' and indexname='agreements_rep_doctype_uniq')),
  ('fn convert_lead_to_opportunity',   (to_regproc('public.convert_lead_to_opportunity') is not null)),
  ('fn convert_opportunity_to_client', exists(select 1 from pg_proc where proname='convert_opportunity_to_client')),
  ('role allows manager',        (pg_get_constraintdef((select oid from pg_constraint where conname='profiles_role_check')) ilike '%manager%'))
)
select object, ok from checks order by object;

notify pgrst, 'reload schema';
