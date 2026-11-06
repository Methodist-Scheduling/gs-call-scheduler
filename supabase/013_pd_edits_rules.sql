-- The PD can change any rule setting on the Rules tab (targets, limits, two-person exceptions).
drop policy if exists s_write on public.settings;
create policy s_write on public.settings for update to authenticated
  using (public.my_role() in ('scheduler','chief','pd')) with check (public.my_role() in ('scheduler','chief','pd'));
