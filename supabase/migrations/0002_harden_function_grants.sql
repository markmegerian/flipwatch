-- Flipwatch — lock internal functions out of the public RPC surface.
-- Supabase's security advisor flags SECURITY DEFINER functions executable by
-- anon/authenticated via /rest/v1/rpc/*. All three are internal: the signup
-- trigger runs as the auth admin, and the other two are called only by edge
-- functions (service role) or pg_cron. Without this, any signed-in user could
-- call increment_api_usage with another user's id and burn their daily quota.

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.increment_api_usage(uuid, int) from public, anon, authenticated;
revoke execute on function public.prune_seen_items() from public, anon, authenticated;
grant execute on function public.increment_api_usage(uuid, int) to service_role;
grant execute on function public.prune_seen_items() to service_role;

-- Pin the search path (advisor 0011) — the other two already set it inline.
alter function public.prune_seen_items() set search_path = public;
