-- People pick their own username from the invite link (admins no longer assign one).
alter table public.profiles alter column username drop not null;

create or replace function public.guard_profile() returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- non-admins may set their own username once (when it's still empty); everything else stays admin-only
  if not public.i_am_admin() and (new.role is distinct from old.role or new.is_admin is distinct from old.is_admin or new.active is distinct from old.active
      or (new.username is distinct from old.username and old.username is not null)) then
    raise exception 'Only an admin can change username, role, admin or active.';
  end if;
  return new;
end $$;

create or replace function public.claim_username(u text) returns text language plpgsql security definer set search_path = public as $$
declare v text := lower(trim(coalesce(u, '')));
begin
  if v !~ '^[a-z0-9._-]{3,32}$' then return 'Username: 3–32 lowercase letters, numbers, dot, dash or underscore.'; end if;
  if exists (select 1 from public.profiles where username = v and id <> auth.uid()) then return 'That username is taken. Try another.'; end if;
  update public.profiles set username = v where id = auth.uid() and username is null;
  if not found then return 'You already have a username.'; end if;
  return 'ok';
end $$;
revoke all on function public.claim_username(text) from public, anon;
grant execute on function public.claim_username(text) to authenticated;
