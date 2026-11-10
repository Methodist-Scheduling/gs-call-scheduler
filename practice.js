// Practice mode: a private, in-browser copy of the app for trying things out.
// Nothing here is saved to the real database. Pretend residents, schedulers and the PD answer on a 10-second timer,
// and a checklist walks each role through the app. Reloading (or "Reset practice") starts over.
(function () {
  const BOT_DELAY = 10000;
  const clone = x => JSON.parse(JSON.stringify(x));
  const now = () => new Date().toISOString();
  const KEY_OF = { months: ['key'], month_notes: ['key'], attendings: ['month_key'], published: ['month_key'], settings: ['id'], reference: ['key'], seen_versions: ['user_id', 'month_key'] };

  function makeFake(seed, realSb, hooks) {
    const T = seed; let nid = 1000; const handlers = {};
    const emit = (table, row) => (handlers[table] || []).forEach(cb => { try { cb({ new: clone(row), eventType: 'UPDATE' }); } catch (e) { console.error(e); } });
    const keyOf = (t, r) => (KEY_OF[t] || ['id']).map(c => r[c]).join('|');
    const statusView = () => (T.months || []).map(m => ({ key: m.key, status: m.status }));
    const afterWrite = (t, rows, op, byBot) => {
      if (t === 'months') rows.forEach(m => { if (m.status === 'Published' && m.data && Array.isArray(m.data.A)) { // what the publish_copy trigger does
        const prev = T.published.find(p => p.month_key === m.key); const same = prev && JSON.stringify(prev.schedule) === JSON.stringify(m.data.A) && JSON.stringify(prev.rnd) === JSON.stringify(m.data.rnd || null);
        if (!same) { const v = T.published_history.filter(h => h.month_key === m.key).reduce((a, h) => Math.max(a, h.version), 0) + 1;
          T.published_history.push({ month_key: m.key, version: v, schedule: clone(m.data.A), rnd: clone(m.data.rnd || null), published_at: now() });
          T.published = T.published.filter(p => p.month_key !== m.key).concat([{ month_key: m.key, version: v, schedule: clone(m.data.A), rnd: clone(m.data.rnd || null), published_at: now() }]); } } });
      if (byBot) rows.forEach(r => emit(t, r));
      try { hooks.onWrite && hooks.onWrite(t, op, clone(rows), byBot); } catch (e) { console.error(e); }
    };
    const DEFAULTS = { // what the database fills in on insert
      swaps: x => ({ status: 'pending', target_reason: '', admin_reason: '', requester_seen: false, target_id: (T.profiles.find(p => p.roster_name === x.target) || {}).id || null }),
      requests: () => ({ reason: '' }), activity_log: () => ({ at: now() }) };
    function q(t) {
      const f = []; let ord = null, lim = null, op = 'select', payload = null, upOpts = null;
      const rowsOf = () => t === 'month_status' ? statusView() : (T[t] = T[t] || []);
      const match = () => rowsOf().filter(r => f.every(fn => fn(r)));
      const run = () => {
        if (op === 'select') { let r = match().map(clone); if (ord) r.sort((a, b) => (a[ord.c] > b[ord.c] ? 1 : a[ord.c] < b[ord.c] ? -1 : 0) * (ord.asc ? 1 : -1)); if (lim) r = r.slice(0, lim); return { data: r, error: null }; }
        if (op === 'insert') { const list = (Array.isArray(payload) ? payload : [payload]).map(x => Object.assign({ id: nid++, created_at: now() }, DEFAULTS[t] ? DEFAULTS[t](x) : {}, clone(x))); rowsOf().push(...list); afterWrite(t, list, 'insert', false); return { data: list.map(clone), error: null }; }
        if (op === 'upsert') { const list = (Array.isArray(payload) ? payload : [payload]).map(clone), out = [];
          list.forEach(x => { const ex = rowsOf().find(r => keyOf(t, r) === keyOf(t, x)); if (ex) { Object.assign(ex, x); out.push(ex); } else { const n = Object.assign({ id: nid++, created_at: now() }, x); rowsOf().push(n); out.push(n); } });
          afterWrite(t, out, 'upsert', false); return { data: out.map(clone), error: null }; }
        if (op === 'update') { const m = match(); m.forEach(r => Object.assign(r, clone(payload), t === 'months' ? { updated_at: now() } : {})); afterWrite(t, m, 'update', false); return { data: m.map(clone), error: null }; }
        if (op === 'delete') { const m = match(); T[t] = rowsOf().filter(r => !m.includes(r)); afterWrite(t, m, 'delete', false); return { data: m.map(clone), error: null }; }
      };
      const b = {
        select() { return b; }, eq(c, v) { f.push(r => r[c] === v); return b; }, neq(c, v) { f.push(r => r[c] !== v); return b; }, in(c, v) { f.push(r => v.includes(r[c])); return b; },
        order(c, o) { ord = { c, asc: !o || o.ascending !== false }; return b; }, limit(n) { lim = n; return b; },
        insert(x) { op = 'insert'; payload = x; return b; }, upsert(x, o) { op = 'upsert'; payload = x; upOpts = o; return b; }, update(x) { op = 'update'; payload = x; return b; }, delete() { op = 'delete'; return b; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: null }); },
        single() { const r = run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: null }); },
        then(ok, bad) { return Promise.resolve().then(run).then(ok, bad); }
      };
      return b;
    }
    const fake = {
      from: q,
      rpc: () => Promise.resolve({ data: null, error: { message: 'Not available in practice.' } }),
      channel() { const ch = { on(evt, filt, cb) { const t = filt && filt.table; if (t) (handlers[t] = handlers[t] || []).push(cb); return ch; }, subscribe() { return ch; } }; return ch; },
      removeChannel() {},
      functions: { invoke(name, opts) {
        if (name === 'admin-users') { const body = (opts && opts.body) || {};
          if (body.action === 'list') return Promise.resolve({ data: { users: T.profiles.map(p => Object.assign({ email: p.username ? p.username + '@practice.example' : '', confirmed: true }, p)) }, error: null });
          return Promise.resolve({ data: { error: 'People changes are turned off in practice mode.' }, error: null }); }
        if (name === 'interpret-notes') return realSb.functions.invoke(name, opts); // reads text only; nothing is saved
        return Promise.resolve({ data: { error: 'Not available in practice.' }, error: null }); } },
      auth: realSb.auth,
      // bots write through here so the app hears about it like a change from another person
      bot(table, op, payloadOrFilter, patch) {
        if (op === 'insert') { const list = (Array.isArray(payloadOrFilter) ? payloadOrFilter : [payloadOrFilter]).map(x => Object.assign({ id: nid++, created_at: now() }, clone(x))); T[table].push(...list); afterWrite(table, list, 'insert', true); return list; }
        if (op === 'update') { const m = T[table].filter(payloadOrFilter); m.forEach(r => Object.assign(r, clone(patch), table === 'months' ? { updated_at: now() } : {})); afterWrite(table, m, 'update', true); return m; }
      },
      tables: T
    };
    return fake;
  }

  // ---------- seeding ----------
  function seed(profile, user, ref, role) {
    const D = ref.data, pre = ref.pre, pgy = D.pgy, names = Object.keys(D.rotations['2026-12'] || {});
    const roster = names.filter(n => pgy[n] !== undefined);
    const me = Object.assign({}, profile, { role, is_admin: role !== 'resident', can_preview: false, practice_only: true });
    if (role === 'resident' && !me.roster_name) me.roster_name = names.find(n => pgy[n] === 1) || names[0];
    const others = roster.filter(n => n !== me.roster_name).map((n, i) => ({ id: 'p' + i, display_name: n + ' (practice)', roster_name: n, username: n.toLowerCase(), active: true, role: pgy[n] === 4 ? 'scheduler' : pgy[n] === 5 ? 'chief' : 'resident', is_admin: [4, 5].includes(pgy[n]) }));
    others.push({ id: 'ppd', display_name: 'Program Director (practice)', roster_name: null, username: 'pd', active: true, role: 'pd', is_admin: true });
    const T = { profiles: [me].concat(others), reference: Object.entries(ref).map(([key, value]) => ({ key, value })), settings: [{ id: 1, rules: {}, trio_swap: { xmas: false, ny: false }, people: {} }],
      months: [], versions: [], activity_log: [], requests: [], swaps: [], month_notes: [], published: [], published_history: [], seen_versions: [], attendings: [] };
    let A = pre.A; const low = roster.filter(n => [1, 2, 3].includes(pgy[n]));
    try { // safety net: if the stored draft ever falls behind the rules, practice builds a clean one instead of showing rule breaks
      const E = window.CallEngine, inp = window.BuildInput.buildInput(D, 2026, 12, 'draft'), x = pre.trios.Christmas, n = pre.trios.NewYear;
      [[23, x[0]], [25, x[0]], [27, x[0]], [24, x[1]], [26, x[1]], [30, n[0]], [31, n[1]]].forEach(([d, t]) => inp.locks.push({ day: d, slot: 'U', name: t[2] }, { day: d, slot: 'M', name: t[1] }, { day: d, slot: 'I', name: t[0] }));
      const hard = E.evaluate(E.prepare(inp), A.map(([U, M, I]) => ({ U, M, I }))).issues.filter(i => i.sev === 'hard').length;
      if (hard) { const r = E.solve(inp, { seed: 4242, iters: 30000 }); A = r.A.map(a => [a.U || null, a.M || null, a.I || null]); pre.A = A; }
    } catch (e) {}
    const pick = (arr, i) => arr[i % arr.length];
    if (role === 'resident') { // December is out; residents see the published copy
      T.months.push({ key: '2026-12', status: 'Published', data: { A: clone(A) }, updated_at: now() });
      T.published.push({ month_key: '2026-12', version: 1, schedule: clone(A), rnd: null, published_at: now() });
      T.published_history.push({ month_key: '2026-12', version: 1, schedule: clone(A), rnd: null, published_at: now() });
    } else if (role === 'pd') {
      T.months.push({ key: '2026-12', status: 'PD review', data: { A: clone(A) }, updated_at: now() });
      T.versions.push({ month_key: '2026-12', n: 1, status: 'PD review', schedule: clone(A), changed: null, created_at: now() });
      T.activity_log.push({ month_key: '2026-12', at: now(), text: 'Scheduler: Sent to the PD for review' });
    } else {
      // a handful of resident requests waiting to be decided
      const offs = [[pick(low, 1), 'off', [12], 'Brother’s wedding'], [pick(low, 3), 'off', [19, 20], 'Out of town'], [pick(low, 5), 'want', [6], 'Trading for a weekend later'], [pick(low, 7), 'off', [31], 'New Year’s with family'], [pick(low, 9), 'protected', [16], 'Mock orals']];
      offs.forEach(([n, type, days, note], i) => { const p = others.find(o => o.roster_name === n); T.requests.push({ id: 900 + i, month_key: '2026-12', resident: n, type, days, note, status: 'pending', source: 'resident', reason: '', created_by: p ? p.id : 'x', created_at: new Date(Date.now() - (6 - i) * 3600e3).toISOString() }); });
    }
    return { T, me, others };
  }

  // ---------- coach ----------
  const STEPS = {
    sched: [
      { id: 'req', tab: 'notes', t: 'Decide the waiting requests', d: 'Requests tab: five residents asked for things. Accept or deny each one (a denied request needs a reason they’ll see).' },
      { id: 'inputs', tab: 'inputs', t: 'Look over Inputs', d: 'Rotations, vacations and PGY-5/fellow picks feed the schedule. Fix anything that changed, then come back to Schedule.' },
      { id: 'build', tab: 'schedule', t: 'Rebuild the schedule', d: 'Schedule tab: “Regenerate around locks” keeps what’s locked and redoes the rest with the accepted requests. Click any name to edit a day by hand.' },
      { id: 'stats', tab: 'dashboard', t: 'Check Stats', d: 'Look for anyone under or over target, every-other-day calls, and weekend balance. Click an item to see it on a calendar.' },
      { id: 'send', tab: 'approval', t: 'Send it to the PD', d: 'Approval tab: “Send to the PD”. The pretend PD answers in about 10 seconds: approved, or sent back with a note.' },
      { id: 'approved', tab: 'approval', t: 'Get it approved', d: 'If the PD sent it back, her request is already accepted: hit “Rebuild with the PD’s requests” on the Schedule tab, then send it again. Once approved, move on.' },
      { id: 'publish', tab: 'approval', t: 'Publish it', d: 'Approval tab: “Publish”. Residents would now see it. About 10 seconds later, a couple of residents ask to trade calls.' },
      { id: 'swaps', tab: 'notes', t: 'Handle the swap requests', d: 'Requests tab → Swaps: both residents already agreed. Approve or deny (the app shows any rule a swap would break).' }
    ],
    res: [
      { id: 'mine', tab: 'schedule', t: 'Find your calls', d: 'Schedule tab: your name is highlighted. Tap “My calls only” to see just your days (and any weekend rounding).' },
      { id: 'req', tab: 'notes', t: 'Ask for a day off', d: 'Requests tab: pick January, choose “Day off”, enter a day and a short reason, Send. A pretend scheduler answers in about 10 seconds.' },
      { id: 'trade', tab: 'schedule', t: 'Ask to trade a call', d: 'Schedule tab: tap one of YOUR calls in December, pick who to trade with and which of their days you’d take, Send. They answer, then a scheduler approves, about 10 seconds each.' },
      { id: 'answer', tab: 'notes', t: 'Answer a trade someone asked you for', d: 'Requests tab → Trades: another resident wants one of your calls. Agree or decline. If you agree, a scheduler still has to approve it.' }
    ],
    pd: [
      { id: 'open', tab: 'approval', t: 'Open the schedule you were sent', d: 'Approval tab: the schedulers sent December for your review. Look over the calendar on the Schedule tab too.' },
      { id: 'decide', tab: 'approval', t: 'Approve it, or send it back', d: 'Try “Send back with changes”: write a comment like “Can [a resident] be off the 14th?” and hit Send back. Claude reads it and fills in the request for you to check; requests are accepted automatically. The pretend schedulers return a changed version in about 10 seconds. Then approve.' },
      { id: 'att', tab: 'inputs', t: 'Enter the attendings', d: 'Inputs tab → Attendings (top). Use the Fill bar: pick “Trauma AM + PM”, type a name, choose days 1–7, Fill. Do SICU and EGS/TBU the same way. Fill at least a week.' },
      { id: 'req', tab: 'notes', t: 'Make a request (yours are always honored)', d: 'Requests tab → “Add a rule by hand”: give anyone a day off, block a day, or protect an event, for a resident or for yourself. Anything you add is always honored, and the schedulers see it marked “PD”. Try one, e.g. a resident off on Dec 18.' },
      { id: 'cal', tab: 'schedule', t: 'See them on the calendar', d: 'Schedule tab: attendings now show under each day, for everyone, and on the PDF.' },
      { id: 'stats', tab: 'dashboard', t: 'Look at Stats', d: 'This month and Year to date. Hover any number or bar for details.' },
      { id: 'rules', tab: 'rules', t: 'Rules', d: 'You can change any setting here (targets, limits, two-person exceptions). Every rule is written out in plain English below.' },
      { id: 'hist', tab: 'history', t: 'History', d: 'Past months as published, and how the app would have done them. Hover a number to see where the problems were.' }
    ]
  };

  window.GSPractice = {
    start({ realSb, user, profile, ref, role, canLeave }) {
      const { T, me, others } = seed(profile, user, ref, role);
      const kind = role === 'pd' ? 'pd' : role === 'resident' ? 'res' : 'sched', steps = STEPS[kind], done = new Set(), visited = new Set();
      const st = { seedA: JSON.stringify(ref.pre.A), sentOnce: false, pdBusy: false, revised: false, swapsMade: false };
      let fake;
      const month = () => T.months.find(m => m.key === '2026-12');
      const msg = (title, body) => { const ov = document.createElement('div'); ov.className = 'modal-ov pmsg'; ov.innerHTML = `<div class="modal"><div class="pill" style="margin-bottom:8px">Practice</div><h3 style="margin-top:0">${title}</h3><p class="small">${body}</p><div class="row" style="justify-content:flex-end"><button class="btn primary">OK</button></div></div>`; document.body.appendChild(ov); ov.querySelector('button').onclick = () => ov.remove(); ov.onclick = e => { if (e.target === ov) ov.remove(); }; };
      const nameOf = (A, d, s) => A[d - 1] && A[d - 1][s === 'U' ? 0 : s === 'M' ? 1 : 2];
      const weekdays = () => Array.from({ length: 31 }, (_, i) => i + 1).filter(d => { const w = new Date(2026, 11, d).getDay(); return w >= 1 && w <= 4 && d < 22; });

      const bots = {
        onWrite(t, op, rows, byBot) {
          if (byBot) { if (t === 'months') rows.forEach(m => { if (kind === 'sched' && ['Approved', 'Published'].includes(m.status)) done.add('approved'); }); return refresh(); }
          if (t === 'months') rows.forEach(m => {
            if (m.key !== '2026-12') return;
            if (m.data && m.data.A && JSON.stringify(m.data.A) !== st.seedA) done.add('build');
            if (kind === 'sched' && m.status === 'PD review' && !st.pdBusy) { st.pdBusy = true; done.add('send');
              setTimeout(() => { st.pdBusy = false; const A = (month().data || {}).A || ref.pre.A;
                const sendBack = !st.sentOnce && Math.random() < 0.6; st.sentOnce = true;
                if (sendBack) { const d = weekdays()[Math.floor(Math.random() * 6) + 4], n = nameOf(A, d, 'M') || nameOf(A, d, 'I');
                  fake.bot('months', 'update', r => r.key === '2026-12', { status: 'Scheduler review' });
                  fake.bot('requests', 'insert', { month_key: '2026-12', resident: n, type: 'off', days: [d], note: 'PD, with send-back', status: 'accepted', source: 'pd', reason: '', created_by: 'ppd', decided_by: 'ppd', decided_at: now() });
                  fake.bot('activity_log', 'insert', { user_id: 'ppd', month_key: '2026-12', text: `Program Director (PD): Sent back: Can ${n} be off on Dec ${d}? Family thing. Otherwise looks good. · Requests (already accepted): ${n} off Dec ${d}` });
                  msg('The PD sent it back', `“Can <b>${n}</b> be off on <b>Dec ${d}</b>? Family thing. Otherwise looks good.”<br><br>Her request is already accepted for you. On the Schedule tab, hit <b>Rebuild with the PD’s requests</b> in the yellow banner, then send it to her again. Her comment stays there and under “PD comments” on Approval.`);
                } else { fake.bot('months', 'update', r => r.key === '2026-12', { status: 'Approved' }); fake.bot('activity_log', 'insert', { user_id: 'ppd', month_key: '2026-12', text: 'Program Director (PD): PD approved; sent to schedulers to publish: Looks great, thanks.' }); msg('The PD approved it', 'Go to the Approval tab and publish it when you’re ready.'); }
              }, BOT_DELAY); }
            if (kind === 'sched' && m.status === 'Approved') done.add('approved');
            if (kind === 'sched' && m.status === 'Published') { done.add('approved'); done.add('publish');
              if (!st.swapsMade) { st.swapsMade = true; setTimeout(() => makeSwaps(), BOT_DELAY); } }
            if (kind === 'pd' && m.status === 'Scheduler review' && !st.revised) { done.add('decide-wait'); st.revised = true; setTimeout(() => reviseForPD(), BOT_DELAY); }
            if (kind === 'pd' && (m.status === 'Approved' || m.status === 'Published')) { done.add('decide');
              if (m.status === 'Approved') setTimeout(() => { fake.bot('months', 'update', r => r.key === '2026-12', { status: 'Published' }); msg('The schedulers published it', 'Residents can now see December. Next on your list: attendings.'); }, BOT_DELAY); }
          });
          if (t === 'requests' && op === 'insert' && kind === 'pd' && rows.some(r => r.source === 'pd')) done.add('req');
          if (kind === 'res' && t === 'requests' && op === 'insert') { done.add('req'); rows.forEach(r => setTimeout(() => {
              const ok = Math.random() < 0.75; fake.bot('requests', 'update', x => x.id === r.id, { status: ok ? 'accepted' : 'denied', decided_by: 'p0', decided_at: now(), reason: ok ? '' : 'That day is already short-staffed. Can you pick another?' });
              msg(ok ? 'Your request was accepted' : 'Your request was denied', ok ? 'A scheduler accepted it. It’ll be built into that month’s schedule.' : 'A scheduler denied it with a reason (you can see it on the Requests tab). Try another day if you like.'); }, BOT_DELAY)); }
          if (kind === 'res' && t === 'swaps' && op === 'insert') rows.forEach(x => { if (x.requester !== me.roster_name) return; done.add('trade-sent');
              setTimeout(() => { fake.bot('swaps', 'update', y => y.id === x.id, { status: 'agreed', target_at: now() }); msg(`${x.target} agreed to trade`, 'Now a scheduler has to approve it. About 10 more seconds…'); 
                setTimeout(() => approveSwap(x.id), BOT_DELAY); }, BOT_DELAY); });
          if (kind === 'res' && t === 'swaps' && op === 'update') rows.forEach(x => { if (x.target === me.roster_name && x.requester !== me.roster_name && x.status !== 'pending') { done.add('answer');
              if (x.status === 'agreed') setTimeout(() => approveSwap(x.id), BOT_DELAY); } });
          if (t === 'attendings') { const a = (T.attendings.find(x => x.month_key === '2026-12') || {}).data || {}; if (Object.keys(a).length >= 7) done.add('att'); }
          refresh();
        }
      };
      const engineHard = () => { let P = null; try { P = window.CallEngine.prepare(window.BuildInput.buildInput(ref.data, 2026, 12, 'draft')); } catch (e) {}
        return A => { try { return P ? window.CallEngine.evaluate(P, A.map(([U, M, I]) => ({ U, M, I }))).issues.filter(x => x.sev === 'hard').length : 0; } catch (e) { return 0; } }; };
      function reviseForPD() {
        // a believable "fix": trade a few mid-level and intern calls, keeping only trades that add no hard-rule break
        const m = month(), A = clone((m.data || {}).A || ref.pre.A), hard = engineHard(), changed = [];
        let base = hard(A); const hol = (window.BuildInput.HOLIDAYS['2026-12'] || []), ds = Array.from({ length: 26 }, (_, i) => i + 3).filter(d => !hol.includes(d) && !hol.includes(d - 1));
        [[1, 2], [2, 1]].forEach(([si, want]) => { let got = 0;
          for (let i = 0; i < ds.length && got < want; i++) for (let j = ds.length - 1; j > i + 4 && got < want; j--) {
            const a = ds[i], b = ds[j]; if (changed.includes(a) || changed.includes(b) || !A[a - 1][si] || !A[b - 1][si] || A[a - 1][si] === A[b - 1][si]) continue;
            [A[a - 1][si], A[b - 1][si]] = [A[b - 1][si], A[a - 1][si]]; const h = hard(A);
            if (h > base) { [A[a - 1][si], A[b - 1][si]] = [A[b - 1][si], A[a - 1][si]]; continue; } base = h; changed.push(a, b); got++; } });
        const n = T.versions.filter(v => v.month_key === '2026-12').length + 1;
        fake.bot('versions', 'insert', { month_key: '2026-12', n, status: 'PD review', schedule: A, changed: changed.length });
        fake.bot('months', 'update', r => r.key === '2026-12', { status: 'PD review', data: Object.assign({}, m.data, { A }) });
        msg('The schedulers sent a revised version', `They changed <b>${[...new Set(changed)].sort((a, b) => a - b).map(d => 'Dec ' + d).join(', ')}</b>. Look those days over on the Schedule tab, then approve it on the Approval tab.`);
      }
      function makeSwaps() {
        // pick trades the rules allow: score each candidate with the engine and keep ones that add no hard-rule break
        const A0 = (month().data || {}).A || ref.pre.A, out = [], used = new Set();
        const hard = engineHard();
        const hol = (window.BuildInput.HOLIDAYS['2026-12'] || []), base = hard(A0), ds = Array.from({ length: 26 }, (_, i) => i + 3).filter(d => !hol.includes(d) && !hol.includes(d - 1));
        ['M', 'I'].forEach(s => { const si = s === 'M' ? 1 : 2; let found = null;
          for (let i = 0; i < ds.length && !found; i++) for (let j = ds.length - 1; j > i + 2 && !found; j--) {
            const a = ds[i], b = ds[j]; if (used.has(a) || used.has(b)) continue; const na = A0[a - 1][si], nb = A0[b - 1][si]; if (!na || !nb || na === nb) continue;
            const A = clone(A0); A[a - 1][si] = nb; A[b - 1][si] = na; if (hard(A) > base) continue;
            found = { a, b, na, nb }; }
          if (!found) return; used.add(found.a); used.add(found.b);
          const pa = T.profiles.find(p => p.roster_name === found.na), pb = T.profiles.find(p => p.roster_name === found.nb);
          out.push({ month_key: '2026-12', slot: s, day_a: found.a, day_b: found.b, requester: found.na, target: found.nb, requester_id: pa ? pa.id : null, target_id: pb ? pb.id : null, note: s === 'M' ? 'Kid’s recital' : 'Conference', status: 'agreed', target_reason: '', admin_reason: '', requester_seen: false, target_at: now() }); });
        out.forEach(x => fake.bot('swaps', 'insert', x));
        msg(out.length > 1 ? 'Two swap requests came in' : 'A swap request came in', `${out.map(x => `<b>${x.requester}</b> ↔ <b>${x.target}</b> (Dec ${x.day_a} / Dec ${x.day_b})`).join('<br>')}<br><br>Both residents already agreed. Decide them on the Requests tab.`);
      }

      function approveSwap(id) {
        const x = T.swaps.find(y => y.id === id); if (!x || x.status !== 'agreed') return; const si = { U: 0, M: 1, I: 2 }[x.slot];
        const pub = T.published.find(p => p.month_key === x.month_key); const A = clone(pub.schedule); A[x.day_a - 1][si] = x.target; A[x.day_b - 1][si] = x.requester;
        fake.bot('swaps', 'update', y => y.id === id, { status: 'approved', decided_by: 'p0', decided_at: now() });
        const v = pub.version + 1; fake.bot('published_history', 'insert', { month_key: x.month_key, version: v, schedule: A, rnd: null, published_at: now() });
        fake.bot('published', 'update', p => p.month_key === x.month_key, { version: v, schedule: A, published_at: now() });
        fake.bot('months', 'update', m => m.key === x.month_key, { data: Object.assign({}, month().data, { A }) });
        msg('Trade approved', `A scheduler approved <b>${x.requester}</b> ↔ <b>${x.target}</b> (Dec ${x.day_a} / Dec ${x.day_b}). The schedule now shows the change.`);
        if (x.requester === me.roster_name) { done.add('trade'); if (!st.incoming) { st.incoming = true; setTimeout(incomingTrade, BOT_DELAY); } }
      }
      function incomingTrade() { // another resident asks to trade one of your calls
        const pub = T.published.find(p => p.month_key === '2026-12'), A = pub.schedule, myName = me.roster_name, hard = engineHard();
        const si = A.findIndex(a => a.includes(myName)) >= 0 ? A.map(a => a.indexOf(myName)).find(i => i >= 0) : 2, slot = ['U', 'M', 'I'][si];
        const mine = A.map((a, i) => a[si] === myName ? i + 1 : 0).filter(Boolean), base = hard(A); let found = null;
        for (const da of A.map((_, i) => i + 1)) { if (found) break; const other = A[da - 1][si]; if (!other || other === myName || A[da - 1].includes(myName)) continue;
          for (const db of mine) { if (Math.abs(da - db) < 3) continue; const B2 = clone(A); B2[da - 1][si] = myName; B2[db - 1][si] = other; if (hard(B2) > base) continue; found = { da, db, other }; break; } }
        if (!found) return; const op = T.profiles.find(p => p.roster_name === found.other);
        fake.bot('swaps', 'insert', { month_key: '2026-12', slot, day_a: found.da, day_b: found.db, requester: found.other, target: myName, requester_id: op ? op.id : null, target_id: me.id, note: 'Friend’s wedding that weekend', status: 'pending', target_reason: '', admin_reason: '', requester_seen: false });
        msg(`${found.other} wants to trade with you`, `They’d take your call on <b>Dec ${found.db}</b> and you’d take theirs on <b>Dec ${found.da}</b>. Answer it on the Requests tab.`);
      }
      fake = makeFake(T, realSb, bots);

      // ---------- banner + checklist ----------
      document.documentElement.classList.add('practice');
      const ban = document.createElement('div'); ban.className = 'practice-banner';
      ban.innerHTML = `<b>PRACTICE</b> — nothing here is real or saved. Reload or “Reset practice” to start over.`;
      document.body.prepend(ban);
      const box = document.createElement('aside'); box.className = 'coach'; box.setAttribute('aria-label', 'Practice walkthrough'); document.body.appendChild(box);
      const phone = () => window.matchMedia('(max-width: 720px)').matches;
      let collapsed = phone(); // on phones the checklist starts as a slim bar at the top; tap it to open
      const away = e => { if (phone() && !collapsed && !box.contains(e.target)) { collapsed = true; refresh(); } };
      document.addEventListener('click', away, true); document.addEventListener('touchstart', away, { capture: true, passive: true });
      function refresh() {
        const h = location.hash.slice(1) || 'schedule'; visited.add(h);
        if (kind === 'sched') {
          if (!T.requests.some(r => r.status === 'pending')) done.add('req');
          if (visited.has('inputs')) done.add('inputs'); if (visited.has('dashboard')) done.add('stats');
          if (st.swapsMade && T.swaps.length && !T.swaps.some(x => x.status === 'agreed')) done.add('swaps');
        } else if (kind === 'res') {
          if (document.querySelector('.mineToggle.on')) done.add('mine');
          if (!st.incoming && done.has('trade-sent') && 0) {}
        } else {
          if (visited.has('approval')) done.add('open');
          if (done.has('att') && visited.has('schedule') && h === 'schedule') done.add('cal');
          if (visited.has('dashboard')) done.add('stats'); if (visited.has('rules')) done.add('rules'); if (visited.has('history')) done.add('hist');
        }
        const next = steps.find(s => !done.has(s.id)), n = steps.filter(s => done.has(s.id)).length;
        document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('coach-next', !!next && a.getAttribute('href') === '#' + next.tab && !collapsed));
        box.classList.toggle('min', collapsed);
        const html = `<div class="coach-h" ${collapsed ? 'data-c="min" role="button" tabindex="0"' : ''}><b>${collapsed ? 'Practice' : 'Practice walkthrough'}</b><span class="muted small">${n}/${steps.length}</span>${collapsed && next ? `<span class="coach-now">→ ${next.t}</span>` : collapsed ? '<span class="coach-now">✓ All done</span>' : ''}<span class="spacer"></span><button class="btn" ${collapsed ? '' : 'data-c="min"'} aria-label="${collapsed ? 'Show steps' : 'Hide steps'}">${collapsed ? 'Show' : 'Hide'}</button></div>
          ${collapsed ? '' : `<ol class="coach-list">${steps.map(s => `<li class="${done.has(s.id) ? 'ok' : s === next ? 'now' : ''}">${done.has(s.id) ? '✓' : s === next ? '→' : '·'} ${s.t}${s === next ? `<div class="small">${s.d}${s.tab && h !== s.tab ? ` <a href="#${s.tab}">Go there</a>` : ''}</div>` : ''}</li>`).join('')}</ol>
          ${next ? '' : '<p class="small"><b>That’s the whole loop.</b> Poke around anything else, or reset to try another path.</p>'}
          <div class="row small" style="gap:6px;margin-top:8px"><button class="btn" data-c="reset">Reset practice</button>${canLeave ? '<button class="btn" data-c="leave">Leave practice</button>' : ''}</div>`}`;
        if (html === box._last) return; box._last = html; box.innerHTML = html;
        box.querySelector('[data-c="min"]').onclick = e => { e.stopPropagation(); collapsed = !collapsed; refresh(); };
        const r = box.querySelector('[data-c="reset"]'); if (r) r.onclick = () => location.reload();
        const l = box.querySelector('[data-c="leave"]'); if (l) l.onclick = () => { try { sessionStorage.removeItem('gs-practice'); } catch (e) {} location.hash = '#schedule'; location.reload(); };
      }
      window.addEventListener('hashchange', () => { if (phone()) collapsed = true; setTimeout(refresh, 50); });
      setTimeout(refresh, 300); setInterval(refresh, 1500);
      const where = phone() ? 'the purple bar at the top; tap it' : 'bottom right';
      setTimeout(() => msg(`Welcome to practice, ${String(profile.display_name || '').split(' ')[0]}`, kind === 'res'
        ? `This is a private practice copy: try anything, nothing is saved or seen by anyone. December is published. The checklist (${where}) shows you how to find your calls, ask for a day off, and trade calls. Pretend residents and schedulers answer in about 10 seconds.`
        : kind === 'pd'
        ? `This is a private practice copy: try anything, nothing is saved or seen by anyone. The schedulers just sent you December. The checklist (${where}) walks you through approving it, making requests and entering the month’s attendings.`
        : `This is a private practice copy: try anything, nothing is saved or seen by anyone. Five residents have sent requests for December. The checklist (${where}) walks you through building, sending to the PD, publishing and handling swaps. Pretend people answer in about 10 seconds.`), 600);
      return { sb: fake, profile: me, months: clone(T.months), versions: clone(T.versions).map(v => Object.assign({}, v)), logs: clone(T.activity_log) };
    }
  };
})();
