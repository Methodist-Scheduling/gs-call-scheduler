-- 007: private requests per resident, admin-only notes, enforced approval steps with a server-side audit log.
-- Safe to run more than once.

-- 1) Link each account to a roster name (how the app knows which resident an account is)
alter table public.profiles add column if not exists roster_name text;
create or replace function public.my_roster_name() returns text language sql stable security definer set search_path = public as $$
  select roster_name from public.profiles where id = auth.uid()
$$;

-- 2) Requests: residents see and add only their own; admins see and decide all. Accepted requests feed the build.
create table if not exists public.requests (
  id bigserial primary key,
  month_key text not null check (month_key ~ '^\d{4}-\d{2}$'),
  resident text not null,                                  -- roster name
  type text not null check (type in ('off','want','block','protected','colorectal')),
  days int[] not null,
  note text not null default '',
  status text not null default 'pending' check (status in ('pending','accepted','denied')),
  source text not null default 'resident' check (source in ('resident','admin','claude')),
  reason text not null default '',                         -- why it was denied (shown to the resident)
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  decided_by uuid references auth.users(id),
  decided_at timestamptz
);
create index if not exists requests_month on public.requests (month_key);
alter table public.requests enable row level security;
grant select, insert, update, delete on public.requests to authenticated;
grant usage, select on sequence public.requests_id_seq to authenticated;
grant select, insert, update, delete on public.requests to service_role;
drop policy if exists q_admin on public.requests;
create policy q_admin on public.requests for all to authenticated using (public.i_am_admin()) with check (public.i_am_admin());
drop policy if exists q_own_read on public.requests;
create policy q_own_read on public.requests for select to authenticated using (public.i_am_active() and created_by = auth.uid() and source = 'resident');
drop policy if exists q_own_insert on public.requests;
create policy q_own_insert on public.requests for insert to authenticated
  with check (public.i_am_active() and created_by = auth.uid() and source = 'resident' and status = 'pending'
              and resident = public.my_roster_name() and type in ('off','want','block','protected'));
drop policy if exists q_own_withdraw on public.requests;
create policy q_own_withdraw on public.requests for delete to authenticated using (created_by = auth.uid() and source = 'resident' and status = 'pending');

-- 3) Pasted notes are admin-only
create table if not exists public.month_notes (
  key text primary key check (key ~ '^\d{4}-\d{2}$'),
  notes_text text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.month_notes enable row level security;
grant select, insert, update on public.month_notes to authenticated;
grant select, insert, update, delete on public.month_notes to service_role;
drop policy if exists n_admin on public.month_notes;
create policy n_admin on public.month_notes for all to authenticated using (public.i_am_admin()) with check (public.i_am_admin());

-- 4) Move accepted rules and notes out of the months row (which every signed-in user can read)
insert into public.requests (month_key, resident, type, days, note, status, source, created_by, decided_at)
select m.key, c->>'name', c->>'type', array(select jsonb_array_elements_text(c->'days')::int), coalesce(c->>'reason', ''), 'accepted', 'admin', null, now()
from public.months m, jsonb_array_elements(coalesce(m.data->'constraints', '[]'::jsonb)) c
where c->>'type' in ('off','want','block','protected','colorectal') and c->>'name' is not null;
insert into public.month_notes (key, notes_text)
select key, data->>'notesText' from public.months where coalesce(data->>'notesText', '') <> ''
on conflict (key) do update set notes_text = excluded.notes_text;
update public.months set data = data - 'constraints' - 'notesText' where data ? 'constraints' or data ? 'notesText';

-- 5) Activity log: admins only (it names residents and their requests)
drop policy if exists l_read on public.activity_log;
create policy l_read on public.activity_log for select to authenticated using (public.i_am_admin());

-- 6) Approval steps enforced by the database, and logged by the database
create or replace function public.guard_month() returns trigger language plpgsql security definer set search_path = public as $$
declare r text := public.my_role(); ok boolean := false;
begin
  if auth.uid() is null then return new; end if;   -- SQL editor / service jobs
  if new.status is distinct from old.status then
    ok := (r in ('scheduler','chief') and (old.status, new.status) in (
             ('Draft','Scheduler review'), ('Draft','PD review'), ('Scheduler review','PD review'), ('Scheduler review','Draft'),
             ('Published','Scheduler review'), ('Published','Draft')))
       or (r = 'pd' and (old.status, new.status) in (('PD review','Published'), ('PD review','Scheduler review')));
    if not ok then raise exception 'Approval step not allowed: % to % (your role: %)', old.status, new.status, r; end if;
    if r = 'pd' and new.data is distinct from old.data then raise exception 'The PD approves or sends back; the schedule itself is edited by a scheduler or chief.'; end if;
  elsif new.data is distinct from old.data then
    if old.status = 'PD review' then raise exception 'The schedule is with the PD. Ask the PD to send it back before editing.'; end if;
    if r not in ('scheduler','chief') then raise exception 'Only a scheduler or chief edits the schedule.'; end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_month on public.months;
create trigger guard_month before update on public.months for each row execute function public.guard_month();

create or replace function public.log_month_status() returns trigger language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  select coalesce(display_name, username, 'someone') || ' (' || role || ')' into who from public.profiles where id = auth.uid();
  insert into public.activity_log (user_id, month_key, text)
  values (auth.uid(), new.key, 'Status: ' || coalesce(old.status, 'new') || ' → ' || new.status || ' · ' || coalesce(who, 'system') || ' [recorded by the database]');
  return new;
end $$;
drop trigger if exists log_month_status on public.months;
create trigger log_month_status after update on public.months for each row execute function public.log_month_status();

-- 7) Live updates for requests
do $$ begin
  alter publication supabase_realtime add table public.requests;
exception when duplicate_object then null; end $$;
