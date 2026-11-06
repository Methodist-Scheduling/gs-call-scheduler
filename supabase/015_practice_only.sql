-- Practice-only accounts: they sign in normally but the app runs a private in-browser practice copy.
-- The database also refuses every real write from them, so nothing they do can touch the real schedule.
alter table public.profiles add column if not exists practice_only boolean not null default false;

create or replace function public.my_role() returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active and not practice_only
$$;
create or replace function public.i_am_admin() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin and not practice_only from public.profiles where id = auth.uid() and active), false)
$$;
create or replace function public.my_roster_name() returns text language sql stable security definer set search_path = public as $$
  select roster_name from public.profiles where id = auth.uid() and active and not practice_only
$$;
drop policy if exists l_insert on public.activity_log;
create policy l_insert on public.activity_log for insert to authenticated with check (public.my_role() is not null and user_id = auth.uid());

-- nobody can switch practice_only (or preview) for themselves from the app
create or replace function public.guard_profile() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.can_preview is distinct from old.can_preview then
    raise exception 'Preview access is set in the database, not from the app.';
  end if;
  if auth.uid() is not null and new.practice_only is distinct from old.practice_only and not public.i_am_admin() then
    raise exception 'Only an admin can change practice-only.';
  end if;
  if not public.i_am_admin() and (new.role is distinct from old.role or new.is_admin is distinct from old.is_admin or new.active is distinct from old.active
      or (new.username is distinct from old.username and old.username is not null)) then
    raise exception 'Only an admin can change username, role, admin or active.';
  end if;
  return new;
end $$;
