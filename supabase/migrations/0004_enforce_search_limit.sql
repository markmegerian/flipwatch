-- Flipwatch — enforce per-plan saved-search limits server-side.
-- The panel checks max_saved_searches before creating, but that's client JS:
-- anyone with their JWT could POST unlimited searches straight to PostgREST
-- and multiply their polling load. The database is the real gate.

create or replace function public.enforce_search_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_max int; v_count int;
begin
  select pl.max_saved_searches into v_max
  from public.subscriptions s
  join public.plan_limits pl on pl.tier = s.tier
  where s.user_id = new.user_id;
  v_max := coalesce(v_max, 3);
  select count(*) into v_count from public.saved_searches where user_id = new.user_id;
  if v_count >= v_max then
    raise exception 'search_limit_reached: plan allows % saved searches', v_max;
  end if;
  return new;
end $$;

-- Internal trigger function — keep it off the public RPC surface (advisor 0028/0029).
revoke execute on function public.enforce_search_limit() from public, anon, authenticated;

create trigger enforce_search_limit
  before insert on public.saved_searches
  for each row execute function public.enforce_search_limit();
