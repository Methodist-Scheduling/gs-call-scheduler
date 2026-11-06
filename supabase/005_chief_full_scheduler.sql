-- PGY-5 chiefs can do everything the PGY-4 schedulers do (including starting a month's draft).
drop policy if exists m_insert on public.months;
create policy m_insert on public.months for insert to authenticated with check (public.my_role() in ('scheduler','chief'));
