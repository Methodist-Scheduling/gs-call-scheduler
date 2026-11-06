-- Schedulers, PGY-5 chiefs and the PD are always admins. Residents are admins only if an admin ticks the box.
create or replace function public.roles_are_admins() returns trigger language plpgsql set search_path = public as $$
begin
  if new.role in ('scheduler', 'chief', 'pd') then new.is_admin := true; end if;
  return new;
end $$;
drop trigger if exists a_roles_are_admins on public.profiles;
create trigger a_roles_are_admins before insert or update on public.profiles for each row execute function public.roles_are_admins();
update public.profiles set is_admin = true where role in ('scheduler', 'chief', 'pd') and not is_admin;
