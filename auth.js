// Sign-in, set-password, first-time setup, then hands off to app.js (window.startScheduler).
(async () => {
  const cfg = window.GS_CONFIG;
  const params = new URLSearchParams(location.hash.slice(1));
  const flow = params.get('type');                    // 'invite' or 'recovery' when arriving from a link
  const linkError = params.get('error_description');
  const sb = supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, detectSessionInUrl: false } }); // we read setup links ourselves so they can't silently replace whoever is signed in
  const auth = document.getElementById('auth');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const card = html => { auth.hidden = false; document.getElementById('shell').hidden = true; auth.innerHTML = `<div class="authcard"><h1>GS Call Scheduler</h1>${html}</div>`; };

  function showLogin(msg) {
    card(`<p class="muted small">General Surgery call schedule</p>
      <form id="loginForm" style="display:grid;gap:12px">
        <label>Username<input id="lu" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
        <label>Password<input id="lp" type="password" autocomplete="current-password" required></label>
        <div class="err" id="lerr">${esc(msg || '')}</div>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
      <button class="btn" id="forgot" type="button">Forgot password</button>
      <p class="small muted">No account? Ask a scheduler, chief or the PD to add you.</p>`);
    document.getElementById('loginForm').onsubmit = async e => {
      e.preventDefault(); const err = document.getElementById('lerr'); err.textContent = 'Signing in…';
      const { data, error } = await sb.functions.invoke('login', { body: { username: document.getElementById('lu').value.trim().toLowerCase(), password: document.getElementById('lp').value } });
      if (error || !data || data.error) { err.textContent = (data && data.error) || 'Sign-in failed. Check your username and password.'; return; }
      const { error: e2 } = await sb.auth.setSession(data.session); if (e2) { err.textContent = e2.message; return; }
      boot();
    };
    document.getElementById('forgot').onclick = async () => {
      const u = document.getElementById('lu').value.trim().toLowerCase(); const err = document.getElementById('lerr');
      if (!u) { err.textContent = 'Type your username first, then click Forgot password.'; return; }
      await sb.functions.invoke('login', { body: { action: 'reset', username: u, redirectTo: location.origin + location.pathname } });
      err.textContent = 'If that username exists, a reset link was emailed to its owner. An admin can also send you one.';
    };
  }

  async function showSetPassword(isInvite, onlyUsername) {
    const { data: { user } } = await sb.auth.getUser();
    const { data: prof } = user ? await sb.from('profiles').select('username').eq('id', user.id).maybeSingle() : { data: null };
    const needUser = prof && !prof.username;
    card(`<p>${onlyUsername ? 'Pick a username to finish setting up your account.' : isInvite ? 'Welcome. Pick a username and password to finish setting up your account.' : 'Pick a new password.'}</p>
      <form id="pwForm" style="display:grid;gap:12px">
        ${needUser ? '<label>Username (what you’ll sign in with: 3–32 lowercase letters, numbers, dot, dash or underscore)<input id="pu" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>' : ''}
        ${onlyUsername ? '' : `
        <label>New password (10+ characters)<input id="p1" type="password" autocomplete="new-password" minlength="10" required></label>
        <label>Type it again<input id="p2" type="password" autocomplete="new-password" minlength="10" required></label>`}
        <div class="err" id="perr"></div>
        <button class="btn primary" type="submit">Save</button>
      </form>`);
    document.getElementById('pwForm').onsubmit = async e => {
      e.preventDefault(); const err = document.getElementById('perr'); err.textContent = '';
      if (!onlyUsername) { const a = document.getElementById('p1').value, b = document.getElementById('p2').value;
        if (a !== b) { err.textContent = 'The two passwords don’t match.'; return; } }
      // password first, then username: if the username step fails they're asked again, and nobody ends up with a username but no password
      if (!onlyUsername) { const { error } = await sb.auth.updateUser({ password: document.getElementById('p1').value });
        if (error) { err.textContent = error.message; return; } }
      if (needUser) { const { data: msg, error: ue } = await sb.rpc('claim_username', { u: document.getElementById('pu').value });
        if (ue || msg !== 'ok') { err.textContent = (ue && ue.message) || msg; return; } }
      history.replaceState(null, '', location.pathname + '#schedule'); boot();
    };
  }

  async function showImport(profile) {
    card(`<p>Signed in as <b>${esc(profile.display_name)}</b>. The roster and call history aren’t loaded yet.</p>
      <p class="small muted">Upload the setup bundle from your Mac: Schedule / 3 Claude Workspace / Data / <b>2026-11-05-scheduler-setup-bundle.json</b>. It stays in the database, never in the website code.</p>
      <input type="file" id="bundle" accept="application/json,.json">
      <div class="err" id="ierr"></div>
      <button class="btn" id="so2" type="button">Sign out</button>`);
    document.getElementById('so2').onclick = () => sb.auth.signOut().then(() => location.reload());
    document.getElementById('bundle').onchange = async e => {
      const err = document.getElementById('ierr'); err.textContent = 'Loading…';
      try {
        const j = JSON.parse(await e.target.files[0].text());
        if (!j.data || !j.data.rotations || !j.pre) throw new Error('That file isn’t the setup bundle.');
        const rows = [{ key: 'data', value: j.data }, { key: 'backtest', value: j.backtest || {} }, { key: 'pre', value: j.pre }];
        const { error } = await sb.from('reference').upsert(rows); if (error) throw error;
        if (j.settings) { // seed private settings (leave dates, two-person exceptions) once
          const { data: cur } = await sb.from('settings').select('rules,people').eq('id', 1).maybeSingle();
          if (cur) {
            const rules = Object.assign({}, cur.rules || {}); if (j.settings.noTwoPerson && !(rules.noTwoPerson || []).length) rules.noTwoPerson = j.settings.noTwoPerson;
            const people = Object.keys(cur.people || {}).length ? cur.people : (j.settings.people || {});
            await sb.from('settings').update({ rules, people }).eq('id', 1);
          }
        }
        boot();
      } catch (x) { err.textContent = x.message; }
    };
  }

  async function boot() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return showLogin();
    const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (!profile) { card('<p>Your login works, but your account isn’t set up in the scheduler yet. Ask an admin.</p><button class="btn" id="so">Sign out</button>'); document.getElementById('so').onclick = () => sb.auth.signOut().then(() => location.reload()); return; }
    if (!profile.username) return showSetPassword(true); // not set up yet: pick username AND password before getting in
    if (!profile.active) { card('<p>This account is turned off. Ask an admin if that’s a mistake.</p><button class="btn" id="so">Sign out</button>'); document.getElementById('so').onclick = () => sb.auth.signOut().then(() => location.reload()); return; }
    const [refQ, setQ, monQ, verQ, logQ] = await Promise.all([
      sb.from('reference').select('key,value'),
      sb.from('settings').select('*').eq('id', 1).maybeSingle(),
      sb.from('months').select('*'),
      sb.from('versions').select('month_key,n,status,schedule,changed,created_at').order('n'),
      sb.from('activity_log').select('month_key,at,text').order('at', { ascending: false }).limit(300)
    ]);
    const ref = {}; (refQ.data || []).forEach(r => ref[r.key] = r.value);
    if (!ref.data || !ref.pre) { if (profile.is_admin) return showImport(profile); card('<p>The scheduler isn’t loaded with data yet. Ask an admin.</p>'); return; }
    auth.hidden = true; document.getElementById('shell').hidden = false;
    document.getElementById('whoName').textContent = `${profile.display_name} · ${({ scheduler: 'Scheduler', chief: 'PGY-5 chief', pd: 'PD', resident: 'Resident' })[profile.role]}${profile.is_admin ? ' · admin' : ''}`;
    document.getElementById('previewWrap').hidden = !profile.can_preview; // only the tester account gets "Preview as"
    document.getElementById('peopleTab').hidden = !profile.is_admin;
    document.getElementById('signOut').onclick = () => sb.auth.signOut().then(() => { location.hash = ''; location.reload(); });
    if (!location.hash || location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + '#schedule');
    // if another tab signs out or switches accounts, don't keep showing this account's screens on a dead session
    sb.auth.onAuthStateChange((evt, sess) => { if (evt === 'INITIAL_SESSION' || evt === 'TOKEN_REFRESHED') return; if (!sess || sess.user.id !== user.id) {
      const b = document.createElement('div'); b.className = 'modal-ov'; b.innerHTML = '<div class="modal"><h3 style="margin-top:0">You were signed out</h3><p class="small">This browser signed out or switched to another account in a different tab. Reload to continue.</p><button class="btn primary" id="rl">Reload</button></div>';
      document.body.appendChild(b); b.querySelector('#rl').onclick = () => { location.hash = '#schedule'; location.reload(); }; } });
    window.startScheduler({ sb, user, profile, ref, settings: setQ.data, months: monQ.data || [], versions: verQ.data || [], logs: logQ.data || [] });
  }

  if (linkError) return showLogin('That link didn’t work (' + linkError.replace(/\+/g, ' ') + '). Ask an admin for a new one.');
  // A setup/reset link carries a sign-in for its account. If someone else is already signed in in this browser,
  // opening it would sign them out in every tab (that's what broke the admin session during testing), so ask first.
  const linkTok = params.get('access_token'), linkRef = params.get('refresh_token');
  if (linkTok && linkRef) {
    const { data: { session: here } } = await sb.auth.getSession();
    let linkUser = null; try { linkUser = JSON.parse(atob(linkTok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch (e) {}
    const take = async () => { const { error } = await sb.auth.setSession({ access_token: linkTok, refresh_token: linkRef }); if (error) return showLogin('That link didn’t work (' + error.message + '). Ask an admin for a new one.'); return showSetPassword(flow === 'invite'); };
    if (here && linkUser && here.user.id !== linkUser) {
      const keepHash = location.hash; history.replaceState(null, '', location.pathname);
      card(`<p><b>This link is for a different account.</b></p><p class="small">You’re signed in here as <b>${esc(here.user.email || 'someone else')}</b>. Opening the link in this browser signs that account out in every tab.</p>
        <p class="small">Best: copy the link into a <b>private window</b> (Safari: File → New Private Window; Chrome: New Incognito Window).</p>
        <div class="row" style="gap:8px;margin-top:10px"><button class="btn primary" id="stay">Stay signed in as me</button><button class="btn" id="swap">Use the link here anyway</button></div>`);
      document.getElementById('stay').onclick = () => { location.hash = '#schedule'; location.reload(); };
      document.getElementById('swap').onclick = () => { history.replaceState(null, '', location.pathname + keepHash); take(); };
      return;
    }
    history.replaceState(null, '', location.pathname);
    return take();
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session && (flow === 'invite' || flow === 'recovery')) return showSetPassword(flow === 'invite');
  if (!session) return showLogin();
  boot();
})();
