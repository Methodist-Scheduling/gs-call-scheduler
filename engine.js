// Call schedule engine v1.2 — General Surgery. Rules: Docs "Call Scheduling Rules v1.1".
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
    weights: { target: 60, q2: 30, gap3: 4, noWeekendOff: 220, oneWeekendOff: 45, bookend: 70, gs2: 12, protected: 90, request: 80,
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
      let wOff = 0, wTot = 0, fri = 0, sat = 0, sun = 0, wk = 0, hol = 0, two = 0;
      P.weekends.forEach(g => { const inM = g.filter(d => d <= nd); if (inM.length < 3) return; wTot++; if (!g.some(d => c.includes(d))) wOff++; });
      c.forEach(d => { const w = P.days[d - 1].w; if (w === 5) fri++; if (w === 6) sat++; if (w === 0) sun++; if (isWknd(w)) wk++; if ((input.holidays || []).includes(d)) hol++; if (!A[d - 1].M) two++; });
      const elig = !p.excluded;
      if (elig && wTot) {
        if (wOff === 0) { soft += W.noWeekendOff; br.S5 = (br.S5 || 0) + W.noWeekendOff; }
        else if (wOff === 1 && wTot >= 3) { soft += W.oneWeekendOff; br.F2 = (br.F2 || 0) + W.oneWeekendOff; }
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
      // GS2 colorectal (S3)
      if (p.rotation === 'GS2') c.forEach(d => { const w = P.days[d - 1].w; const marked = (input.colorectalDays || []).includes(d + 1); if (marked) add('S3', 1e6, `${p.name}: post-call on marked colorectal day ${d + 1}`, 'hard'); else if (w === 0 || w === 1) { soft += W.gs2; br.S3 = (br.S3 || 0) + W.gs2; } });
      // protected (S2)
      (input.protected || []).forEach(ev => { if ((ev.names || []).includes(p.name) && c.includes(ev.day - 1)) { soft += W.protected; br.S2 = (br.S2 || 0) + W.protected; } });
      // requests (S6)
      (input.requests || []).forEach(r => { if (r.name === p.name) { const hit = c.includes(r.day); if ((r.type === 'off' && hit) || (r.type === 'want' && !hit)) { soft += W.request; br.S6 = (br.S6 || 0) + W.request; } } });
      stats[p.name] = { calls: c, n, q2, minGap: minGap === 99 ? null : minGap, wOff, wTot, fri, sat, sun, wk, hol, two, bookBroken, tmin: p.tmin, tmax: p.tmax };
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
  // one own-service resident; W2 keeps a Transplant resident on HPB/Transplant; W3 alternates ICU.
  function roundingBlocks(P, A, holidays) {
    const out = {};
    const BLOCK = { 'Trauma/EGS': ['Trauma', 'EGS'], ICU: ['ICU'], GS1: ['GS1'], GS2: ['GS2'], 'Vasc/Thor': ['Vascular', 'Thoracic'], 'HPB/Transplant': ['HPB', 'Transplant'] };
    const blockOf = p => Object.keys(BLOCK).find(k => BLOCK[k].includes(p.rotation));
    const fellow = P.people.find(p => p.lvl === 'F');
    let wkIdx = 0;
    // callDays: days whose callers work this block; roundDays: days the block is printed on
    const build = (callDays, refDay, fellowWeek) => {
      const b = {}; Object.keys(BLOCK).forEach(k => b[k] = []);
      const avail = p => !p.vacAll.has(refDay) && !(p.leaveDays || []).includes(refDay) && p.rotation !== 'Leave';
      const callers = [...new Set(callDays.map(d => A[d - 1]).filter(Boolean).flatMap(a => [a.I, a.M, a.U]).filter(Boolean))];
      callers.forEach(n => { const p = P.byName[n]; if (!p) return; const k = blockOf(p); if (k && !(k === 'ICU' && p.lvl !== 'F' && fellowWeek && fellow)) b[k].push(n); });
      if (fellow) { if (fellowWeek) b.ICU = [fellow.name]; else b.ICU = b.ICU.filter(n => n !== fellow.name); }
      Object.keys(BLOCK).forEach(k => {
        if (k === 'HPB/Transplant') { const tx = P.people.find(p => p.rotation === 'Transplant' && avail(p)); if (tx && !b[k].includes(tx.name)) b[k].push(tx.name); }
        if (!b[k].length) { const own = P.people.find(p => BLOCK[k].includes(p.rotation) && avail(p) && p.lvl !== 'F'); if (own) b[k].push(own.name); }
      });
      callers.forEach(n => { if (Object.values(b).some(v => v.includes(n))) return; const k = Object.keys(b).sort((p, q) => b[p].length - b[q].length)[0]; b[k].push(n + ' (cross-cover)'); });
      return { blocks: b, callers };
    };
    P.days.forEach(x => {
      const lone = x.w === 0 && x.d === 1; // month starting on a Sunday
      if (x.w !== 6 && !lone) return;
      const sat = x.w === 6 ? x.d : 0, fri = sat - 1, sun = sat + 1;
      const days = lone ? [1] : [fri, sat, sun].filter(d => d >= 1 && d <= P.nd);
      const rec = build(days, lone ? 1 : sat, wkIdx % 2 === 0);
      rec.weekend = true;
      days.forEach(d => out[d] = rec); wkIdx++;
    });
    (holidays || []).forEach(d => { if (out[d] || d < 1 || d > P.nd) return; const rec = build([d], d, wkIdx % 2 === 1); rec.holiday = true; out[d] = rec; });
    return out;
  }

  root.CallEngine = { solve, evaluate, prepare, roundingBlocks, DEFAULT_RULES, dow };
  if (typeof module !== 'undefined') module.exports = root.CallEngine;
})(typeof window !== 'undefined' ? window : globalThis);
