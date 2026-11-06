-- "Preview as" (role switching on screen) is only for the account doing the testing.
alter table public.profiles add column if not exists can_preview boolean not null default false;
