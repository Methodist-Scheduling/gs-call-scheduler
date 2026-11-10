#!/usr/bin/env node
// Rule tests for the call scheduler. Read-only: loads the engine, builds months from the roster data,
// and checks the rules. It never touches the live site or the database.
//
//   node tests/rules-test.js <path to setup bundle .json> [--seeds 3] [--quick]
//
// The roster data (names) is NOT in this repo; pass the setup bundle from the private Data folder.
// Exit code 0 = everything passed, 1 = at least one check failed.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'engine.js'));
globalThis.CallEngine = E;
const B = require(path.join(ROOT, 'build-input.js'));

const args = process.argv.slice(2), bundlePath = args.find(a => !a.startsWith('--'));
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const SEEDS = +(opt('seeds') || 3), ITERS = args.includes('--quick') ? 8000 : 30000;
if (!bundlePath) { console.error('Usage: node tests/rules-test.js <setup bundle .json>'); process.exit(2); }
let REF = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
if (Array.isArray(REF)) REF = Object.fromEntries(REF.map(r => [r.key, r.value]));
if (REF.reference) REF = Array.isArray(REF.reference) ? Object.fromEntries(REF.reference.map(r => [r.key, r.value])) : REF.reference;
const DATA = REF.data, PRE = REF.pre;

// ---------- tiny test harness ----------
let pass = 0, fail = 0; const fails = [], warns = [];
const warn = (name, items) => { if (items.length) warns.push(name + '\n      ' + [...new Set(items)].slice(0, 8).join(' | ')); };
const check = (name, ok, detail) => { if (ok) pass++; else { fail++; fails.push(name + (detail ? '\n      ' + detail : '')); } };
const section = t => console.log('\n' + t);
const base = n => n.replace(' (cross-cover)', '');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- the same inputs the app builds (kept deliberately small; see buildInput in app.js) ----------
const APP_RULES = { pgy4MidSlot: false, sameServiceBlocked: false, noTwoPerson: [], fellowCap: 4, maxQ2Run: 3, callHours: 24, targets: { 1: [5, 6], 2: [5, 6], 3: [5, 6], 4: [6, 7], 5: [6, 6], F: [4, 4] } };
function holidayLocks(k) { const x = PRE.trios.Christmas, n = PRE.trios.NewYear;
  if (k === '2026-12') return [[23, x[0]], [25, x[0]], [27, x[0]], [24, x[1]], [26, x[1]], [30, n[0]], [31, n[1]]];
  if (k === '2027-01') return [[1, n[0]], [3, n[0]], [2, n[1]]];
  return []; }
function inputFor(k, drafts, noCarry) {
  const [y, m] = k.split('-').map(Number);
  const D = Object.assign({}, DATA, { history: Object.assign({}, DATA.history) });
  Object.entries(drafts || {}).forEach(([kk, A]) => { if (kk < k) D.history[kk] = A.map((a, i) => ({ d: i + 1, call: [a.U, a.M, a.I].filter(Boolean), vac: [] })); });
  const inp = B.buildInput(D, y, m, 'draft'); inp.rules = JSON.parse(JSON.stringify(APP_RULES));
  holidayLocks(k).forEach(([d, t]) => inp.locks.push({ day: d, slot: 'U', name: t[2] }, { day: d, slot: 'M', name: t[1] }, { day: d, slot: 'I', name: t[0] }));
  inp.lockedSlots = {}; inp.locks.forEach(l => inp.lockedSlots[l.day + l.slot] = l.name);
  // a holiday running over from last month keeps last month's rounding team (same as the app)
  const pk = Object.keys(drafts || {}).filter(x => x < k).sort().at(-1), hol = B.HOLIDAYS[k] || [];
  if (!noCarry && pk && hol.includes(1)) { const [py, pm] = pk.split('-').map(Number), last = B.ndays(py, pm);
    if ((B.HOLIDAYS[pk] || []).includes(last)) { const r = E.roundingBlocks(E.prepare(inputFor(pk, drafts)), drafts[pk], B.HOLIDAYS[pk])[last]; if (r) inp.carryHoliday = JSON.parse(JSON.stringify(r.blocks)); } }
  return inp;
}
function build(k, drafts, seed) { const inp = inputFor(k, drafts); let best = null;
  for (let i = 0; i < 2; i++) { const r = E.solve(inp, { seed: seed + i * 7919, iters: ITERS }); if (!best || r.ev.cost < best.ev.cost) best = r; }
  return best.A.map(a => ({ U: a.U || null, M: a.M || null, I: a.I || null })); }

// ---------- checks on one month's call schedule ----------
function checkCalls(k, A, drafts, tag) {
  const [y, m] = k.split('-').map(Number), mn = MON[m - 1], P = E.prepare(inputFor(k, drafts)), ev = E.evaluate(P, A);
  const hard = ev.issues.filter(x => x.sev === 'hard');
  check(`${tag} no hard-rule breaks`, hard.length === 0, hard.slice(0, 6).map(x => x.msg).join(' | '));
  const bad = [];
  A.forEach((a, i) => { const d = i + 1, names = [a.U, a.M, a.I].filter(Boolean);
    if (!a.U || !a.I) bad.push(`${mn} ${d}: missing ${!a.U ? 'upper' : 'intern'}`);
    if (new Set(names).size !== names.length) bad.push(`${mn} ${d}: same person twice`);
    const lv = n => P.byName[n] && P.byName[n].lvl;
    if (a.I && lv(a.I) !== 1) bad.push(`${mn} ${d}: intern slot holds a non-intern`);
    if (a.M && ![2, 3].includes(lv(a.M))) bad.push(`${mn} ${d}: mid slot holds PGY-${lv(a.M)}`);
    if (a.U && ![4, 5, 'F'].includes(lv(a.U))) bad.push(`${mn} ${d}: upper slot holds PGY-${lv(a.U)}`);
    names.forEach(n => { const p = P.byName[n]; if (!p) return bad.push(`${mn} ${d}: unknown person`);
      if (p.excluded) bad.push(`${mn} ${d}: ${n} is on a rotation that takes no call`);
      if (p.out.has(d)) bad.push(`${mn} ${d}: ${n} on call while on vacation/leave`);
      if (i > 0 && [A[i - 1].U, A[i - 1].M, A[i - 1].I].includes(n)) bad.push(`${mn} ${d}: ${n} on call two days in a row`); });
    if (!a.M && [5, 6].includes(P.days[i].w) && !P.input.holidays.includes(d)) bad.push(`${mn} ${d}: two-person call on a Fri/Sat (H4)`); });
  check(`${tag} every day staffed correctly (levels, no doubles, no back-to-back days, nobody on vacation)`, bad.length === 0, bad.slice(0, 6).join(' | '));
  const lk = holidayLocks(k).filter(([d, t]) => !(A[d - 1].I === t[0] && A[d - 1].M === t[1] && A[d - 1].U === t[2]));
  check(`${tag} holiday trios are exactly where the holiday list puts them`, lk.length === 0, lk.map(([d]) => `${mn} ${d}`).join(', '));
  return { P, ev };
}

// ---------- checks on weekend / holiday rounding ----------
function checkRounding(k, A, drafts, tag) {
  const [y, m] = k.split('-').map(Number), mn = MON[m - 1], P = E.prepare(inputFor(k, drafts)), hol = B.HOLIDAYS[k] || [];
  const rb = E.roundingBlocks(P, A, hol), rb2 = E.roundingBlocks(P, A, hol);
  const recs = [...new Set(Object.values(rb))], daysOf = r => Object.keys(rb).map(Number).filter(d => rb[d] === r).sort((a, b) => a - b);
  const lab = r => { const ds = daysOf(r); return `${mn} ${ds[0]}${ds.length > 1 ? '–' + ds.at(-1) : ''}`; };
  check(`${tag} rounding is stable (same answer twice)`, JSON.stringify(Object.keys(rb).map(d => rb[d].blocks)) === JSON.stringify(Object.keys(rb2).map(d => rb2[d].blocks)));
  const sat = P.days.filter(x => x.w === 6 || x.w === 0).map(x => x.d).filter(d => !rb[d]);
  check(`${tag} every Sat/Sun and holiday has a rounding team`, sat.length === 0 && hol.every(d => rb[d]), sat.map(d => `${mn} ${d}`).join(', '));
  const t2 = recs.filter(r => (r.weekend || r.holiday) && r.blocks['Trauma/EGS'].length < 2).map(lab);
  check(`${tag} T/EGS always has two rounders (W6)`, t2.length === 0, t2.join(', '));
  const empty = recs.flatMap(r => Object.entries(r.blocks).filter(([, v]) => !v.length).map(([b]) => `${lab(r)} ${b}`));
  check(`${tag} no service left without a rounder`, empty.length === 0, empty.join(', '));
  const dup = []; recs.forEach(r => { const seen = {}; Object.entries(r.blocks).forEach(([b, v]) => v.forEach(n => { const x = base(n); (seen[x] = seen[x] || []).push(b); }));
    Object.entries(seen).forEach(([n, bs]) => { if (bs.length > 1 && !(bs.length === 2 && bs.includes('GS1') && bs.includes('GS2'))) dup.push(`${lab(r)}: ${n} on ${bs.join(' + ')}`); }); });
  check(`${tag} nobody rounds two teams (except GS1 + GS2 together, W7)`, dup.length === 0, dup.join(' | '));
  const fel = []; recs.forEach(r => Object.entries(r.blocks).forEach(([b, v]) => v.forEach(n => { const p = P.byName[base(n)]; if (p && p.lvl === 'F' && b !== 'ICU') fel.push(`${lab(r)}: fellow on ${b}`); })));
  check(`${tag} the fellow only rounds ICU`, fel.length === 0, fel.join(' | '));
  // days actually rounded: Sat, Sun and holiday days (the Friday of a normal weekend is a regular workday)
  const roundDays = r => daysOf(r).filter(d => [0, 6].includes(P.days[d - 1].w) || hol.includes(d));
  const away = [], vacWk = []; recs.forEach(r => roundDays(r).forEach(d => Object.values(r.blocks).flat().forEach(n => { const p = P.byName[base(n)]; if (!p) return;
    if (p.rotation === 'Leave' || p.out.has(d)) away.push(`${mn} ${d}: ${base(n)}`);
    else if (p.vacAll.has(d)) vacWk.push(`${mn} ${d}: ${base(n)}${[A[d - 1].U, A[d - 1].M, A[d - 1].I].includes(base(n)) ? ' (on call that day)' : r.callers.includes(base(n)) ? ' (on call that weekend)' : ' (pulled in)'}`); })));
  check(`${tag} nobody rounds on a vacation weekday or while on leave`, away.length === 0, [...new Set(away)].slice(0, 6).join(' | '));
  warn(`${tag} rounding on the weekend at the end of a vacation week (allowed today; is it what you want?)`, vacWk);
  // HD5: one team per holiday, made only of that holiday's callers
  const hrecs = recs.filter(r => r.holiday), out = [];
  hrecs.forEach(r => { const ds = daysOf(r), pool = new Set(ds.flatMap(d => [A[d - 1].U, A[d - 1].M, A[d - 1].I]).filter(Boolean));
    Object.values(r.blocks).flat().forEach(n => { if (!pool.has(base(n))) out.push(`${lab(r)}: ${base(n)}`); }); });
  check(`${tag} holiday rounders all come from that holiday's call pool (HD5)`, out.length === 0, out.join(' | '));
  const split = hol.filter((d, i) => i > 0 && hol[i - 1] === d - 1 && rb[d] !== rb[d - 1]).map(d => `${mn} ${d - 1}/${d}`);
  check(`${tag} each holiday is one team from start to finish (HD5)`, split.length === 0, split.join(', '));
  // W6 / W3: an off weekend is fully off (no rounding, no call)
  const off = []; recs.filter(r => r.weekend && !r.holiday).forEach(r => { const span = daysOf(r); // Fri, Sat, Sun
    (r.tegsOff || []).forEach(n => { if (Object.values(r.blocks).flat().some(x => base(x) === n)) off.push(`${lab(r)}: ${n} rounds on their T/EGS off weekend`);
      span.forEach(d => { if ([A[d - 1].U, A[d - 1].M, A[d - 1].I].includes(n) && !P.input.lockedSlots[d + 'U'] && !P.input.lockedSlots[d + 'M']) off.push(`${mn} ${d}: ${n} on call on their T/EGS off weekend`); }); }); });
  check(`${tag} a T/EGS off weekend is fully off (W6)`, off.length === 0, off.join(' | '));
  return { rb, recs, daysOf, P };
}

// ---------- repo checks ----------
section('Code');
['app.js', 'auth.js', 'practice.js', 'engine.js', 'build-input.js', 'rules-catalog.js'].forEach(f => { let ok = true, msg = ''; try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); } catch (e) { ok = false; msg = String(e.stderr || e.message).split('\n').slice(0, 3).join(' '); } check(`${f} has no syntax errors`, ok, msg); });
{ const w = {}; let ok = true, msg = ''; try { new Function('window', fs.readFileSync(path.join(ROOT, 'rules-catalog.js'), 'utf8'))(w); } catch (e) { ok = false; msg = e.message; }
  const txt = ok ? JSON.stringify(w.RULES_CATALOG) : ''; check('rules catalog loads and lists HD5, W6, W7', ok && ['HD5', 'W6', 'W7'].every(id => txt.includes(`"id":"${id}"`)), msg); }
{ // the repo is public: roster names must never appear in the code (they live in the database)
  const names = Object.keys(DATA.pgy).filter(n => n.length >= 4), hits = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => { if (e.name === '.git' || e.name === 'node_modules') return; const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p); if (!/\.(js|html|css|sql|ts|md|json|yml)$/.test(e.name)) return; const t = fs.readFileSync(p, 'utf8');
    names.forEach(n => { if (new RegExp('\\b' + n + '\\b').test(t)) hits.push(`${path.relative(ROOT, p)}: ${n}`); }); });
  walk(ROOT); check('no roster names in the public code', hits.length === 0, hits.slice(0, 8).join(' | ')); }

// ---------- December (pre-filled draft + fresh builds) and January ----------
const toObj = A => A.map(([U, M, I]) => ({ U, M, I }));
section('December 2026, the pre-filled draft');
const decPre = toObj(PRE.A); checkCalls('2026-12', decPre, {}, 'Dec draft:'); const rDec = checkRounding('2026-12', decPre, {}, 'Dec draft:');

for (let s = 1; s <= SEEDS; s++) {
  section(`Fresh build #${s}: December, then January on top of it`);
  const dec = build('2026-12', {}, 1000 * s + 7); checkCalls('2026-12', dec, {}, `Dec #${s}:`); const rd = checkRounding('2026-12', dec, {}, `Dec #${s}:`);
  const jan = build('2027-01', { '2026-12': dec }, 2000 * s + 11); checkCalls('2027-01', jan, { '2026-12': dec }, `Jan #${s}:`); const rj = checkRounding('2027-01', jan, { '2026-12': dec }, `Jan #${s}:`);
  // the New Year holiday runs Dec 30–Jan 3: December's team and January's team should be the same people on the same services
  const a = rd.rb[31], b = rj.rb[1];
  if (a && b) { const diff = Object.keys(a.blocks).filter(k => JSON.stringify(a.blocks[k].map(base).sort()) !== JSON.stringify(b.blocks[k].map(base).sort()));
    check(`New Year #${s}: the Dec 30–31 team and the Jan 1–3 team match`, diff.length === 0, diff.map(k => `${k}: Dec ${a.blocks[k].map(base).join('/') || '-'} vs Jan ${b.blocks[k].map(base).join('/') || '-'}`).join(' | ')); }
}

if (warns.length) { console.log('\nHeads-up (not failures):'); warns.forEach(w => console.log('  ! ' + w)); }
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailed:'); fails.forEach(f => console.log('  ✗ ' + f)); }
process.exit(fail ? 1 : 0);
