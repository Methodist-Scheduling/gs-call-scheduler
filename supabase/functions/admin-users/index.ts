// Account management for admins: list, create (invite), update role/admin/active, make a one-time password link.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const ROLES = ['scheduler', 'chief', 'pd', 'resident'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: who } = await admin.auth.getUser(token);
    if (!who?.user) return json({ error: 'Please sign in again.' }, 401);
    const { data: me } = await admin.from('profiles').select('*').eq('id', who.user.id).maybeSingle();
    if (!me?.active || !me?.is_admin) return json({ error: 'Only admins can manage accounts.' }, 403);
    const body = await req.json();
    const site = body.redirectTo || req.headers.get('origin') || Deno.env.get('SITE_URL') || '';
    const log = (text: string) => admin.from('activity_log').insert({ user_id: me.id, text: `${me.display_name} (admin): ${text}` });

    if (body.action === 'list') {
      const { data: profiles } = await admin.from('profiles').select('*').order('display_name');
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const byId = Object.fromEntries((list?.users || []).map((u) => [u.id, u]));
      return json({ users: (profiles || []).map((p) => ({ ...p, email: byId[p.id]?.email, confirmed: !!byId[p.id]?.last_sign_in_at })) });
    }

    if (body.action === 'create') {
      // username is optional: if blank, the person picks their own from the invite link
      const username = String(body.username || '').toLowerCase().trim() || null;
      if (username && !/^[a-z0-9._-]{3,32}$/.test(username)) return json({ error: 'Username: 3–32 lowercase letters, numbers, dot, dash or underscore.' }, 400);
      if (!ROLES.includes(body.role)) return json({ error: 'Pick a role.' }, 400);
      if (username) { const { data: taken } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
      if (taken) return json({ error: 'That username is taken.' }, 400); }
      let userId: string, link: string | null = null;
      if (body.send_email) {
        const { data, error } = await admin.auth.admin.inviteUserByEmail(body.email, { redirectTo: site });
        if (error) return json({ error: error.message }, 400); userId = data.user.id;
      } else {
        const { data, error } = await admin.auth.admin.generateLink({ type: 'invite', email: body.email, options: { redirectTo: site } });
        if (error) return json({ error: error.message }, 400); userId = data.user.id; link = data.properties.action_link;
      }
      const { error: pe } = await admin.from('profiles').insert({ id: userId, username, display_name: String(body.display_name).trim(), role: body.role, is_admin: !!body.is_admin });
      if (pe) return json({ error: pe.message }, 400);
      await log(`added ${username || String(body.display_name).trim()} as ${body.role}${body.is_admin ? ' (admin)' : ''}`);
      return json({ ok: true, link });
    }

    if (body.action === 'update') {
      if (body.id === me.id) return json({ error: 'You can’t change your own role, admin or active status.' }, 400);
      const patch: Record<string, unknown> = {};
      if (body.role !== undefined) { if (!ROLES.includes(body.role)) return json({ error: 'Bad role.' }, 400); patch.role = body.role; }
      if (body.is_admin !== undefined) patch.is_admin = !!body.is_admin;
      if (body.active !== undefined) patch.active = !!body.active;
      if (body.display_name !== undefined) patch.display_name = String(body.display_name).trim();
      const { data: target } = await admin.from('profiles').select('username').eq('id', body.id).maybeSingle();
      const { error } = await admin.from('profiles').update(patch).eq('id', body.id);
      if (error) return json({ error: error.message }, 400);
      if (body.active !== undefined) await admin.auth.admin.updateUserById(body.id, { ban_duration: body.active ? 'none' : '876000h' });
      await log(`changed ${target?.username}: ${JSON.stringify(patch)}`);
      return json({ ok: true });
    }

    if (body.action === 'link') {
      const { data: u } = await admin.auth.admin.getUserById(body.id);
      if (!u?.user?.email) return json({ error: 'No email on that account.' }, 400);
      const type = u.user.last_sign_in_at ? 'recovery' : 'invite';
      const { data, error } = await admin.auth.admin.generateLink({ type, email: u.user.email, options: { redirectTo: site } });
      if (error) return json({ error: error.message }, 400);
      return json({ link: data.properties.action_link });
    }
    return json({ error: 'Unknown action.' }, 400);
  } catch (e) { return json({ error: String((e as Error).message || e) }, 500); }
});
