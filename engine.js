// Call schedule engine v1.3 — General Surgery. Rules v1.3 (S7 back-to-back weekends; rounding counts as a worked weekend; W2 HPB/Transplant).
(function (root) {
  const SERVICE_OF = { Trauma: 'Trauma', EGS: 'EGS', ICU: 'ICU', GS1: 'GS1', GS2: 'GS2', Vascular: 'Vascular', Thoracic: 'Thoracic', HPB: 'HPB', Transplant: 'Transplant' };
  const SISTER = { Trauma: 'EGS', EGS: 'Trauma', Vascular: 'Thoracic', Thoracic: 'Vascular' };
  const DEFAULT_RULES = {
    excludedRotations: ['Richardson', 'Peds', 'Transplant', 'Leave'],
    targets: { 1: [5, 6], 2: [5, 6], 3: [5, 6], 4: [6, 7], 5: [6, 6], F: [4, 4] },
    fellowCap: 4,
    noTwoPerson: [], // per-person exceptions, set by a PGY-5 chief, stored in the database
    maxQ2Run: 3,
    pgy4MidSlot: false, // NOT in v1.1: let a PGY-4 fill the mid slot (happened 19 times Jul–Nov) — ask chiefs
    sameServiceBlocked: false, // NOT a stated rule: optional extension of H15 to two residents on the same service — ask chiefs
    q3WindowMax: 9, // ACGME: no more than every 3rd night avg over 28 days
    weights: { target: 60, q2: 30, gap3: 4, noWeekendOff: 220, oneWeekendOff: 45, backToBack: 120, bookend: 3000, /* S4 ranks above every other soft rule: broken only when keeping it would break a hard rule */ gs2: 40, protected: 90, request: 80,
      wkndFair: 6, holFair: 6, twoPerson: 45, twoFair: 10, typeMix: 2, spread: 1 }
  };
  const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun..6 Sat
  const isWknd = w => w === 5 || w === 6 || w === 0;

  function prepare(input) {
    const R = Object.assign({}, DEFAULT_RULES, input.rules || {});
    R.weights = Object.assign({}, DEFAULT_RULES.weights, (input.rules || {}).weights || {});
    const { year, month } = input;
    const nd = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const days = [];
    for (let d = 1; d <= nd; d++) days.push({ d, w: dow(year, month, d) });
    const people = input.people.map(p => {
      const lvl = p.pgy === 'F' ? 'F' : +p.pgy;
      const t = R.targets[lvl];
      const out = new Set([...(p.vacDays || []).filter(d => { const w = dow(year, month, d); return w >= 1 && w <= 5; }), ...(p.leaveDays || []), ...(p.blockDays || [])]);
      const excluded = R.excludedRotations.includes(p.rotation);
      const avail = nd - (p.leaveDays || []).length; // targets only shrink for maternity/leave (F1)
      const scale = avail / nd;
      return Object.assign({}, p, { lvl, out, excluded, tmin: Math.round(t[0] * scale), tmax: Math.round(t[1] * scale), svc: SERVICE_OF[p.rotation] || null,
        vacAll: new Set(p.vacDays || []) });
    });
    const byName = Object.fromEntries(people.map(p => [p.name, p]));
    // weekend groups (Fri,Sat,Sun) whose Friday is in the month
    const weekends = [];
    days.forEach(x => { if (x.w === 5) weekends.push([x.d, x.d + 1, x.d + 2].filter(d => d <= nd || true)); });
    return { R, year, month, nd, days, people, byName, weekends, input };
  }

  function slotOK(P, p, slot, day) {
    if (!p) return false;
    if (p.excluded || p.out.has(day)) return false;
    if (slot === 'I') return p.lvl === 1;
    if (slot === 'M') return p.lvl === 2 || p.lvl === 3 || (P.R.pgy4MidSlot && p.lvl === 4);
    if (slot === 'U') return p.lvl === 4 || p.lvl === 5 || p.lvl === 'F';
    return false;
  }

  function evaluate(P, A) {
    const { R, days, people, byName, nd, input } = P;
    const W = R.weights;
    let hard = 0, soft = 0; const issues = []; const br = {};
    const add = (k, v, msg, sev) => { if (sev === 'hard') hard += v; else soft += v; br[k] = (br[k] || 0) + v; if (msg) issues.push({ k, sev, msg }); };
    const calls = {}; people.forEach(p => calls[p.name] = []);
    const prior = input.prior || {};
    days.forEach(x => {
      const a = A[x.d - 1];
      ['I', 'M', 'U'].forEach(s => { if (a[s]) calls[a[s]] && calls[a[s]].push(x.d); });
      if (!a.I) add('H1', 1e6, `Day ${x.d}: no intern`, 'hard');
      if (!a.U) add('H2', 1e6, `Day ${x.d}: no upper level`, 'hard');
      if (!a.M) {
        const u = byName[a.U];
        const lockedTwo = (input.twoPersonOK || []).includes(x.d);
        if (u && !(u.lvl === 4 || lockedTwo)) add('H3', 1e6, `Day ${x.d}: two-person call needs a PGY-4`, 'hard');
        if (u && (R.noTwoPerson || []).includes(u.name) && !lockedTwo) add('H3', 1e6, `Day ${x.d}: ${u.name} is not eligible for two-person call`, 'hard');
        if (x.w === 5 || x.w === 6) add('H4', 1e6, `Day ${x.d}: two-person call on Fri/Sat`, 'hard');
        if (x.w === 0 && !lockedTwo) add('H4', 1e6, `Day ${x.d}: Sunday two-person call needs chief approval`, 'hard');
        soft += W.twoPerson;
      }
      const ppl = ['I', 'M', 'U'].map(s => a[s] && byName[a[s]]).filter(Boolean);
      ['I', 'M', 'U'].forEach(s => { const p = a[s] && byName[a[s]]; if (!a[s] || (input.lockedSlots || {})[x.d + s]) return;
        if (s === 'M' && p && p.lvl === 4 && R.pgy4MidSlot) { soft += 20; br.PGY4mid = (br.PGY4mid || 0) + 20; return; }
        if (s === 'M' && p && (p.lvl === 4 || p.lvl === 5 || p.lvl === 'F')) { add('H2', 1e6, `Day ${x.d}: ${a[s]} (upper level) filled the mid-level slot`, 'hard'); return; }
        if (!slotOK(P, p, s, x.d)) add('H8', 1e6, `Day ${x.d}: ${a[s]} not eligible (${p ? (p.out.has(x.d) ? 'vacation/leave' : p.excluded ? p.rotation : 'level') : '?'})`, 'hard'); });
      const svcs = ppl.map(p => p.svc).filter(Boolean);
      for (let i = 0; i < ppl.length; i++) for (let j = i + 1; j < ppl.length; j++) {
        const s1 = ppl[i].svc, s2 = ppl[j].svc;
        if (!s1 || !s2) continue;
        if (SISTER[s1] === s2) add('H15', 1e6, `Day ${x.d}: ${ppl[i].name} (${s1}) and ${ppl[j].name} (${s2}) are sister services`, 'hard');
        if (R.sameServiceBlocked && s1 === s2) add('H15', 1e6, `Day ${x.d}: ${ppl[i].name} and ${ppl[j].name} both on ${s1}`, 'hard');
      }
      const pg = ppl.map(p => p.lvl);
      if (new Set(pg).size !== pg.length) add('H5', 1e6, `Day ${x.d}: same PGY year twice`, 'hard');
    });
    // who works each weekend: callers + rounders (S5, F2, S7 count rounding)
    const RB = roundingBlocks(P, A, input.holidays || []);
    const firstFri = (P.weekends[0] || [])[0];
    // W3 (hard): the fellow and the ICU resident alternate weekends; on the other's weekend they don't work at all (no call either)
    days.forEach(x => { if (!isWknd(x.w)) return; const rec = RB[x.d]; if (!rec || !rec.weekend) return; const a = A[x.d - 1];
      ['I', 'M', 'U'].forEach(s => { const p = a[s] && byName[a[s]]; if (!p) return;
        if ((input.locks || []).some(l => l.day === x.d && l.slot === s && l.name === p.name)) return; // locked picks and holiday list win (H10, H11)
        if (p.lvl === 'F' && !p.excluded && !rec.fellowWeek && !rec.holiday) add('W3', 1e6, `Day ${x.d}: ${p.name} (fellow) on call on an ICU-resident weekend`, 'hard');
        if (p.rotation === 'ICU' && p.lvl !== 'F' && rec.fellowWeek) add('W3', 1e6, `Day ${x.d}: ${p.name} (ICU resident) on call on the fellow's weekend`, 'hard');
        if ((rec.tegsOff || []).includes(p.name)) add('W6', 1e6, `Day ${x.d}: ${p.name} on call on their T/EGS off weekend`, 'hard'); }); });
    const priorWk = firstFri ? new Set(Object.entries(prior).filter(([, ds]) => ds.some(d => d >= firstFri - 7 && d <= firstFri - 5)).map(([n]) => n)) : new Set();
    // per person
    const stats = {};
    people.forEach(p => {
      const c = calls[p.name].slice().sort((a, b) => a - b);
      const all = (prior[p.name] || []).concat(c);
      let q2 = 0, run = 1, gap3 = 0, minGap = 99;
      for (let i = 1; i < all.length; i++) {
        const g = all[i] - all[i - 1];
        if (g < 2) add('H13', 1e6, `${p.name}: back-to-back calls (day ${all[i - 1]}→${all[i]})`, 'hard');
        if (all[i] >= 1) { if (g === 2) q2++; if (g === 3) gap3++; minGap = Math.min(minGap, g); }
        run = g === 2 ? run + 1 : 1;
        if (run > R.maxQ2Run) add('H14', 1e6, `${p.name}: more than ${R.maxQ2Run} calls in a row every other day (to day ${all[i]})`, 'hard');
      }
      // ACGME q3 over 28 days
      for (let i = 0; i < all.length; i++) { const n = all.filter(d => d >= all[i] && d < all[i] + 28).length; if (n > R.q3WindowMax) { add('ACGME', 1e6, `${p.name}: ${n} calls in 28 days (over q3 average)`, 'hard'); break; } }
      if (p.lvl === 'F') { const unlocked = c.filter(d => !(input.locks || []).some(l => l.day === d && l.name === p.name)).length; const locked = c.length - unlocked; if (c.length > R.fellowCap && unlocked > 0 && c.length > Math.max(R.fellowCap, locked)) add('H7', 1e6, `${p.name}: over fellow cap`, 'hard'); }
      soft += W.q2 * q2 + W.gap3 * gap3;
      if (q2) br.S1 = (br.S1 || 0) + W.q2 * q2;
      // targets
      const n = c.length;
      if (!p.excluded || n) {
        const off = n < p.tmin ? p.tmin - n : n > p.tmax ? n - p.tmax : 0;
        if (off) { soft += W.target * off; br.F1 = (br.F1 || 0) + W.target * off; }
      }
      // weekends
      let wOff = 0, wTot = 0, fri = 0, sat = 0, sun = 0, wk = 0, hol = 0, two = 0, b2b = 0;
      let prevWorked = priorWk.has(p.name);
      P.weekends.forEach(g => { const inM = g.filter(d => d <= nd); if (inM.length < 3) return; wTot++;
        const rec = RB[g[1]]; const worked = g.some(d => c.includes(d)) || !!(rec && rec.workers && rec.workers.has(p.name));
        if (!worked) wOff++; if (worked && prevWorked) b2b++; prevWorked = worked; });
      c.forEach(d => { const w = P.days[d - 1].w; if (w === 5) fri++; if (w === 6) sat++; if (w === 0) sun++; if (isWknd(w)) wk++; if ((input.holidays || []).includes(d)) hol++; if (!A[d - 1].M) two++; });
      const elig = !p.excluded;
      if (elig && wTot) {
        if (wOff === 0) { soft += W.noWeekendOff; br.S5 = (br.S5 || 0) + W.noWeekendOff; }
        else if (wOff === 1 && wTot >= 3) { soft += W.oneWeekendOff; br.F2 = (br.F2 || 0) + W.oneWeekendOff; }
        if (b2b) { soft += W.backToBack * b2b; br.S7 = (br.S7 || 0) + W.backToBack * b2b; }
      }
      // bookends (S4): weekend before/after vacation weekdays
      const vd = [...p.vacAll].filter(d => { const w = P.days[d - 1] && P.days[d - 1].w; return w >= 1 && w <= 5; }).sort((a, b) => a - b);
      let bookBroken = 0;
      if (vd.length) {
        const first = vd[0], last = vd[vd.length - 1];
        const before = [first - 3, first - 2, first - 1].filter(d => d >= 1), after = [last + 1, last + 2, last + 3].filter(d => d <= nd);
        const bb = before.length && before.some(d => c.includes(d)), ab = after.length && after.some(d => c.includes(d));
        bookBroken = (bb ? 1 : 0) + (ab ? 1 : 0);
        if (bookBroken) { const v = bookBroken === 2 ? W.bookend * 3 : W.bookend; soft += v; br.S4 = (br.S4 || 0) + v; }
      }
      // H16: when an ICU partner (fellow / ICU resident) or a T/EGS upper-level partner is away, the one left can't be post-call on a weekday
      const away = (q, d) => q.vacAll.has(d) || (q.leaveDays || []).includes(d);
      const grp = p.rotation === 'ICU' ? P.people.filter(q => q.rotation === 'ICU' && !q.excluded)
        : (['Trauma', 'EGS'].includes(p.rotation) && p.pgy >= 3 && p.lvl !== 'F') ? P.people.filter(q => ['Trauma', 'EGS'].includes(q.rotation) && q.pgy >= 3 && q.lvl !== 'F' && !q.excluded) : [];
      if (grp.length > 1) c.forEach(d => { const nx = P.days[d]; if (!nx || nx.w < 1 || nx.w > 5) return;
        const gone = grp.find(q => q !== p && away(q, d + 1)); if (gone) add('H16', 1e6, `${p.name}: post-call on day ${d + 1} while ${gone.name} is away`, 'hard'); });
      // GS2 colorectal (S3)
      if (p.rotation === 'GS2') c.forEach(d => { const w = P.days[d - 1].w; const marked = (input.colorectalDays || []).includes(d + 1); if (marked) add('S3', 1e6, `${p.name}: post-call on marked colorectal day ${d + 1}`, 'hard'); else if (w === 0 || w === 2) { soft += W.gs2; br.S3 = (br.S3 || 0) + W.gs2; } });
      // protected (S2)
      (input.protected || []).forEach(ev => { if ((ev.names || []).includes(p.name) && c.includes(ev.day - 1)) { soft += W.protected; br.S2 = (br.S2 || 0) + W.protected; } });
      // requests (S6)
      (input.requests || []).forEach(r => { if (r.name === p.name) { const hit = c.includes(r.day); if ((r.type === 'off' && hit) || (r.type === 'want' && !hit)) { soft += W.request; br.S6 = (br.S6 || 0) + W.request; } } });
      stats[p.name] = { calls: c, n, q2, minGap: minGap === 99 ? null : minGap, wOff, wTot, b2b, fri, sat, sun, wk, hol, two, bookBroken, tmin: p.tmin, tmax: p.tmax };
    });
    // fairness: weekend + holiday YTD within group (F3), two-person among PGY-4 (F4), type mix (F5)
    const groups = {};
    people.forEach(p => { if (p.excluded) return; const g = p.lvl === 'F' ? 'F' : (p.lvl === 2 || p.lvl === 3 ? 'M' : p.lvl); (groups[g] = groups[g] || []).push(p); });
    Object.entries(groups).forEach(([g, ps]) => {
      if (ps.length < 2) return;
      const ytdW = ps.map(p => (p.ytd ? p.ytd.wk : 0) + stats[p.name].wk);
      const mean = ytdW.reduce((a, b) => a + b, 0) / ps.length;
      ytdW.forEach(v => { const x = W.wkndFair * (v - mean) ** 2; soft += x; br.F3 = (br.F3 || 0) + x; });
      ['fri', 'sat', 'sun'].forEach(k => { const v = ps.map(p => stats[p.name][k]); const m = v.reduce((a, b) => a + b, 0) / v.length; v.forEach(z => { soft += W.typeMix * (z - m) ** 2; }); });
    });
    const p4 = people.filter(p => p.lvl === 4 && !p.excluded);
    if (p4.length > 1) { const v = p4.map(p => (p.ytd ? p.ytd.two : 0) + stats[p.name].two); const m = v.reduce((a, b) => a + b, 0) / v.length; v.forEach(z => { const x = W.twoFair * (z - m) ** 2; soft += x; br.F4 = (br.F4 || 0) + x; }); }
    return { cost: hard + soft, hard, soft, br, issues, stats };
  }

  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; }; }

  function solve(input, opts = {}) {
    const P = prepare(input);
    const rand = rng(opts.seed || 12345);
    const { days, people } = P;
    const locks = input.locks || [];
    const lockSet = {}; locks.forEach(l => lockSet[l.day + l.slot] = l.name);
    input.lockedSlots = lockSet;
    const cand = {};
    days.forEach(x => ['I', 'M', 'U'].forEach(s => { cand[x.d + s] = people.filter(p => slotOK(P, p, s, x.d)).map(p => p.name); }));
    // initial greedy
    const A = days.map(x => ({}));
    const load = {}; people.forEach(p => load[p.name] = 0);
    const last = {}; people.forEach(p => last[p.name] = -99); Object.entries(input.prior || {}).forEach(([n, ds]) => { last[n] = Math.max(...ds); });
    locks.forEach(l => { A[l.day - 1][l.slot] = l.name; });
    if (input.twoPersonDays) input.twoPersonDays.forEach(d => { A[d - 1].M = null; A[d - 1]._two = true; });
    days.forEach(x => {
      ['U', 'M', 'I'].forEach(s => {
        const k = x.d + s; if (lockSet[k] !== undefined || A[x.d - 1][s] !== undefined) return;
        const used = Object.values(A[x.d - 1]).filter(Boolean);
        const c = cand[k].filter(n => !used.includes(n) && x.d - lastCall(A, n, x.d, input) >= 2);
        if (!c.length) { A[x.d - 1][s] = cand[k][Math.floor(rand() * cand[k].length)] || null; return; }
        c.sort((a, b) => (load[a] - P.byName[a].tmax) - (load[b] - P.byName[b].tmax) || rand() - 0.5);
        A[x.d - 1][s] = c[0]; load[c[0]]++;
      });
    });
    let cur = evaluate(P, A), best = { A: clone(A), ev: cur };
    const iters = opts.iters || 40000;
    let T = 200;
    const free = []; days.forEach(x => ['I', 'M', 'U'].forEach(s => { if (lockSet[x.d + s] === undefined) free.push([x.d, s]); }));
    for (let it = 0; it < iters; it++) {
      T = 200 * Math.pow(0.0005, it / iters);
      const [d, s] = free[Math.floor(rand() * free.length)];
      const a = A[d - 1]; const old = a[s];
      let undo;
      const r = rand();
      if (r < 0.55) { // replace
        const opts2 = cand[d + s]; if (!opts2.length) continue;
        let nn = opts2[Math.floor(rand() * opts2.length)];
        if (s === 'M' && rand() < 0.08 && days[d - 1].w >= 1 && days[d - 1].w <= 4) nn = null; // try two-person
        if (nn === old) continue; a[s] = nn; undo = () => { a[s] = old; };
      } else { // swap same slot with another day
        const [d2, s2] = free[Math.floor(rand() * free.length)]; if (s2 !== s || d2 === d) continue;
        const b = A[d2 - 1]; const o2 = b[s]; a[s] = o2; b[s] = old; undo = () => { a[s] = old; b[s] = o2; };
      }
      const ev = evaluate(P, A);
      const delta = ev.cost - cur.cost;
      if (delta <= 0 || rand() < Math.exp(-delta / T)) { cur = ev; if (ev.cost < best.ev.cost) best = { A: clone(A), ev }; }
      else undo();
    }
    return { A: best.A, ev: best.ev, P };
  }
  function lastCall(A, n, d, input) { for (let i = d - 2; i >= 0; i--) if (A[i] && (A[i].I === n || A[i].M === n || A[i].U === n)) return i + 1; const pr = (input.prior || {})[n]; return pr && pr.length ? Math.max(...pr) : -99; }
  function clone(A) { return A.map(a => Object.assign({}, a)); }

  // weekend rounding blocks (W1–W5). Fri/Sat/Sun callers work the weekend (H9) and go on blocks first,
  // on their own service when they have one, else as cross-cover. Empty blocks are then filled with
  // one own-service resident, rotating (not someone who worked last weekend, fewest fill-ins first).
  // W2: one resident covers HPB and Transplant; two when feasible. W3: the SICU fellow and the ICU resident alternate ICU weekends (fellow two a month). W6: T/EGS upper levels alternate weekends, each with a lower level.
  function roundingBlocks(P, A, holidays) {
    const out = {};
    const BLOCK = { 'Trauma/EGS': ['Trauma', 'EGS'], ICU: ['ICU'], GS1: ['GS1'], GS2: ['GS2'], 'Vasc/Thor': ['Vascular', 'Thoracic'], 'HPB/Transplant': ['HPB', 'Transplant'] };
    const blockOf = p => Object.keys(BLOCK).find(k => BLOCK[k].includes(p.rotation));
    const fellow = P.people.find(p => p.lvl === 'F' && !p.excluded);
    let fellowRounds = 0;
    // start the fellow's alternation on weekend 2 if she worked the last weekend of the previous month (S7)
    const ff = (P.weekends[0] || [])[0];
    const fStart = fellow && ff && ((P.input.prior || {})[fellow.name] || []).some(d => d >= ff - 7 && d <= ff - 5) ? 1 : 0;
    // manual rounding edits from the Schedule tab win over the computed blocks: { [Sat or holiday day]: { block: [names] } }
    const OVR = P.input.rndOverride || {};
    const applyOvr = (rec, ref) => { const o = OVR[ref]; if (!o) return rec; Object.entries(o).forEach(([b, v]) => { if (Array.isArray(v)) rec.blocks[b] = v.slice(); });
      rec.workers = new Set(rec.callers.concat(...Object.values(rec.blocks).map(v => v.map(n => n.replace(' (cross-cover)', ''))))); rec.edited = Object.keys(o); return rec; };
    const fills = {}; // how often each person was pulled in to round (rotates the fill-in)
    let wkIdx = 0, prevWorkers = new Set(ff ? Object.entries(P.input.prior || {}).filter(([, ds]) => ds.some(d => d >= ff - 7 && d <= ff - 5)).map(([nm]) => nm) : []); // last weekend of the previous month (calls)
    // callDays: days whose callers work this block; refDay: availability check
    // W6: PGY-3+ residents on Trauma/EGS alternate weekend T/EGS rounding; start with one who didn't work the previous month's last weekend
    const tUppers = P.people.filter(p => ['Trauma', 'EGS'].includes(p.rotation) && p.pgy >= 3 && p.lvl !== 'F' && !p.excluded).sort((a, c) => a.name < c.name ? -1 : 1);
    const tStart = Math.max(0, tUppers.findIndex(p => !prevWorkers.has(p.name)));
    const build = (callDays, refDay, prev, fellowWeek, refHoliday, tUp, wk) => {
      const b = {}; Object.keys(BLOCK).forEach(k => b[k] = []);
      const placed = n => Object.values(b).some(v => v.some(m => m.replace(' (cross-cover)', '') === n));
      // S4: nobody is pulled in to round during their vacation or on the weekends on either side of it
      const flank = p => { const vd = [...p.vacAll].filter(d => { const w = P.days[d - 1] && P.days[d - 1].w; return w >= 1 && w <= 5; }).sort((x, y) => x - y); if (!vd.length) return false;
        const f = vd[0], l = vd[vd.length - 1], off = new Set([f - 3, f - 2, f - 1, l + 1, l + 2, l + 3]); return callDays.some(d => off.has(d) || p.vacAll.has(d)); };
      const avail = p => !p.vacAll.has(refDay) && !(p.leaveDays || []).includes(refDay) && p.rotation !== 'Leave' && !flank(p);
      // the SICU fellow never cross-covers; she rounds only ICU, only on her weekends
      const all = [...new Set(callDays.map(d => A[d - 1]).filter(Boolean).flatMap(a => [a.I, a.M, a.U]).filter(Boolean))];
      const callers = all.filter(n => !P.byName[n] || P.byName[n].lvl !== 'F');
      const base = n => n.replace(' (cross-cover)', '');
      const label = (k, n) => BLOCK[k].includes(P.byName[n].rotation) || (k === 'ICU' && P.byName[n].lvl === 'F') ? n : n + ' (cross-cover)';
      // W7: one resident can round GS1 and GS2 together. Returns the person freed up (lower PGY of the two), or null.
      const combineGS = () => { if (b.GS1.length !== 1 || b.GS2.length !== 1) return null; const a = base(b.GS1[0]), c = base(b.GS2[0]); if (a === c || !P.byName[a] || !P.byName[c]) return null;
        const free = P.byName[a].pgy <= P.byName[c].pgy ? a : c, keep = free === a ? c : a; b.GS1 = [label('GS1', keep)]; b.GS2 = [label('GS2', keep)]; return free; };
      const shareGS = () => { if (!b.GS1.length && b.GS2.length === 1) b.GS1 = [label('GS1', base(b.GS2[0]))]; if (!b.GS2.length && b.GS1.length === 1) b.GS2 = [label('GS2', base(b.GS1[0]))]; };
      // T/EGS weekend rounding always has two people (the same pair rounds every day). Move someone from a team that
      // has two (lowest PGY first, never the fellow); else free someone by combining GS1 + GS2 (W7); else pull in a T/EGS resident.
      const twoT = (pull) => { const T = 'Trauma/EGS'; if (!wk || b[T].length >= 2) return;
        const offT = tUp ? tUppers.filter(u => u !== tUp).map(u => u.name) : [];
        const donors = Object.keys(b).filter(k => k !== T && b[k].length >= 2).flatMap(k => b[k].map(n => ({ k, n }))).filter(x => { const p = P.byName[base(x.n)]; return p && p.lvl !== 'F' && !(tUp && base(x.n) === tUp.name); })
          .sort((x, y) => P.byName[base(x.n)].pgy - P.byName[base(y.n)].pgy);
        if (donors.length) { const x = donors[0]; b[x.k].splice(b[x.k].indexOf(x.n), 1); b[T].push(label(T, base(x.n))); return; }
        const freed = combineGS(); if (freed) { b[T].push(label(T, freed)); return; }
        if (!pull) return;
        const f = P.people.filter(p => BLOCK[T].includes(p.rotation) && avail(p) && p.lvl !== 'F' && !callers.includes(p.name) && !placed(p.name) && !offT.includes(p.name))
          .sort((x, y) => (prev.has(x.name) - prev.has(y.name)) || x.pgy - y.pgy || ((fills[x.name] || 0) - (fills[y.name] || 0)))[0];
        if (f) { b[T].push(f.name); fills[f.name] = (fills[f.name] || 0) + 1; } };
      // HD5: a holiday is rounded by one team for the whole holiday, made only of the people on call during it
      // (the holiday Working list, plus the fellow if she's on call). Own service first; T/EGS gets two; GS1 + GS2 are
      // combined when that's what it takes (W7). Nobody outside the holiday's call pool rounds.
      if (refHoliday) {
        const pool = all.filter(n => P.byName[n]), extras = [];
        pool.forEach(n => { const p = P.byName[n], k = p.lvl === 'F' ? 'ICU' : blockOf(p); if (k && !b[k].length) b[k].push(n); else extras.push(n); });
        const ex = extras.filter(n => P.byName[n].lvl !== 'F').sort((x, y) => P.byName[x].pgy - P.byName[y].pgy), T = 'Trauma/EGS';
        while (b[T].length < 2 && ex.length) b[T].push(label(T, ex.shift()));
        Object.keys(b).forEach(k => { if (!b[k].length && ex.length) b[k].push(label(k, ex.shift())); });
        shareGS();
        if (b[T].length < 2) { const f = combineGS(); if (f) b[T].push(label(T, f)); }
        Object.keys(b).forEach(k => { if (!b[k].length) { const f = combineGS(); if (f) b[k].push(label(k, f)); } });
        ex.forEach(n => { const k = Object.keys(b).filter(x => x !== 'ICU').sort((p, q) => b[p].length - b[q].length)[0]; b[k].push(label(k, n)); });
        return { blocks: b, callers: all, workers: new Set(pool) };
      }
      callers.forEach(n => { const p = P.byName[n]; if (!p) return; const k = blockOf(p); if (k && !(k === 'ICU' && fellowWeek)) b[k].push(n); });
      // W3: fellow and ICU resident alternate weekends. Fellow weekend: fellow alone on ICU (an ICU resident on call cross-covers elsewhere).
      // Other weekends: the ICU resident(s) always round ICU.
      if (fellowWeek) b.ICU = [fellow.name];
      else if (!refHoliday) P.people.filter(p => p.rotation === 'ICU' && p.lvl !== 'F' && avail(p) && !b.ICU.includes(p.name)).forEach(p => b.ICU.push(p.name));
      // fill-in pick: someone on the service who didn't work last weekend, fewest fill-ins so far
      const pick = rots => P.people.filter(p => rots.includes(p.rotation) && avail(p) && p.lvl !== 'F' && !callers.includes(p.name))
        .sort((x, y) => (prev.has(x.name) - prev.has(y.name)) || ((fills[x.name] || 0) - (fills[y.name] || 0)) || (x.name < y.name ? -1 : 1))[0];
      // W6: the on-duty T/EGS upper level rounds T/EGS with one lower level: a T/EGS lower level on call, else the lowest-PGY caller
      // who has no block yet, else a T/EGS lower level pulled in (W1 rules)
      if (tUp) {
        const T = 'Trauma/EGS'; if (!b[T].includes(tUp.name)) b[T].unshift(tUp.name);
        const low = n => { const p = P.byName[n.replace(' (cross-cover)', '')]; return p && p.pgy <= 2; };
        if (!b[T].some(low)) {
          const free = callers.filter(n => !placed(n) && P.byName[n]).sort((x, y) => P.byName[x].pgy - P.byName[y].pgy);
          if (free.length) b[T].push(free[0] + ' (cross-cover)');
          else { const f = P.people.filter(p => BLOCK[T].includes(p.rotation) && p.pgy <= 2 && avail(p) && p.lvl !== 'F' && !callers.includes(p.name) && !prev.has(p.name)).sort((x, y) => x.pgy - y.pgy || (fills[x.name] || 0) - (fills[y.name] || 0))[0];
            if (f) { b[T].push(f.name); fills[f.name] = (fills[f.name] || 0) + 1; } }
        }
      }
      Object.keys(BLOCK).forEach(k => {
        // pull someone in only if they had last weekend off; otherwise leave the gap for a cross-covering caller (W1)
        if (!b[k].length && !((k === 'GS1' && b.GS2.length === 1) || (k === 'GS2' && b.GS1.length === 1))) { const f = pick(BLOCK[k]); if (f && !prev.has(f.name)) { b[k].push(f.name); fills[f.name] = (fills[f.name] || 0) + 1; } } // W7: GS1/GS2 can share one rounder instead of pulling someone in
        // W2: one resident covers HPB and Transplant; split into two when feasible (4+ people on the two services, second person didn't work last weekend)
        if (k === 'HPB/Transplant' && b[k].length === 1) {
          const one = P.byName[b[k][0]], other = one && one.rotation === 'HPB' ? 'Transplant' : 'HPB';
          const pool = P.people.filter(p => BLOCK[k].includes(p.rotation) && avail(p) && p.lvl !== 'F').length; // with <4 people, splitting forces back-to-back weekends
          const f = pool >= 4 ? pick([other]) : null; if (f && !prev.has(f.name)) { b[k].push(f.name); fills[f.name] = (fills[f.name] || 0) + 1; }
        }
      });
      callers.forEach(n => { if (placed(n)) return; const k = Object.keys(b).filter(x => !(fellowWeek && x === 'ICU')).sort((p, q) => b[p].length - b[q].length)[0]; b[k].push(n + ' (cross-cover)'); });
      shareGS(); // W7
      // still empty and no caller to cross-cover: pull someone in even if they worked last weekend
      Object.keys(BLOCK).forEach(k => { if (!b[k].length) { const f = pick(BLOCK[k]); if (f) { b[k].push(f.name); fills[f.name] = (fills[f.name] || 0) + 1; } } });
      twoT(true);
      // a whole service away (vacation, bookend weekends): someone already rounding moves over to cross-cover it,
      // taken from the fullest team (a cross-coverer first; never the fellow; T/EGS keeps its two)
      Object.keys(BLOCK).forEach(k => { if (b[k].length) return;
        const spare = Object.keys(b).filter(x => x !== k && b[x].length > (x === 'Trauma/EGS' ? 2 : 1)).flatMap(x => b[x].map(n => ({ x, n })))
          .filter(o => { const q = P.byName[base(o.n)]; return q && q.lvl !== 'F' && !(tUp && base(o.n) === tUp.name); })
          .sort((o1, o2) => (b[o2.x].length - b[o1.x].length) || (/cross-cover/.test(o2.n) - /cross-cover/.test(o1.n)) || (P.byName[base(o1.n)].pgy - P.byName[base(o2.n)].pgy))[0];
        if (spare) { b[spare.x].splice(b[spare.x].indexOf(spare.n), 1); b[k].push(label(k, base(spare.n))); } });
      const workers = new Set(all.concat(...Object.values(b).map(v => v.map(n => n.replace(' (cross-cover)', '')))));
      return { blocks: b, callers, workers };
    };
    // weekends of the month
    const WK = [];
    P.days.forEach(x => { const lone = x.w === 0 && x.d === 1; if (x.w !== 6 && !lone) return; const sat = x.w === 6 ? x.d : 0;
      WK.push({ ref: lone ? 1 : sat, days: lone ? [1] : [sat - 1, sat, sat + 1].filter(d => d >= 1 && d <= P.nd) }); });
    const okOn = (p, ref) => !p.vacAll.has(ref) && !(p.leaveDays || []).includes(ref);
    // locked call (PGY-5/fellow picks H10, holiday Working list H11) decides whose weekend it is when it can (locks win)
    const LOCKS = P.input.locks || [];
    const lockedOn = (name, w) => LOCKS.some(l => l.name === name && w.days.includes(l.day));
    // W3: fellow's ICU weekends for a given start parity (two a month, skipping her away weekends)
    const icuRes = P.people.filter(p => p.rotation === 'ICU' && p.lvl !== 'F' && !p.excluded);
    const fSet = par => { const s = new Set(); if (!fellow) return s; WK.forEach((w, i) => { if (i % 2 === par && s.size < 2 && okOn(fellow, w.ref)) s.add(i); }); return s; };
    const fConf = par => { const s = fSet(par); return WK.reduce((n, w, i) => n + (s.has(i) ? icuRes.filter(r => lockedOn(r.name, w)).length : (fellow && lockedOn(fellow.name, w) ? 1 : 0)), 0); };
    const fPar = [fStart, 1 - fStart].sort((a, c) => fConf(a) - fConf(c))[0], FW = fSet(fPar);
    // W6: on-duty T/EGS upper level for a given rotation offset
    const tOn = (i, off) => { for (let j = 0; j < tUppers.length; j++) { const p = tUppers[(i + off + j) % tUppers.length]; if (okOn(p, WK[i].ref)) return p; } return null; };
    const tConf = off => WK.reduce((n, w, i) => { const on = tOn(i, off); return n + tUppers.filter(u => u !== on && lockedOn(u.name, w)).length; }, 0);
    const tOff = tUppers.length >= 2 ? [...Array(tUppers.length).keys()].sort((a, c) => (tConf(a) - tConf(c)) || ((a !== tStart) - (c !== tStart)))[0] : 0;
    // HD5 holiday blocks: each run of holiday days, joined with any weekend it touches (a long weekend is one holiday),
    // gets one rounding team for every day of it
    const HS = new Set((holidays || []).filter(d => d >= 1 && d <= P.nd));
    WK.forEach(w => { const first = w.days[0], last = w.days.at(-1); if (w.days.some(d => HS.has(d)) || HS.has(last + 1) || HS.has(first - 1)) w.days.forEach(d => HS.add(d)); });
    const holBlocks = []; [...HS].sort((a, c) => a - c).forEach(d => { const bl = holBlocks.at(-1); if (bl && bl.at(-1) === d - 1) bl.push(d); else holBlocks.push([d]); });
    // A holiday that began last month (New Year: Dec 30–Jan 3) keeps last month's team, even though rotations change on the 1st
    const carry = P.input.carryHoliday;
    const holRec = {}; holBlocks.forEach(bl => { const built = build(bl, bl[0], new Set(), false, true, null, true);
      if (carry && bl[0] === 1) { Object.keys(built.blocks).forEach(k => { built.blocks[k] = (carry[k] || []).slice(); }); built.carried = true; }
      const rec = applyOvr(built, bl[0]); rec.holiday = true;
      rec.weekend = bl.some(d => [0, 5, 6].includes(P.days[d - 1].w)); rec.holidayDays = bl.slice(); bl.forEach(d => { holRec[d] = rec; }); });
    WK.forEach((w, i) => {
      const days = w.days;
      if (days.every(d => holRec[d])) { days.forEach(d => out[d] = holRec[d]); prevWorkers = holRec[days[0]].workers; wkIdx++; return; } // part of a holiday: its team covers it
      const fw = FW.has(i);
      const tUp = tUppers.length >= 2 ? tOn(i, tOff) : null;
      const rec = applyOvr(build(days, w.ref, prevWorkers, fw, false, tUp, true), w.ref);
      rec.weekend = true; rec.fellowWeek = fw; rec.tegsUpper = tUp ? tUp.name : null; rec.tegsOff = tUp ? tUppers.filter(p => p !== tUp).map(p => p.name) : []; prevWorkers = rec.workers;
      days.forEach(d => out[d] = rec); wkIdx++;
    });
    void fellowRounds;
    Object.entries(holRec).forEach(([d, rec]) => { if (!out[d]) out[d] = rec; }); // weekday holidays
    return out;
  }

  root.CallEngine = { solve, evaluate, prepare, roundingBlocks, DEFAULT_RULES, dow };
  if (typeof module !== 'undefined') module.exports = root.CallEngine;
})(typeof window !== 'undefined' ? window : globalThis);
