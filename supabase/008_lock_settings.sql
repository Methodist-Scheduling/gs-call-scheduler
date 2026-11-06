-- Settings hold leave dates (e.g. parental leave) and two-person exceptions: admins only.
-- Residents get weekend rounding from the copy saved with each month (months.data.rnd).
drop policy if exists s_read on public.settings;
create policy s_read on public.settings for select to authenticated using (public.i_am_admin());
