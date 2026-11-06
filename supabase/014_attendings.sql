-- Attendings per day (Trauma AM, Trauma PM, SICU, EGS/TBU). Everyone signed in can read;
-- schedulers, chiefs and the PD edit. Kept apart from the call schedule so the PD can edit
-- and residents can see it without the schedule being published.
create table if not exists public.attendings (
  month_key text primary key check (month_key ~ '^\d{4}-\d{2}$'),
  data jsonb not null default '{}'::jsonb,     -- { "1": {"tam":"..","tpm":"..","sicu":"..","egs":".."}, ... }
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid()
);
alter table public.attendings enable row level security;
grant select, insert, update on public.attendings to authenticated;
grant select, insert, update, delete on public.attendings to service_role;
drop policy if exists att_read on public.attendings;   create policy att_read on public.attendings for select to authenticated using (public.i_am_active());
drop policy if exists att_ins on public.attendings;    create policy att_ins on public.attendings for insert to authenticated with check (public.my_role() in ('scheduler','chief','pd'));
drop policy if exists att_upd on public.attendings;    create policy att_upd on public.attendings for update to authenticated using (public.my_role() in ('scheduler','chief','pd')) with check (public.my_role() in ('scheduler','chief','pd'));
do $$ begin
  begin alter publication supabase_realtime add table public.attendings; exception when duplicate_object then null; end;
end $$;
