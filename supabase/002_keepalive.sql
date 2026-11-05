-- Lets the weekly GitHub Action touch the database so the free plan never pauses (it pauses after 7 idle days).
create or replace function public.ping() returns text language sql stable as $$ select 'ok'::text $$;
grant execute on function public.ping() to anon, authenticated;
