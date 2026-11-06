-- 011: resident-to-resident call trades. Requester asks -> other resident agrees/declines -> scheduler/chief approves/denies.
-- Residents only ever see swaps they're part of. Safe to run more than once.
create table if not exists public.swaps (
  id bigserial primary key,
  month_key text not null check (month_key ~ '^\d{4}-\d{2}$'),
  slot text not null check (slot in ('U','M','I')),
  day_a int not null,                 -- requester's call (target takes it)
  day_b int not null,                 -- target's call (requester takes it)
  requester text not null,            -- roster names
  target text not null,
  requester_id uuid references auth.users(id) on delete set null default auth.uid(),
  target_id uuid references auth.users(id) on delete set null,
  note text not null default '',
  status text not null default 'pending' check (status in ('pending','agreed','declined','approved','denied','withdrawn','cancelled')),
  target_reason text not null default '',
  admin_reason text not null default '',
  decided_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  target_at timestamptz,
  decided_at timestamptz,
  requester_seen boolean not null default false   -- requester has been told the outcome
);
create index if not exists swaps_month on public.swaps (month_key);
alter table public.swaps enable row level security;
grant select, insert, update on public.swaps to authenticated;
grant usage, select on sequence public.swaps_id_seq to authenticated;
grant select, insert, update, delete on public.swaps to service_role;

drop policy if exists sw_admin on public.swaps;
create policy sw_admin on public.swaps for all to authenticated using (public.i_am_admin()) with check (public.i_am_admin());
drop policy if exists sw_mine on public.swaps;
create policy sw_mine on public.swaps for select to authenticated using (public.i_am_active() and (requester_id = auth.uid() or target_id = auth.uid()));
drop policy if exists sw_ask on public.swaps;
create policy sw_ask on public.swaps for insert to authenticated
  with check (public.i_am_active() and requester_id = auth.uid() and requester = public.my_roster_name() and status = 'pending');
drop policy if exists sw_answer on public.swaps;
create policy sw_answer on public.swaps for update to authenticated using (requester_id = auth.uid() or target_id = auth.uid()) with check (requester_id = auth.uid() or target_id = auth.uid());

-- fill in who the other resident is, and keep non-admins to their own moves
create or replace function public.guard_swap() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    select id into new.target_id from public.profiles where roster_name = new.target and active limit 1;
    if new.target_id is null then raise exception '% doesn''t have an account yet, so they can''t answer a swap.', new.target; end if;
    if new.target = new.requester then raise exception 'You can''t swap with yourself.'; end if;
    if exists (select 1 from public.swaps s where s.month_key = new.month_key and s.status in ('pending','agreed')
               and ((s.requester = new.requester and s.day_a = new.day_a and s.slot = new.slot) or (s.target = new.target and s.day_b = new.day_b and s.slot = new.slot))) then
      raise exception 'There''s already an open swap for that call.'; end if;
    return new;
  end if;
  if public.i_am_admin() or auth.uid() is null then return new; end if;
  if (new.month_key, new.slot, new.day_a, new.day_b, new.requester, new.target, new.requester_id, new.target_id, new.admin_reason, new.decided_by)
     is distinct from (old.month_key, old.slot, old.day_a, old.day_b, old.requester, old.target, old.requester_id, old.target_id, old.admin_reason, old.decided_by) then
    raise exception 'Only the status of a swap can change.'; end if;
  if auth.uid() = old.target_id and old.status = 'pending' and new.status in ('agreed','declined') then new.target_at := now(); return new; end if;
  if auth.uid() = old.requester_id and old.status in ('pending','agreed') and new.status = 'withdrawn' then return new; end if;
  if auth.uid() = old.requester_id and new.status = old.status and new.requester_seen then return new; end if;   -- marking an outcome as read
  raise exception 'That swap step isn''t allowed.';
end $$;
drop trigger if exists guard_swap on public.swaps;
create trigger guard_swap before insert or update on public.swaps for each row execute function public.guard_swap();

-- residents need roster names to know who can be asked (names only)
-- (profiles are already readable by active users)

do $$ begin alter publication supabase_realtime add table public.swaps; exception when duplicate_object then null; end $$;
