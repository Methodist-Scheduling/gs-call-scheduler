-- Run AFTER inviting yourself in Supabase > Authentication > Users > Invite user.
-- Change the email/username/name below, then run. Makes that login the first admin.
insert into public.profiles (id, username, display_name, role, is_admin)
select id, 'your-username', 'Your Name', 'scheduler', true from auth.users where email = 'CHANGE-ME@example.com'
on conflict (id) do update set is_admin = true;
