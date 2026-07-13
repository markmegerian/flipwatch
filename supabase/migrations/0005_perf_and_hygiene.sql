-- Flipwatch — performance & hygiene pass (2026-07 audit).
--
-- 1. RLS initplan: wrap auth.uid() in a scalar subselect so Postgres evaluates
--    it once per statement instead of once per row (Supabase advisor 0003
--    flagged every policy below).
-- 2. poll_seconds floor: the panel clamps to the plan's min_poll_seconds in JS,
--    but PostgREST accepts direct writes — same reasoning as 0004, the
--    database is the real gate.
-- 3. api_usage retention: one row per user per day, never pruned. Fold a
--    30-day sweep into the existing nightly pruner; the function keeps its
--    name so the cron.schedule('prune-seen', ...) job from SETUP.md step 6
--    picks up the new body without rescheduling.

-- ── 1. RLS initplan ───────────────────────────────────────────────────────────

drop policy "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy "read own subscription" on public.subscriptions;
create policy "read own subscription" on public.subscriptions
  for select using ((select auth.uid()) = user_id);

drop policy "own searches" on public.saved_searches;
create policy "own searches" on public.saved_searches
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy "own seen" on public.seen_items;
create policy "own seen" on public.seen_items
  for all using (exists (select 1 from public.saved_searches s
                         where s.id = search_id and s.user_id = (select auth.uid())));

drop policy "read own usage" on public.api_usage;
create policy "read own usage" on public.api_usage
  for select using ((select auth.uid()) = user_id);

drop policy "own saved listings" on public.saved_listings;
create policy "own saved listings" on public.saved_listings
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy "own portfolio" on public.portfolio_entries;
create policy "own portfolio" on public.portfolio_entries
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy "own snipes" on public.snipes;
create policy "own snipes" on public.snipes
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ── 2. poll_seconds floor ─────────────────────────────────────────────────────

create or replace function public.clamp_poll_seconds()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_min int;
begin
  select pl.min_poll_seconds into v_min
  from public.subscriptions s
  join public.plan_limits pl on pl.tier = s.tier
  where s.user_id = new.user_id;
  new.poll_seconds := greatest(coalesce(new.poll_seconds, 60), coalesce(v_min, 60));
  return new;
end $$;

-- Internal trigger function — keep it off the public RPC surface (advisor 0028/0029).
revoke execute on function public.clamp_poll_seconds() from public, anon, authenticated;

create trigger clamp_poll_seconds
  before insert or update of poll_seconds on public.saved_searches
  for each row execute function public.clamp_poll_seconds();

-- ── 3. api_usage retention ────────────────────────────────────────────────────

create or replace function public.prune_seen_items()
returns void language sql security definer set search_path = public as $$
  delete from public.seen_items si
  using (
    select search_id, item_id,
           row_number() over (partition by search_id order by first_seen desc) rn
    from public.seen_items
  ) ranked
  where si.search_id = ranked.search_id
    and si.item_id = ranked.item_id
    and ranked.rn > 2000;
  delete from public.api_usage where day < current_date - 30;
$$;
