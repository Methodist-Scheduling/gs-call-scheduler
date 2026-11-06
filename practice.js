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
    function q(t) {
      const f = []; let ord = null, lim = null, op = 'select', payload = null, upOpts = null;
      const rowsOf = () => t === 'month_status' ? statusView() : (T[t] = T[t] || []);
      const match = () => rowsOf().filter(r => f.every(fn => fn(r)));
      const run = () => {
        if (op === 'select') { let r = match().map(clone); if (ord) r.sort((a, b) => (a[ord.c] > b[ord.c] ? 1 : a[ord.c] < b[ord.c] ? -1 : 0) * (ord.asc ? 1 : -1)); if (lim) r = r.slice(0, lim); return { data: r, error: null }; }
        if (op === 'insert') { const list = (Array.isArray(payload) ? payload : [payload]).map(x => Object.assign({ id: nid++, created_at: now() }, clone(x))); rowsOf().push(...list); afterWrite(t, list, 'insert', false); return { data: list.map(clone), error: null }; }
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
    const me = Object.assign({}, profile, { role, is_admin: true, can_preview: false, practice_only: true });
    const others = roster.filter(n => n !== profile.roster_name).map((n, i) => ({ id: 'p' + i, display_name: n + ' (practice)', roster_name: n, username: n.toLowerCase(), active: true, role: pgy[n] === 4 ? 'scheduler' : pgy[n] === 5 ? 'chief' : 'resident', is_admin: [4, 5].includes(pgy[n]) }));
    others.push({ id: 'ppd', display_name: 'Program Director (practice)', roster_name: null, username: 'pd', active: true, role: 'pd', is_admin: true });
    const T = { profiles: [me].concat(others), reference: Object.entries(ref).map(([key, value]) => ({ key, value })), settings: [{ id: 1, rules: {}, trio_swap: { xmas: false, ny: false }, people: {} }],
      months: [], versions: [], activity_log: [], requests: [], swaps: [], month_notes: [], published: [], published_history: [], seen_versions: [], attendings: [] };
    const A = pre.A, low = roster.filter(n => [1, 2, 3].includes(pgy[n]));
    const pick = (arr, i) => arr[i % arr.length];
    if (role === 'pd') {
      T.months.push({ key: '2026-12', status: 'PD review', data: { A: clone(A) }, updated_at: now() });
      T.versions.push({ month_key: '2026-12', n: 1, status: 'PD review', schedule: clone(A), changed: null, created_at: now() });
      T.activity_log.push({ month_key: '2026-12', at: now(), text: 'Lainie (Scheduler): Sent to the PD for review' });
    } else {
      // a handful of resident requests waiting to be decided
      const offs = [[pick(low, 1), 'off', [12], 'Brother’s wedding'], [pick(low, 3), 'off', [19, 20], 'Out of town'], [pick(low, 5), 'want', [6], 'Trading for a weekend later'], [pick(low, 7), 'off', [31], 'New Year’s with family'], [pick(low, 9), 'protected', [16], 'Mock orals']];
      offs.forEach(([n, type, days, note], i) => { const p = others.find(o => o.roster_name === n); T.requests.push({ id: 900 + i, month_key: '2026-12', resident: n, type, days, note, status: 'pending', source: 'resident', reason: '', created_by: p ? p.id : 'x', created_at: new Date(Date.now() - (6 - i) * 3600e3).toISOString() }); });
    }
    return { T, me };
  }

  // ---------- coach ----------
  const STEPS = {
    sched: [
      { id: 'req', tab: 'notes', t: 'Decide the waiting requests', d: 'Requests tab: five residents asked for things. Accept or deny each one (a denied request needs a reason they’ll see).' },
      { id: 'inputs', tab: 'inputs', t: 'Look over Inputs', d: 'Rotations, vacations and PGY-5/fellow picks feed the schedule. Fix anything that changed, then come back to Schedule.' },
      { id: 'build', tab: 'schedule', t: 'Rebuild the schedule', d: 'Schedule tab: “Regenerate around locks” keeps what’s locked and redoes the rest with the accepted requests. Click any name to edit a day by hand.' },
      { id: 'stats', tab: 'dashboard', t: 'Check Stats', d: 'Look for anyone under or over target, every-other-day calls, and weekend balance. Click an item to see it on a calendar.' },
      { id: 'send', tab: 'approval', t: 'Send it to the PD', d: 'Approval tab: “Send to the PD”. The pretend PD answers in about 10 seconds: approved, or sent back with a note.' },
      { id: 'approved', tab: 'approval', t: 'Get it approved', d: 'If the PD sent it back, make the change she asked for and send it again. Once approved, move on.' },
      { id: 'publish', tab: 'approval', t: 'Publish it', d: 'Approval tab: “Publish”. Residents would now see it. About 10 seconds later, a couple of residents ask to trade calls.' },
      { id: 'swaps', tab: 'notes', t: 'Handle the swap requests', d: 'Requests tab → Swaps: both residents already agreed. Approve or deny (the app shows any rule a swap would break).' }
    ],
    pd: [
      { id: 'open', tab: 'approval', t: 'Open the schedule you were sent', d: 'Approval tab: the schedulers sent December for your review. Look over the calendar on the Schedule tab too.' },
      { id: 'decide', tab: 'approval', t: 'Approve it, or send it back', d: 'Send it back with a note to see what happens: the pretend schedulers return a changed version in about 10 seconds (changed days are listed for you). Then approve.' },
      { id: 'att', tab: 'inputs', t: 'Enter the attendings', d: 'Inputs tab → Attendings (top). Use the Fill bar: pick “Trauma AM + PM”, type a name, choose days 1–7, Fill. Do SICU and EGS/TBU the same way. Fill at least a week.' },
      { id: 'cal', tab: 'schedule', t: 'See them on the calendar', d: 'Schedule tab: attendings now show under each day, for everyone, and on the PDF.' },
      { id: 'stats', tab: 'dashboard', t: 'Look at Stats', d: 'This month and Year to date. Hover any number or bar for details.' },
      { id: 'rules', tab: 'rules', t: 'Rules', d: 'You can change any setting here (targets, limits, two-person exceptions). Every rule is written out in plain English below.' },
      { id: 'hist', tab: 'history', t: 'History', d: 'Past months as published, and how the app would have done them. Hover a number to see where the problems were.' }
    ]
  };

  window.GSPractice = {
    start({ realSb, user, profile, ref, role, canLeave }) {
      const { T, me } = seed(profile, user, ref, role);
      const kind = role === 'pd' ? 'pd' : 'sched', steps = STEPS[kind], done = new Set(), visited = new Set();
      const st = { seedA: JSON.stringify(ref.pre.A), sentOnce: false, pdBusy: false, revised: false, swapsMade: false };
      let fake;
      const month = () => T.months.find(m => m.key === '2026-12');
      const msg = (title, body) => { const ov = document.createElement('div'); ov.className = 'modal-ov'; ov.innerHTML = `<div class="modal"><div class="pill" style="margin-bottom:8px">Practice</div><h3 style="margin-top:0">${title}</h3><p class="small">${body}</p><div class="row" style="justify-content:flex-end"><button class="btn primary">OK</button></div></div>`; document.body.appendChild(ov); ov.querySelector('button').onclick = () => ov.remove(); ov.onclick = e => { if (e.target === ov) ov.remove(); }; };
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
                  msg('The PD sent it back', `“Can <b>${n}</b> be off on <b>Dec ${d}</b>? Family thing. Otherwise looks good.”<br><br>Click ${n}’s name on Dec ${d} on the Schedule tab to swap someone in (or add an “off” request and rebuild), then send it to the PD again.`);
                } else { fake.bot('months', 'update', r => r.key === '2026-12', { status: 'Approved' }); msg('The PD approved it', 'Go to the Approval tab and publish it when you’re ready.'); }
              }, BOT_DELAY); }
            if (kind === 'sched' && m.status === 'Approved') done.add('approved');
            if (kind === 'sched' && m.status === 'Published') { done.add('approved'); done.add('publish');
              if (!st.swapsMade) { st.swapsMade = true; setTimeout(() => makeSwaps(), BOT_DELAY); } }
            if (kind === 'pd' && m.status === 'Scheduler review' && !st.revised) { done.add('decide-wait'); st.revised = true; setTimeout(() => reviseForPD(), BOT_DELAY); }
            if (kind === 'pd' && (m.status === 'Approved' || m.status === 'Published')) { done.add('decide');
              if (m.status === 'Approved') setTimeout(() => { fake.bot('months', 'update', r => r.key === '2026-12', { status: 'Published' }); msg('The schedulers published it', 'Residents can now see December. Next on your list: attendings.'); }, BOT_DELAY); }
          });
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

      fake = makeFake(T, realSb, bots);

      // ---------- banner + checklist ----------
      document.documentElement.classList.add('practice');
      const ban = document.createElement('div'); ban.className = 'practice-banner';
      ban.innerHTML = `<b>PRACTICE</b> — nothing here is real or saved. Reload or “Reset practice” to start over.`;
      document.body.prepend(ban);
      const box = document.createElement('aside'); box.className = 'coach'; box.setAttribute('aria-label', 'Practice walkthrough'); document.body.appendChild(box);
      let collapsed = false;
      function refresh() {
        const h = location.hash.slice(1) || 'schedule'; visited.add(h);
        if (kind === 'sched') {
          if (!T.requests.some(r => r.status === 'pending')) done.add('req');
          if (visited.has('inputs')) done.add('inputs'); if (visited.has('dashboard')) done.add('stats');
          if (st.swapsMade && T.swaps.length && !T.swaps.some(x => x.status === 'agreed')) done.add('swaps');
        } else {
          if (visited.has('approval')) done.add('open');
          if (done.has('att') && visited.has('schedule') && h === 'schedule') done.add('cal');
          if (visited.has('dashboard')) done.add('stats'); if (visited.has('rules')) done.add('rules'); if (visited.has('history')) done.add('hist');
        }
        const next = steps.find(s => !done.has(s.id)), n = steps.filter(s => done.has(s.id)).length;
        document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('coach-next', !!next && a.getAttribute('href') === '#' + next.tab && !collapsed));
        box.classList.toggle('min', collapsed);
        box.innerHTML = `<div class="coach-h"><b>Practice walkthrough</b><span class="muted small">${n}/${steps.length}</span><span class="spacer"></span><button class="btn" data-c="min" aria-label="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▴' : '▾'}</button></div>
          ${collapsed ? '' : `<ol class="coach-list">${steps.map(s => `<li class="${done.has(s.id) ? 'ok' : s === next ? 'now' : ''}">${done.has(s.id) ? '✓' : s === next ? '→' : '·'} ${s.t}${s === next ? `<div class="small">${s.d}${s.tab && h !== s.tab ? ` <a href="#${s.tab}">Go there</a>` : ''}</div>` : ''}</li>`).join('')}</ol>
          ${next ? '' : '<p class="small"><b>That’s the whole loop.</b> Poke around anything else, or reset to try another path.</p>'}
          <div class="row small" style="gap:6px;margin-top:8px"><button class="btn" data-c="reset">Reset practice</button>${canLeave ? '<button class="btn" data-c="leave">Leave practice</button>' : ''}</div>`}`;
        box.querySelector('[data-c="min"]').onclick = () => { collapsed = !collapsed; refresh(); };
        const r = box.querySelector('[data-c="reset"]'); if (r) r.onclick = () => location.reload();
        const l = box.querySelector('[data-c="leave"]'); if (l) l.onclick = () => { try { sessionStorage.removeItem('gs-practice'); } catch (e) {} location.hash = '#schedule'; location.reload(); };
      }
      window.addEventListener('hashchange', () => setTimeout(refresh, 50));
      setTimeout(refresh, 300);
      setTimeout(() => msg(`Welcome to practice, ${String(profile.display_name || '').split(' ')[0]}`, kind === 'pd'
        ? 'This is a private practice copy: try anything, nothing is saved or seen by anyone. The schedulers just sent you December. The checklist (bottom right) walks you through approving it and entering the month’s attendings.'
        : 'This is a private practice copy: try anything, nothing is saved or seen by anyone. Five residents have sent requests for December. The checklist (bottom right) walks you through building, sending to the PD, publishing and handling swaps. Pretend people answer in about 10 seconds.'), 600);
      return { sb: fake, profile: me, months: clone(T.months), versions: clone(T.versions).map(v => Object.assign({}, v)), logs: clone(T.activity_log) };
    }
  };
})();
