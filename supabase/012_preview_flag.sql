-- "Preview as" (role switching on screen) is only for the account doing the testing.
alter table public.profiles add column if not exists can_preview boolean not null default false;
-- nobody can switch it on for themselves from the app (only from the Supabase SQL editor)
create or replace function public.guard_profile() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.can_preview is distinct from old.can_preview then
    raise exception 'Preview access is set in the database, not from the app.';
  end if;
  if not public.i_am_admin() and (new.role is distinct from old.role or new.is_admin is distinct from old.is_admin or new.active is distinct from old.active
      or (new.username is distinct from old.username and old.username is not null)) then
    raise exception 'Only an admin can change username, role, admin or active.';
  end if;
  return new;
end $$;
