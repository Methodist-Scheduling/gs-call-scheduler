-- Any admin can edit attendings, any time (they don't change the call schedule).
drop policy if exists att_ins on public.attendings; create policy att_ins on public.attendings for insert to authenticated with check (public.i_am_admin());
drop policy if exists att_upd on public.attendings; create policy att_upd on public.attendings for update to authenticated using (public.i_am_admin()) with check (public.i_am_admin());
