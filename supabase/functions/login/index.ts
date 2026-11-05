// Sign in with USERNAME + password (emails stay private). Also sends self-serve reset emails.
// Deploy with "Verify JWT" turned OFF (people aren't signed in yet when they call this).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { action, username, password, redirectTo } = await req.json();
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: p } = await admin.from('profiles').select('id, active').eq('username', String(username || '').toLowerCase()).maybeSingle();
    const { data: u } = p ? await admin.auth.admin.getUserById(p.id) : { data: null };
    const email = u?.user?.email;
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
    if (action === 'reset') {
      if (email && p?.active) await anon.auth.resetPasswordForEmail(email, { redirectTo });
      return json({ ok: true }); // same answer either way, so usernames can't be fished for
    }
    if (!email || !p?.active || !password) return json({ error: 'Wrong username or password.' }, 401);
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error || !data.session) return json({ error: 'Wrong username or password.' }, 401);
    return json({ session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } });
  } catch (_e) { return json({ error: 'Sign-in failed. Try again.' }, 500); }
});
