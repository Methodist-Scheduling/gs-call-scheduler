-- Fix a typo in a roster name everywhere at once: roster and rotations, history, drafts, published schedules,
-- versions, requests, swaps, settings and linked accounts. Schedulers and chiefs only. Reversible (rename it back).
create or replace function public.rename_roster(old_name text, new_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pat text; rep text; n int := 0; c int;
begin
  if auth.uid() is not null and coalesce(public.my_role(), '') not in ('scheduler', 'chief') then
    raise exception 'Only a scheduler or chief can rename someone on the roster.';
  end if;
  old_name := btrim(old_name); new_name := btrim(new_name);
  if new_name !~ '^[A-Za-z][A-Za-z .''-]{0,30}$' then raise exception 'Use letters, spaces, hyphens or apostrophes (up to 31 characters).'; end if;
  if old_name = new_name then return jsonb_build_object('changed', 0); end if;
  if not exists (select 1 from public.reference where key = 'data' and value->'pgy' ? old_name) then raise exception '% is not on the roster.', old_name; end if;
  if exists (select 1 from public.reference where key = 'data' and value->'pgy' ? new_name) then raise exception '% is already on the roster.', new_name; end if;
  -- the name as a whole JSON string (a key or a value), with or without the cross-cover mark
  pat := '"' || regexp_replace(old_name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '( \(cross-cover\))?"';
  rep := '"' || new_name || '\1"';

  -- a rename is not a schedule change: skip the approval guard and don't publish a new version
  alter table public.months disable trigger user;
  alter table public.swaps disable trigger user;

  update public.reference set value = regexp_replace(value::text, pat, rep, 'g')::jsonb where value::text ~ pat;              get diagnostics c = row_count; n := n + c;
  update public.settings set rules = regexp_replace(rules::text, pat, rep, 'g')::jsonb, trio_swap = regexp_replace(trio_swap::text, pat, rep, 'g')::jsonb,
    people = regexp_replace(people::text, pat, rep, 'g')::jsonb where (rules::text || trio_swap::text || people::text) ~ pat;  get diagnostics c = row_count; n := n + c;
  update public.months set data = regexp_replace(data::text, pat, rep, 'g')::jsonb where data::text ~ pat;                    get diagnostics c = row_count; n := n + c;
  update public.versions set schedule = regexp_replace(schedule::text, pat, rep, 'g')::jsonb where schedule::text ~ pat;      get diagnostics c = row_count; n := n + c;
  update public.published set schedule = regexp_replace(schedule::text, pat, rep, 'g')::jsonb,
    rnd = case when rnd is null then null else regexp_replace(rnd::text, pat, rep, 'g')::jsonb end
    where (schedule::text || coalesce(rnd::text, '')) ~ pat;                                                                 get diagnostics c = row_count; n := n + c;
  update public.published_history set schedule = regexp_replace(schedule::text, pat, rep, 'g')::jsonb,
    rnd = case when rnd is null then null else regexp_replace(rnd::text, pat, rep, 'g')::jsonb end
    where (schedule::text || coalesce(rnd::text, '')) ~ pat;                                                                 get diagnostics c = row_count; n := n + c;
  update public.requests set resident = new_name where resident = old_name;                                                  get diagnostics c = row_count; n := n + c;
  update public.swaps set requester = case when requester = old_name then new_name else requester end,
    target = case when target = old_name then new_name else target end where old_name in (requester, target);                get diagnostics c = row_count; n := n + c;
  update public.profiles set roster_name = new_name where roster_name = old_name;                                            get diagnostics c = row_count; n := n + c;

  alter table public.months enable trigger user;
  alter table public.swaps enable trigger user;
  insert into public.activity_log (user_id, month_key, text) values (auth.uid(), null, 'Roster name changed: ' || old_name || ' → ' || new_name);
  return jsonb_build_object('changed', n);
end $$;
revoke all on function public.rename_roster(text, text) from public, anon;
grant execute on function public.rename_roster(text, text) to authenticated;
