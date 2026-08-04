-- Flipwatch — default user_id from the caller's JWT.
-- Found in the end-to-end smoke test: the extension's inserts (saved searches,
-- saved listings, portfolio entries, snipes) never send user_id, and the
-- columns had no default, so every insert failed RLS with 42501. Defaulting to
-- auth.uid() fixes all four writers and is safer than trusting a client-sent
-- id: ownership always comes from the verified JWT.

alter table public.saved_searches    alter column user_id set default auth.uid();
alter table public.saved_listings    alter column user_id set default auth.uid();
alter table public.portfolio_entries alter column user_id set default auth.uid();
alter table public.snipes            alter column user_id set default auth.uid();
