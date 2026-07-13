-- Flipwatch — initial schema
-- Postgres 15 / Supabase. Auth users live in auth.users (managed by Supabase Auth).

-- ── Plans & subscriptions ─────────────────────────────────────────────────────

create type plan_tier as enum ('trial', 'standard', 'pro');
create type sub_status as enum ('trialing', 'active', 'past_due', 'canceled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  tier plan_tier not null default 'trial',
  status sub_status not null default 'trialing',
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  trial_ends_at timestamptz not null default now() + interval '7 days',
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

-- Per-tier limits enforced by edge functions (single source of truth).
create table public.plan_limits (
  tier plan_tier primary key,
  max_saved_searches int not null,
  min_poll_seconds int not null,        -- fastest allowed refresh per search
  daily_api_calls int not null,         -- per-user ceiling against your eBay quota
  auctions_enabled boolean not null,
  deal_score_enabled boolean not null,
  portfolio_enabled boolean not null
);

insert into public.plan_limits values
  ('trial',    3,  60, 1500, true,  true,  true),
  ('standard', 10, 30, 4000, false, false, true),
  ('pro',      50, 15, 12000, true, true,  true);

-- ── Saved searches & dedup ────────────────────────────────────────────────────

create table public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  label text not null,
  keywords text not null,
  -- Browse API filters
  price_min numeric(10,2),
  price_max numeric(10,2),
  buying_options text[] not null default '{FIXED_PRICE}',  -- FIXED_PRICE | AUCTION | BEST_OFFER
  us_only boolean not null default true,
  category_ids text[],
  condition_ids text[],
  blocked_sellers text[] not null default '{}',
  poll_seconds int not null default 60,
  notify boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on public.saved_searches (user_id) where active;

-- Items a user has already been shown, per search (replaces localStorage ebm_seen_v2).
-- Server-side so alerts survive reinstalls and work across devices.
create table public.seen_items (
  search_id uuid not null references public.saved_searches(id) on delete cascade,
  item_id text not null,
  first_seen timestamptz not null default now(),
  primary key (search_id, item_id)
);

-- Rolling per-user API usage for quota enforcement.
create table public.api_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null default current_date,
  calls int not null default 0,
  primary key (user_id, day)
);

-- ── Saved listings & portfolio ────────────────────────────────────────────────

create table public.saved_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_id text not null,
  title text not null,
  price numeric(10,2),
  currency text not null default 'USD',
  image_url text,
  item_url text not null,
  seller text,
  saved_at timestamptz not null default now(),
  unique (user_id, item_id)
);

create table public.portfolio_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  item_id text,
  item_url text,
  image_url text,
  buy_price numeric(10,2),
  bought_at timestamptz not null default now(),
  sold_price numeric(10,2),
  sold_at timestamptz,
  fees numeric(10,2) not null default 0,
  shipping numeric(10,2) not null default 0,
  comp_price numeric(10,2),           -- user-entered or deal-score comp
  notes text,
  created_at timestamptz not null default now()
);
create index on public.portfolio_entries (user_id);

-- Snipes are scheduled client-side (chrome.alarms) but mirrored here so the
-- user's snipe list survives reinstalls and shows on other devices.
create table public.snipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_id text not null,
  title text,
  item_url text not null,
  max_bid numeric(10,2) not null,
  end_time timestamptz not null,
  lead_seconds int not null default 20,
  status text not null default 'armed',   -- armed | fired | canceled | expired
  created_at timestamptz not null default now(),
  unique (user_id, item_id)
);

-- ── Row-level security ────────────────────────────────────────────────────────

alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.saved_searches enable row level security;
alter table public.seen_items enable row level security;
alter table public.api_usage enable row level security;
alter table public.saved_listings enable row level security;
alter table public.portfolio_entries enable row level security;
alter table public.snipes enable row level security;
alter table public.plan_limits enable row level security;

create policy "own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "read own subscription" on public.subscriptions
  for select using (auth.uid() = user_id);
-- subscriptions are written only by the stripe-webhook function (service role)

create policy "own searches" on public.saved_searches
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own seen" on public.seen_items
  for all using (exists (select 1 from public.saved_searches s
                         where s.id = search_id and s.user_id = auth.uid()));
create policy "read own usage" on public.api_usage
  for select using (auth.uid() = user_id);
create policy "own saved listings" on public.saved_listings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own portfolio" on public.portfolio_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own snipes" on public.snipes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "plan limits are public" on public.plan_limits
  for select using (true);

-- ── Bootstrap trigger: create profile + trial subscription on signup ─────────

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  insert into public.subscriptions (user_id) values (new.id);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Atomic daily-quota increment used by edge functions. Returns true if the
-- call was within the cap, false if the ceiling was already reached.
create or replace function public.increment_api_usage(p_user_id uuid, p_cap int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_calls int;
begin
  insert into public.api_usage (user_id, day, calls)
  values (p_user_id, current_date, 1)
  on conflict (user_id, day) do update
    set calls = public.api_usage.calls + 1
  returning calls into v_calls;
  return v_calls <= p_cap;
end $$;

-- ── Housekeeping ──────────────────────────────────────────────────────────────

-- Cap seen_items per search (like the userscript's 2000-id LRU) — run daily via pg_cron.
create or replace function public.prune_seen_items()
returns void language sql security definer as $$
  delete from public.seen_items si
  using (
    select search_id, item_id,
           row_number() over (partition by search_id order by first_seen desc) rn
    from public.seen_items
  ) ranked
  where si.search_id = ranked.search_id
    and si.item_id = ranked.item_id
    and ranked.rn > 2000;
$$;
