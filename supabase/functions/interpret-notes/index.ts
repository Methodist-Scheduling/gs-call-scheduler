// Turns pasted request notes into proposed rules with Claude. The API key lives only here (Supabase secret ANTHROPIC_API_KEY).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: who } = await admin.auth.getUser(token);
    if (!who?.user) return json({ error: 'Please sign in again.' }, 401);
    const { data: me } = await admin.from('profiles').select('role, active').eq('id', who.user.id).maybeSingle();
    if (!me?.active) return json({ error: 'Your account is inactive.' }, 403);
    const isResident = me.role === 'resident'; // residents can fill in their own request form: short text, small reply
    const key = Deno.env.get('ANTHROPIC_API_KEY');
    if (!key) return json({ error: 'Claude isn’t connected yet (an admin needs to add the API key in Supabase).' }, 503);
    const { prompt } = await req.json();
    if (!prompt || (isResident && String(prompt).length > 2500)) return json({ error: 'Keep the request short.' }, 400);
    if (!prompt || String(prompt).length > 20000) return json({ error: 'Notes are empty or too long.' }, 400);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-5-5', max_tokens: isResident ? 300 : 2000, messages: [{ role: 'user', content: String(prompt) }] })
    });
    const out = await r.json();
    if (!r.ok) return json({ error: out?.error?.message || 'Claude request failed.' }, 502);
    const text = (out.content || []).map((c: { text?: string }) => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: 'Claude didn’t return rules. Try rewording the notes.' }, 502);
    return json(JSON.parse(m[0]));
  } catch (e) { return json({ error: String((e as Error).message || e) }, 500); }
});
