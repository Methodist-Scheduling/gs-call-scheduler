-- GS Call Scheduler: database setup v1 (2026-11-05)
-- Run once in Supabase > SQL Editor. Safe to re-run: it creates only what is missing.
-- Roles: scheduler (PGY-4s build), chief (PGY-5s), pd (program director), resident (view), admin flag = can manage accounts.

-- ---------- tables ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9._-]{3,32}$'),
  display_name text not null,
  role text not null check (role in ('scheduler','chief','pd','resident')),
  is_admin boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.reference (      -- roster by month, PGY levels, Jul-Nov history, holidays, backtest
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists public.settings (       -- one row: rules, holiday trio order, leave dates
  id int primary key default 1 check (id = 1),
  rules jsonb not null default '{}'::jsonb,
  trio_swap jsonb not null default '{"xmas":false,"ny":false}'::jsonb,
  people jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.settings (id) values (1) on conflict do nothing;

create table if not exists public.months (         -- one row per schedule month, e.g. '2026-12'
  key text primary key check (key ~ '^\d{4}-\d{2}$'),
  status text not null default 'Draft' check (status in ('Draft','Scheduler review','PD review','Published')),
  data jsonb not null default '{}'::jsonb,         -- schedule, locks, inputs, accepted note rules, notes text
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists public.versions (
  id bigserial primary key,
  month_key text not null references public.months(key) on delete cascade,
  n int not null,
  status text not null,
  schedule jsonb not null,
  changed int,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (month_key, n)
);

create table if not exists public.activity_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid references auth.users(id),
  month_key text,
  text text not null
);

-- ---------- helpers (security definer so policies can read the caller's role) ----------
create or replace function public.my_role() returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;
create or replace function public.i_am_admin() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid() and active), false)
$$;
create or replace function public.i_am_active() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active)
$$;

-- stamp who/when on every write
create or replace function public.stamp() returns trigger language plpgsql as $$
begin new.updated_at = now(); new.updated_by = auth.uid(); return new; end $$;
drop trigger if exists stamp_months on public.months;     create trigger stamp_months before insert or update on public.months for each row execute function public.stamp();
drop trigger if exists stamp_settings on public.settings; create trigger stamp_settings before insert or update on public.settings for each row execute function public.stamp();
drop trigger if exists stamp_reference on public.reference; create trigger stamp_reference before insert or update on public.reference for each row execute function public.stamp();

-- profiles: only admins change role/admin/active; users can't promote themselves
create or replace function public.guard_profile() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.i_am_admin() and (new.role is distinct from old.role or new.is_admin is distinct from old.is_admin or new.active is distinct from old.active or new.username is distinct from old.username) then
    raise exception 'Only an admin can change username, role, admin or active.';
  end if;
  return new;
end $$;
drop trigger if exists guard_profile on public.profiles; create trigger guard_profile before update on public.profiles for each row execute function public.guard_profile();

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.reference enable row level security;
alter table public.settings enable row level security;
alter table public.months enable row level security;
alter table public.versions enable row level security;
alter table public.activity_log enable row level security;

drop policy if exists p_read on public.profiles;      create policy p_read on public.profiles for select to authenticated using (public.i_am_active());
drop policy if exists p_admin on public.profiles;     create policy p_admin on public.profiles for all to authenticated using (public.i_am_admin()) with check (public.i_am_admin());
drop policy if exists p_self on public.profiles;      create policy p_self on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists r_read on public.reference;     create policy r_read on public.reference for select to authenticated using (public.i_am_active());
drop policy if exists r_write on public.reference;    create policy r_write on public.reference for all to authenticated using (public.i_am_admin()) with check (public.i_am_admin());

drop policy if exists s_read on public.settings;      create policy s_read on public.settings for select to authenticated using (public.i_am_active());
drop policy if exists s_write on public.settings;     create policy s_write on public.settings for update to authenticated using (public.my_role() in ('scheduler','chief')) with check (public.my_role() in ('scheduler','chief'));

drop policy if exists m_read on public.months;        create policy m_read on public.months for select to authenticated using (public.i_am_active());
drop policy if exists m_insert on public.months;      create policy m_insert on public.months for insert to authenticated with check (public.my_role() in ('scheduler','chief'));
-- schedulers build; chiefs swap and enter picks; the PD approves or sends back. The app limits each role to its own actions.
drop policy if exists m_update on public.months;      create policy m_update on public.months for update to authenticated using (public.my_role() in ('scheduler','chief','pd')) with check (public.my_role() in ('scheduler','chief','pd'));

drop policy if exists v_read on public.versions;      create policy v_read on public.versions for select to authenticated using (public.i_am_active());
drop policy if exists v_insert on public.versions;    create policy v_insert on public.versions for insert to authenticated with check (public.my_role() in ('scheduler','chief','pd'));

drop policy if exists l_read on public.activity_log;  create policy l_read on public.activity_log for select to authenticated using (public.i_am_active());
drop policy if exists l_insert on public.activity_log; create policy l_insert on public.activity_log for insert to authenticated with check (public.i_am_active() and user_id = auth.uid());

-- expose to the API only what the app needs (new tables are not exposed automatically in this project)
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.reference, public.settings, public.months, public.versions, public.activity_log to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.my_role(), public.i_am_admin(), public.i_am_active() to authenticated;

-- live updates so two people see each other's changes
do $$ begin
  begin alter publication supabase_realtime add table public.months; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.settings; exception when duplicate_object then null; end;
end $$;

-- Newer Supabase projects don't auto-grant table access to service_role (used by the edge functions). Without this, login can't find usernames.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
