-- 010: PD "Approved" step, PD-added requests, residents read only published schedules, sign-in alerts.
-- Safe to run more than once.

-- 1) Approval adds an "Approved" step: the PD signs off, schedulers publish when ready
alter table public.months drop constraint if exists months_status_check;
alter table public.months add constraint months_status_check check (status in ('Draft','Scheduler review','PD review','Approved','Published'));

create or replace function public.guard_month() returns trigger language plpgsql security definer set search_path = public as $$
declare r text := public.my_role(); ok boolean := false;
begin
  if auth.uid() is null then return new; end if;   -- SQL editor / service jobs
  if new.status is distinct from old.status then
    ok := (r in ('scheduler','chief') and (old.status, new.status) in (
             ('Draft','Scheduler review'), ('Draft','PD review'), ('Scheduler review','PD review'), ('Scheduler review','Draft'),
             ('Approved','Published'), ('Approved','Scheduler review'),
             ('Published','Scheduler review'), ('Published','Draft')))
       or (r = 'pd' and (old.status, new.status) in (('PD review','Published'), ('PD review','Approved'), ('PD review','Scheduler review')));
    if not ok then raise exception 'Approval step not allowed: % to % (your role: %)', old.status, new.status, r; end if;
    if r = 'pd' and new.data is distinct from old.data then raise exception 'The PD approves or sends back; the schedule itself is edited by a scheduler or chief.'; end if;
  elsif new.data is distinct from old.data then
    if old.status in ('PD review', 'Approved') then raise exception 'The schedule is with the PD or already approved. Send it back to the schedulers before editing.'; end if;
    if r not in ('scheduler','chief') then raise exception 'Only a scheduler or chief edits the schedule.'; end if;
  end if;
  return new;
end $$;

-- 2) Requests the PD adds (for anyone) are always honored
alter table public.requests drop constraint if exists requests_source_check;
alter table public.requests add constraint requests_source_check check (source in ('resident','admin','claude','pd'));

-- 3) Published copies: what residents see. Written by the database when a month is published (or a published month changes).
create table if not exists public.published (
  month_key text primary key,
  version int not null default 1,
  schedule jsonb not null,          -- [[upper, mid, intern], ...] by day
  rnd jsonb,                        -- weekend/holiday rounding blocks
  published_at timestamptz not null default now()
);
create table if not exists public.published_history (
  month_key text not null,
  version int not null,
  schedule jsonb not null,
  rnd jsonb,
  published_at timestamptz not null default now(),
  primary key (month_key, version)
);
alter table public.published enable row level security;
alter table public.published_history enable row level security;
grant select on public.published, public.published_history to authenticated;
grant select, insert, update, delete on public.published, public.published_history to service_role;
drop policy if exists pub_read on public.published;          create policy pub_read on public.published for select to authenticated using (public.i_am_active());
drop policy if exists pubh_read on public.published_history; create policy pubh_read on public.published_history for select to authenticated using (public.i_am_active());

create or replace function public.publish_copy() returns trigger language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if new.status <> 'Published' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'Published'
     and (new.data->'A') is not distinct from (old.data->'A') and (new.data->'rnd') is not distinct from (old.data->'rnd') then return new; end if;
  if new.data->'A' is null or jsonb_typeof(new.data->'A') <> 'array' then return new; end if;
  select coalesce(max(version), 0) + 1 into v from public.published_history where month_key = new.key;
  insert into public.published_history (month_key, version, schedule, rnd) values (new.key, v, new.data->'A', new.data->'rnd');
  insert into public.published (month_key, version, schedule, rnd, published_at) values (new.key, v, new.data->'A', new.data->'rnd', now())
    on conflict (month_key) do update set version = excluded.version, schedule = excluded.schedule, rnd = excluded.rnd, published_at = excluded.published_at;
  return new;
end $$;
drop trigger if exists publish_copy on public.months;
create trigger publish_copy after insert or update on public.months for each row execute function public.publish_copy();

-- 4) Drafts and versions are admin-only now (residents read the published copies)
drop policy if exists m_read on public.months;   create policy m_read on public.months for select to authenticated using (public.i_am_admin());
drop policy if exists v_read on public.versions; create policy v_read on public.versions for select to authenticated using (public.i_am_admin());

-- 5) What each person has already been told about (for "new schedule" / "your schedule changed" alerts)
create table if not exists public.seen_versions (
  user_id uuid not null references auth.users(id) on delete cascade,
  month_key text not null,
  version int not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, month_key)
);
alter table public.seen_versions enable row level security;
grant select, insert, update on public.seen_versions to authenticated;
grant select, insert, update, delete on public.seen_versions to service_role;
drop policy if exists sv_own on public.seen_versions;
create policy sv_own on public.seen_versions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 6) Live updates for published schedules
do $$ begin alter publication supabase_realtime add table public.published; exception when duplicate_object then null; end $$;

-- 7) Residents can see where each month is in approval (status only, no schedule)
create or replace view public.month_status with (security_invoker = false) as select key, status from public.months;
grant select on public.month_status to authenticated;
