window.startScheduler = (CTX) => {
const E = window.CallEngine, B = window.BuildInput, sb = CTX.sb;
const DATA = CTX.ref.data, BT = CTX.ref.backtest || {}, PRE = CTX.ref.pre;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KEYS = Object.keys(DATA.rotations).filter(k => k >= '2026-12').sort();
const HOLNAMES = { '2026-12': { 23: 'Christmas', 24: 'Christmas', 25: 'Christmas Day', 26: 'Christmas', 27: 'Christmas', 30: 'New Year', 31: 'New Year’s Eve' }, '2027-01': { 1: 'New Year’s Day', 2: 'New Year', 3: 'New Year' } };
const LEVEL = n => { const p = DATA.pgy[n]; return p === 'F' ? 'Fellow' : 'PGY-' + p; };
const SLOTNAME = { U: 'Upper level', M: 'Mid level', I: 'Intern' };
const ROTATIONS = [...new Set(Object.values(DATA.rotations).flatMap(m => Object.values(m).map(r => r.rotation)).concat(['Leave']))].sort();
const RULE_LABEL = { S1: 'S1 every-other-day call', S2: 'S2 protected time', S3: 'S3 colorectal day', S4: 'S4 vacation bookends', S5: 'S5 weekend off', S6: 'S6 requests', S7: 'S7 back-to-back weekends', F1: 'F1 call targets', F2: 'F2 second weekend off', F3: 'F3 weekend balance (YTD)', F4: 'F4 two-person balance' };
const ym = k => k.split('-').map(Number);
const ndays = k => { const [y, m] = ym(k); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const iso = (k, d) => k + '-' + String(d).padStart(2, '0');

// ---------- state ----------
const S = {
  month: '2026-12', role: ({ scheduler: 'Scheduler', chief: 'Chief', pd: 'Program Director', resident: 'Resident' })[CTX.profile.role], realRole: CTX.profile.role, isAdmin: CTX.profile.is_admin, histMonth: '2026-11', histView: 'actual', proposals: [],
  rules: { pgy4MidSlot: false, sameServiceBlocked: false, noTwoPerson: [], fellowCap: 4, maxQ2Run: 3, callHours: 24, targets: { 1: [5, 6], 2: [5, 6], 3: [5, 6], 4: [6, 7], 5: [6, 6], F: [4, 4] } },
  trioSwap: { xmas: false, ny: false },
  people: {}, // leave dates by name (stored in the database, not here)
  M: {}
};
function blankMonth(k) {
  const inputs = {};
  Object.entries(DATA.rotations[k]).forEach(([n, r]) => { inputs[n] = { rotation: r.rotation, vac: r.vac_txt || '', picks: '' }; });
  return { A: null, locks: {}, constraints: [], status: 'Draft', versions: [], log: [], inputs,
    notesText: '' };
}
KEYS.forEach(k => S.M[k] = blankMonth(k));
S.M['2026-12'].A = PRE.A.map(([U, M, I]) => ({ U, M, I }));
const cur = () => S.M[S.month];
let me = { id: CTX.user.id, name: CTX.profile.display_name }, sample = true, downloads = true, applyingRemote = false;
const existing = new Set();

// ---------- inputs -> engine ----------
function parseDays(t, max) { const out = []; String(t || '').split(/[,\s]+/).forEach(p => { const m = p.match(/^(\d+)-(\d+)$/); if (m) for (let d = +m[1]; d <= +m[2]; d++) out.push(d); else if (/^\d+$/.test(p)) out.push(+p); }); return [...new Set(out.filter(d => d >= 1 && d <= (max || 31)))]; }
function parseVac(t, k) { // "7-13", "Sep 28-Oct 4"
  const [y, m] = ym(k), MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  let mm = String(t || '').match(/^(\w{3}) (\d+)-(\w{3}) (\d+)$/);
  if (mm) { const o = []; if (MON[mm[1]] === m) for (let d = +mm[2]; d <= ndays(k); d++) o.push(d); if (MON[mm[3]] === m) for (let d = 1; d <= +mm[4]; d++) o.push(d); return o; }
  return parseDays(t, ndays(k));
}
function leaveDaysFor(name, k) {
  const L = S.people[name]; if (!L || !L.leaveFrom || !L.leaveTo) return [];
  const o = []; for (let d = 1; d <= ndays(k); d++) { const s = iso(k, d); if (s >= L.leaveFrom && s <= L.leaveTo) o.push(d); } return o;
}
function dataWithDrafts(k) { // history + earlier drafts, so January sees December for spacing and year-to-date
  const D = Object.assign({}, DATA, { history: Object.assign({}, DATA.history) });
  KEYS.filter(x => x < k).forEach(x => { const A = S.M[x].A; if (A) D.history[x] = A.map((a, i) => ({ d: i + 1, call: [a.U, a.M, a.I].filter(Boolean), vac: [] })); });
  return D;
}
function trios() { const t = PRE.trios; return { x: S.trioSwap.xmas ? [t.Christmas[1], t.Christmas[0]] : t.Christmas, n: S.trioSwap.ny ? [t.NewYear[1], t.NewYear[0]] : t.NewYear }; }
function holidayLocks(k) { // [{day, trio:[I,M,U]}]
  const { x, n } = trios();
  if (k === '2026-12') return [[23, x[0]], [25, x[0]], [27, x[0]], [24, x[1]], [26, x[1]], [30, n[0]], [31, n[1]]];
  if (k === '2027-01') return [[1, n[0]], [3, n[0]], [2, n[1]]];
  return [];
}
const isHolidayLock = (k, d) => holidayLocks(k).some(([x]) => x === d);
function picksOf(k) { const out = []; Object.entries(S.M[k].inputs).forEach(([n, v]) => { if ([5, 'F'].includes(DATA.pgy[n])) parseDays(v.picks, ndays(k)).forEach(d => out.push({ day: d, name: n })); }); return out; }
function buildInput(k) {
  k = k || S.month; const [y, m] = ym(k); const st = S.M[k];
  const inp = B.buildInput(dataWithDrafts(k), y, m, 'draft');
  inp.rules = JSON.parse(JSON.stringify(S.rules));
  inp.people = inp.people.map(p => {
    const v = st.inputs[p.name] || {}; const lv = leaveDaysFor(p.name, k); const full = lv.length >= ndays(k);
    return Object.assign(p, { rotation: full ? 'Leave' : (v.rotation || p.rotation), vacDays: parseVac(v.vac, k), leaveDays: full ? [] : lv });
  });
  holidayLocks(k).forEach(([d, t]) => { inp.locks.push({ day: d, slot: 'U', name: t[2] }, { day: d, slot: 'M', name: t[1] }, { day: d, slot: 'I', name: t[0] }); });
  picksOf(k).forEach(p => { if (!inp.locks.some(l => l.day === p.day && l.slot === 'U')) inp.locks.push({ day: p.day, slot: 'U', name: p.name }); });
  Object.entries(st.locks).forEach(([kk, name]) => { const [d, s] = kk.split('|'); if (!inp.locks.some(l => l.day === +d && l.slot === s)) inp.locks.push({ day: +d, slot: s, name: name || null }); });
  st.constraints.forEach(c => {
    if (c.type === 'off' || c.type === 'want') c.days.forEach(d => inp.requests.push({ name: c.name, day: d, type: c.type }));
    if (c.type === 'protected') c.days.forEach(d => inp.protected.push({ day: d, names: [c.name], label: c.reason }));
    if (c.type === 'colorectal') c.days.forEach(d => inp.colorectalDays.push(d));
    if (c.type === 'block') { const p = inp.people.find(p => p.name === c.name); if (p) p.blockDays = (p.blockDays || []).concat(c.days); }
  });
  inp.lockedSlots = {}; inp.locks.forEach(l => inp.lockedSlots[l.day + l.slot] = l.name);
  return inp;
}
let CUR = null;
function evaluateNow() {
  const st = cur(); if (!st.A) return null;
  const inp = buildInput(); const P = E.prepare(inp); const ev = E.evaluate(P, st.A);
  CUR = { inp, P, ev, rb: E.roundingBlocks(P, st.A, B.HOLIDAYS[S.month] || []), est: estimated(st.A) };
  return CUR;
}
function estimated(A) { // calls that depend on an unconfirmed date
  const out = {}; const k = S.month;
  Object.entries(S.people).forEach(([n, L]) => {
    if (L.leaveConfirmed || !L.leaveTo) return;
    const touches = leaveDaysFor(n, k).length || L.leaveTo.slice(0, 7) === k;
    if (!touches) return;
    A.forEach((a, i) => ['U', 'M', 'I'].forEach(s => { if (a[s] === n) out[(i + 1) + s] = `${n}'s return date (${L.leaveTo}) is an estimate`; }));
  });
  return out;
}
function generate(keepLocks, k) {
  k = k || S.month; toast('Building the schedule…');
  setTimeout(() => {
    const st = S.M[k]; if (!keepLocks) st.locks = {};
    const inp = buildInput(k); let best = null;
    for (let i = 0; i < 2; i++) { const r = E.solve(inp, { seed: (Date.now() + i * 7919) % 100000, iters: 30000 }); if (!best || r.ev.cost < best.ev.cost) best = r; }
    st.A = best.A.map(a => ({ U: a.U || null, M: a.M || null, I: a.I || null }));
    logEvent(k, keepLocks ? 'Regenerated around locked cells' : 'Generated a fresh draft');
    save(k); render(); toast(best.ev.hard ? 'Done, but some hard rules could not be met. See the list.' : 'Done. All hard rules met.');
  }, 30);
}

// ---------- persistence (Supabase) ----------
function monthData(k) { const st = S.M[k]; return { A: st.A ? st.A.map(a => [a.U, a.M, a.I]) : null, locks: st.locks, constraints: st.constraints, notesText: st.notesText, inputs: st.inputs }; }
function adoptMonth(row) {
  const k = row.key; if (!S.M[k]) return; const st = S.M[k], d = row.data || {};
  if (d.A) st.A = d.A.map(([U, M, I]) => ({ U, M, I }));
  ['locks', 'constraints', 'notesText', 'inputs'].forEach(x => { if (d[x] !== undefined) st[x] = d[x]; });
  st.status = row.status || st.status; existing.add(k);
}
function adoptSettings(r) { if (!r) return; if (r.rules && Object.keys(r.rules).length) S.rules = Object.assign(S.rules, r.rules); if (r.trio_swap) S.trioSwap = r.trio_swap; if (r.people && Object.keys(r.people).length) S.people = r.people; }
const timers = {}; let settingsTimer = null, pendingOwn = 0;
function save(k) {
  k = k || S.month; if (applyingRemote) return; clearTimeout(timers[k]);
  timers[k] = setTimeout(async () => {
    const st = S.M[k]; pendingOwn++;
    const body = { status: st.status, data: monthData(k) };
    const q = existing.has(k) ? sb.from('months').update(body).eq('key', k) : sb.from('months').insert(Object.assign({ key: k }, body));
    const { error } = await q; setTimeout(() => pendingOwn--, 1500);
    if (error) toast('Not saved: ' + (/row-level|permission/i.test(error.message) ? 'your role can’t make this change.' : error.message)); else existing.add(k);
  }, 600);
  saveSettings();
}
function saveSettings() {
  if (!['scheduler', 'chief'].includes(S.realRole)) return;
  clearTimeout(settingsTimer); settingsTimer = setTimeout(async () => { pendingOwn++; const { error } = await sb.from('settings').update({ rules: S.rules, trio_swap: S.trioSwap, people: S.people }).eq('id', 1); setTimeout(() => pendingOwn--, 1500); if (error) toast('Settings not saved: ' + error.message); }, 700);
}
function logEvent(k, text) { S.M[k].log.push({ at: new Date().toISOString(), role: roleName(), text: (me.name ? me.name + ': ' : '') + text }); sb.from('activity_log').insert({ user_id: me.id, month_key: k, text: `${me.name} (${roleName()}): ${text}` }).then(() => {}); }
const roleKey = r => ({ Scheduler: 'scheduler', Chief: 'chief', 'Program Director': 'pd', Resident: 'resident' })[r];
const roleName = () => ({ Scheduler: 'Scheduler', Chief: 'PGY-5 chief', 'Program Director': 'PD', Resident: 'Resident' }[S.role]);
function connect() {
  sb.channel('board').on('postgres_changes', { event: '*', schema: 'public', table: 'months' }, p => { if (pendingOwn || !p.new) return; applyingRemote = true; adoptMonth(p.new); applyingRemote = false; render(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, p => { if (pendingOwn || !p.new) return; adoptSettings(p.new); render(); }).subscribe();
}
(CTX.months || []).forEach(adoptMonth);
adoptSettings(CTX.settings);
(CTX.versions || []).forEach(v => { const st = S.M[v.month_key]; if (st) st.versions.push({ n: v.n, at: v.created_at, status: v.status, A: v.schedule, changed: v.changed }); });
(CTX.logs || []).slice().reverse().forEach(l => { const st = S.M[l.month_key]; if (st) st.log.push({ at: l.at, role: '', text: l.text }); });
if (S.realRole === 'scheduler' && !existing.has('2026-12') && S.M['2026-12'].A) save('2026-12');

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 3400); }
const isScheduler = () => S.role === 'Scheduler';
const canEdit = () => isScheduler() && !['Published', 'PD review'].includes(cur().status);
const canSwap = () => S.role === 'Scheduler' || S.role === 'Chief';
const monthName = k => { const [y, m] = ym(k); return `${MONTHS_LONG[m - 1]} ${y}`; };
const dateLabel = (k, d) => { const [y, m] = ym(k); return `${DOW[E.dow(y, m, d)]} ${MONTHS[m - 1]} ${d}`; };
const dayType = (k, d) => { const [y, m] = ym(k); const w = E.dow(y, m, d); return w === 5 ? 'Friday' : (w === 6 || w === 0) ? 'weekend' : 'weekday'; };
function deadline(k) { const [y, m] = ym(k); const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; const dl = new Date(py, pm - 1, 15); const days = Math.ceil((dl - new Date(new Date().toDateString())) / 864e5); return { label: `${MONTHS[pm - 1]} 15`, days }; }

// ---------- calendar ----------
const RABBR = { 'Trauma/EGS': 'T/EGS', ICU: 'ICU', GS1: 'GS1', GS2: 'GS2', 'Vasc/Thor': 'V/T', 'HPB/Transplant': 'HPB/Tx' };
// Same rule as the PDF: rounding prints on Sat, Sun and holiday cells.
function roundLines(rb, k, d) {
  const [y, m] = ym(k), w = E.dow(y, m, d), rec = rb && rb[d];
  if (!rec || !(w === 6 || w === 0 || rec.holiday || (HOLNAMES[k] || {})[d])) return null;
  return Object.entries(rec.blocks).map(([b, v]) => `${RABBR[b] || b}: ${v.map(n => n.replace(' (cross-cover)', '*')).join('/') || '-'}`);
}
function calendarHTML(A, k, o) {
  const [y, m] = ym(k), first = E.dow(y, m, 1); let h = DOW.map(d => `<div class="hd">${d}</div>`).join('');
  for (let i = 0; i < first; i++) h += '<div class="day blank"></div>';
  A.forEach((a, i) => {
    const d = i + 1, w = E.dow(y, m, d), wk = w === 0 || w === 6 || w === 5;
    const chips = ['U', 'M', 'I'].map(s => {
      const n = a[s], key = d + s, est = o.est && o.est[key], lk = o.locked ? o.locked(d, s, n) : '';
      if (!n) return `<button class="chip empty" data-d="${d}" data-s="${s}" ${o.click ? '' : 'disabled'}>${s === 'M' ? 'two-person call' : 'no ' + SLOTNAME[s].toLowerCase()}</button>`;
      return `<button class="chip ${s} ${est ? 'est' : ''}" data-d="${d}" data-s="${s}" ${o.click ? '' : 'disabled'} title="${esc(n)} · ${LEVEL(n)}${est ? ' · ' + esc(est) : ''}">${est ? '⚠ ' : ''}${esc(n)}${lk ? `<span class="lk">${lk}</span>` : ''}</button>`;
    }).join('');
    const rl = o.rb ? roundLines(o.rb, k, d) : null;
    const rnd = rl ? `<div class="rnd" title="Weekend/holiday rounding">${rl.map(t => `<div>${esc(t)}</div>`).join('')}</div>` : '';
    h += `<div class="day ${wk ? 'wk' : ''}"><div class="dn"><span class="num">${d}</span><span class="tag">${esc(o.tags ? o.tags(d) : '')}</span></div>${chips}${rnd}</div>`;
  });
  return `<div class="cal">${h}</div>`;
}

// ---------- views ----------
function noDraft() { return `<div class="panel"><h2>${monthName(S.month)}</h2><p class="muted">No draft yet. ${isScheduler() ? 'Check the Inputs tab, then build it.' : 'The schedulers haven’t built it yet.'}</p>${isScheduler() ? '<button class="btn primary" id="fresh">Build the first draft</button>' : ''}</div>`; }
function viewSchedule() {
  const st = cur(); const dl = deadline(S.month);
  const banner = `<div class="deadline"><b>Requests for ${MONTHS_LONG[ym(S.month)[1] - 1]}</b><span>due ${dl.label}</span><span class="pill ${dl.days < 0 ? 'neutral' : dl.days <= 3 ? 'crit' : dl.days <= 7 ? 'warn' : 'good'}">${dl.days < 0 ? 'closed' : dl.days === 0 ? 'today' : dl.days + ' days left'}</span><span class="muted small">Late requests are best effort (S6).</span></div>`;
  if (!st.A) return banner + noDraft();
  const { ev, rb, est } = evaluateNow(); const k = S.month;
  const hard = ev.issues.filter(i => i.sev === 'hard');
  const softKeys = Object.entries(ev.br).filter(([kk]) => /^(S|F)/.test(kk));
  const picked = new Set(picksOf(k).map(p => p.day + '|' + p.name));
  const locked = (d, s, n) => isHolidayLock(k, d) ? 'holiday' : st.locks[d + '|' + s] !== undefined ? 'locked' : picked.has(d + '|' + n) ? 'picked' : (s === 'U' && n && [5, 'F'].includes(DATA.pgy[n])) ? 'proposed' : '';
  const estList = [...new Set(Object.values(est))];
  const [ky, km] = ym(k); const recs = []; Object.keys(rb).map(Number).sort((a, b) => a - b).forEach(d => { const r = rb[d]; if (recs.length && recs.at(-1).r === r) return; const w = E.dow(ky, km, d); if (r.weekend && w === 5 && rb[d + 1] === r) return; recs.push({ d, r }); });
  const recLabel = ({ d, r }) => { const ds = Object.keys(rb).map(Number).filter(x => rb[x] === r).sort((a, b) => a - b); const shown = r.weekend ? ds.filter(x => E.dow(ky, km, x) !== 5) : ds; const mo = MONTHS[km - 1]; return (shown.length > 1 ? `${mo} ${shown[0]}\u2013${shown.at(-1)}` : `${mo} ${shown[0]}`) + (r.holiday ? ' (holiday)' : (HOLNAMES[k] || {})[shown[0]] ? ' (holiday weekend)' : ''); };
  const BL = ['Trauma/EGS', 'ICU', 'GS1', 'GS2', 'Vasc/Thor', 'HPB/Transplant'];
  const holPanel = k === '2026-12' ? (() => { const { x, n } = trios(); return `<div class="panel"><h3>Holiday trios</h3><p class="small muted">HD3: the app pairs each Working list into two H2 trios. A scheduler or PGY-5 chief picks which starts.</p>
    <div class="kv small"><b>Dec 23, 25, 27</b><span>${x[0].slice().reverse().join(' / ')}</span><b>Dec 24, 26</b><span>${x[1].slice().reverse().join(' / ')}</span><b>Dec 30, Jan 1, 3</b><span>${n[0].slice().reverse().join(' / ')}</span><b>Dec 31, Jan 2</b><span>${n[1].slice().reverse().join(' / ')}</span></div>
    <div class="row" style="margin-top:10px"><button class="btn" id="swapX" ${canSwap() && st.status !== 'Published' ? '' : 'disabled'}>Swap Christmas start</button><button class="btn" id="swapN" ${canSwap() && st.status !== 'Published' ? '' : 'disabled'}>Swap New Year start</button></div></div>`; })() : k === '2027-01' ? `<div class="panel small"><h3>New Year carry-over</h3><p class="muted">Jan 1–3 are locked from the New Year trios set in December (HD3).</p></div>` : '';
  return `${banner}
  <div class="row"><h2>${monthName(k)} call schedule</h2><span class="pill ${st.status === 'Published' ? 'good' : 'neutral'}">${esc(st.status)}</span><span class="spacer"></span>
    <button class="btn" id="pdf" ${downloads && window.jspdf ? '' : 'disabled'} title="${downloads ? '' : 'Downloads aren’t available in this view'}">Download PDF</button>
    <button class="btn" id="regen" ${canEdit() ? '' : 'disabled'}>Regenerate around locks</button>
    <button class="btn primary" id="fresh" ${canEdit() ? '' : 'disabled'}>Generate fresh draft</button></div>
  ${!isScheduler() ? `<div class="banner">${S.role === 'Chief' ? 'PGY-5 chief' : S.role === 'Program Director' ? 'PD' : 'Resident'} view. The PGY-4 schedulers build this.${canSwap() ? ' You can approve like-for-like swaps: click a name.' : ''}${S.role === 'Chief' ? ' Enter your own call picks on the Inputs tab.' : ''}</div>` : ''}
  <div class="grid2">
    <div class="panel" style="padding:10px">
      <div class="legend" style="padding:4px 6px 10px"><span><i style="background:var(--lv-u)"></i>Upper (PGY-4/5, fellow)</span><span><i style="background:var(--lv-m)"></i>Mid (PGY-2/3)</span><span><i style="background:var(--lv-i)"></i>Intern</span><span>Shaded = Fri–Sun</span><span>⚠ = depends on an unconfirmed date</span><span>"proposed" = PGY-5/fellow date the app picked</span><span>Small print on Sat/Sun/holidays = rounding (V/T = Vasc/Thor, * = cross-cover)</span></div>
      ${calendarHTML(st.A, k, { click: canEdit() || canSwap(), locked, est, rb, tags: d => (HOLNAMES[k] || {})[d] || '' })}
      <h3 style="margin:16px 6px 6px">Weekend and holiday rounding blocks</h3>
      <p class="small muted" style="margin:0 6px 8px">Fri, Sat and Sun callers work that weekend (H9) and round first; on a weekday holiday, that day's callers round. Empty blocks get one resident from the service. * = cross-cover. Shown on Sat, Sun and holiday cells above and in the PDF.</p>
      <div class="tablewrap"><table><thead><tr><th>Days</th>${BL.map(b => `<th>${b}</th>`).join('')}</tr></thead><tbody>${recs.map(x => `<tr><td>${recLabel(x)}</td>${BL.map(b => `<td>${esc((x.r.blocks[b] || []).join(', ').replace(/ \(cross-cover\)/g, '*'))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    </div>
    <div style="display:grid;gap:14px">
      <div class="panel"><h3>Rule check</h3><ul class="issues">
        ${hard.length ? hard.map(i => `<li class="hard">${esc(i.msg)}</li>`).join('') : '<li class="ok">All ACGME and hard program rules (H1–H15) are met.</li>'}
        ${estList.map(t => `<li class="hard">⚠ ${esc(t)}. Confirm it on the Inputs tab before sending to the PD.</li>`).join('')}
        ${softKeys.map(([kk]) => `<li class="soft">${esc(RULE_LABEL[kk] || kk)}: ${softDetail(kk, ev)}</li>`).join('')}</ul></div>
      ${holPanel}
    </div>
  </div>`;
}
function softDetail(k, ev) {
  const st = ev.stats, P = CUR.P, list = f => Object.entries(st).filter(([n, s]) => !P.byName[n].excluded && f(n, s)).map(([n]) => n);
  if (k === 'F1') return Object.entries(st).filter(([n, s]) => !P.byName[n].excluded && (s.n < s.tmin || s.n > s.tmax)).map(([n, s]) => `${n} ${s.n} (target ${s.tmin === s.tmax ? s.tmin : s.tmin + '–' + s.tmax})`).join(', ') || 'met';
  if (k === 'S1') return list((n, s) => s.q2).map(n => `${n} ${st[n].q2}`).join(', ');
  if (k === 'F2') return list((n, s) => s.wTot && s.wOff === 1).join(', ') + ' have only one weekend off';
  if (k === 'S5') return list((n, s) => s.wTot && s.wOff === 0).join(', ') + ' have no weekend off';
  if (k === 'S7') return list((n, s) => s.b2b > 0).join(', ') + ' work back-to-back weekends (call or rounding)';
  if (k === 'S4') return list((n, s) => s.bookBroken).join(', ') + ': call on a weekend next to vacation';
  if (k === 'S3') return 'GS2 resident on call a Sunday or Monday night';
  if (k === 'S6') return requestMisses().join(', ') || 'none';
  if (k === 'S2') return 'someone is post-call on protected time';
  if (k === 'F3') return 'weekend + holiday load, year to date, is uneven inside a group (see Dashboard)';
  if (k === 'F4') return 'two-person call uneven across PGY-4s';
  return '';
}
function requestMisses() { const st = cur(), out = []; st.constraints.forEach(c => { if (c.type !== 'off' && c.type !== 'want') return; c.days.forEach(d => { const a = st.A && st.A[d - 1]; const hit = a && [a.U, a.M, a.I].includes(c.name); if ((c.type === 'off' && hit) || (c.type === 'want' && !hit)) out.push(`${c.name} ${MONTHS[ym(S.month)[1] - 1]} ${d}`); }); }); return out; }

function viewInputs() {
  const k = S.month, st = cur(), ed = isScheduler() && st.status !== 'Published';
  const ppl = Object.keys(st.inputs).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const L = S.people;
  return `<div class="row"><h2>${monthName(k)} inputs</h2><span class="muted small">Preloaded from the yearly schedule. The monthly schedule wins when they differ, so fix anything that changed here. Schedulers edit; PGY-5s and the fellow enter their own call picks (H10).</span></div>
  <div class="panel"><div class="tablewrap"><table><thead><tr><th>Name</th><th>Level</th><th>Rotation</th><th>Vacation days</th><th>Leave from</th><th>Leave to</th><th>Confirmed?</th><th>Call picks (PGY-5, fellow)</th></tr></thead><tbody>
  ${ppl.map(n => { const v = st.inputs[n], lv = L[n] || {}, pick = [5, 'F'].includes(DATA.pgy[n]); const pickEd = st.status !== 'Published' && (isScheduler() || S.role === 'Chief');
    return `<tr><td>${esc(n)}</td><td>${LEVEL(n)}</td>
    <td><select class="f" data-in="rotation" data-n="${esc(n)}" ${ed ? '' : 'disabled'} aria-label="${esc(n)} rotation">${ROTATIONS.map(r => `<option ${r === v.rotation ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td><input type="text" data-in="vac" data-n="${esc(n)}" value="${esc(v.vac)}" placeholder="e.g. 7-11" ${ed ? '' : 'disabled'} aria-label="${esc(n)} vacation days"></td>
    <td><input type="date" data-lv="leaveFrom" data-n="${esc(n)}" value="${esc(lv.leaveFrom || '')}" ${ed ? '' : 'disabled'} aria-label="${esc(n)} leave from"></td>
    <td><input type="date" data-lv="leaveTo" data-n="${esc(n)}" value="${esc(lv.leaveTo || '')}" ${ed ? '' : 'disabled'} aria-label="${esc(n)} leave to"></td>
    <td>${lv.leaveTo ? `<label class="row small"><input type="checkbox" data-lv="leaveConfirmed" data-n="${esc(n)}" ${lv.leaveConfirmed ? 'checked' : ''} ${ed ? '' : 'disabled'}> ${lv.leaveConfirmed ? 'yes' : '<span style="color:var(--crit)">estimate</span>'}</label>` : ''}</td>
    <td>${pick ? `<input type="text" data-in="picks" data-n="${esc(n)}" value="${esc(v.picks)}" placeholder="e.g. 4, 9, 15" ${pickEd ? '' : 'disabled'} aria-label="${esc(n)} call picks">` : ''}</td></tr>`; }).join('')}
  </tbody></table></div>
  <p class="small muted">Vacation days are that month's dates (Mon–Fri block calls; weekends next to it are protected by S4). Leave dates carry across months. Unconfirmed leave dates show ⚠ on every call they affect. Call picks lock that person into the upper slot on those days.</p>
  <div class="row"><button class="btn primary" id="inputsApply" ${isScheduler() && st.status !== 'Published' ? '' : 'disabled'}>Rebuild ${MONTHS_LONG[ym(k)[1] - 1]} with these inputs</button></div></div>`;
}
function order(n) { const p = DATA.pgy[n]; return p === 'F' ? 6 : 6 - p; }

function viewDashboard() {
  const st = cur(); if (!st.A) return noDraft();
  const { ev, P } = evaluateNow(); const S2 = ev.stats;
  const ppl = P.people.filter(p => !p.excluded).sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
  const hard = ev.issues.filter(i => i.sev === 'hard').length;
  const inT = ppl.filter(p => S2[p.name].n >= p.tmin && S2[p.name].n <= p.tmax).length;
  const q2 = ppl.reduce((a, p) => a + S2[p.name].q2, 0), two = st.A.filter(a => !a.M).length;
  const minW = Math.min(...ppl.map(p => S2[p.name].wOff));
  const upperAsk = ppl.filter(p => [4, 5, 'F'].includes(p.lvl)).reduce((a, p) => a + p.tmin, 0);
  const midCap = ppl.filter(p => p.lvl === 2 || p.lvl === 3).reduce((a, p) => a + p.tmax, 0);
  const improve = improvements(ev, P, ppl);
  return `<div class="row"><h2>${monthName(S.month)} dashboard</h2><span class="muted small">Live from the current draft. Year to date = Jul–Nov actual + any earlier drafts + this month.</span></div>
  <div class="tiles">
    <div class="tile ${hard ? 'crit' : 'good'}"><div class="v">${hard}</div><div class="l">Hard-rule breaks</div></div>
    <div class="tile ${inT === ppl.length ? 'good' : 'warn'}"><div class="v">${inT}/${ppl.length}</div><div class="l">Residents in call target</div></div>
    <div class="tile ${q2 > 8 ? 'warn' : 'good'}"><div class="v">${q2}</div><div class="l">Every-other-day calls</div></div>
    <div class="tile ${minW < 1 ? 'crit' : minW < 2 ? 'warn' : 'good'}"><div class="v">${minW}</div><div class="l">Fewest weekends off (anyone)</div></div>
    <div class="tile ${two > 3 ? 'warn' : 'good'}"><div class="v">${two}</div><div class="l">Two-person days</div></div>
  </div>
  <div class="grid2"><div class="panel"><h3>Per resident</h3><div class="tablewrap"><table><thead><tr><th>Name</th><th>Level</th><th>Rotation</th><th>Calls vs target</th><th class="n">Calls</th><th class="n">Wkday</th><th class="n">Fri</th><th class="n">Sat</th><th class="n">Sun</th><th class="n">Holiday</th><th class="n">Wknds off</th><th class="n">q2</th><th class="n">YTD calls</th><th class="n">YTD wknd</th><th class="n">Call hrs</th></tr></thead><tbody>
  ${ppl.map(p => { const s = S2[p.name], lo = p.tmin, hi = p.tmax, mx = 8, off = s.n < lo || s.n > hi;
    return `<tr><td>${esc(p.name)}</td><td>${LEVEL(p.name)}</td><td>${esc(p.rotation)}</td><td><div class="bar" aria-label="${s.n} calls, target ${lo}-${hi}"><div class="band" style="left:${lo / mx * 100}%;width:${Math.max(6, (hi - lo) / mx * 100)}%"></div><div class="dot" style="left:${Math.min(100, s.n / mx * 100)}%;background:${off ? 'var(--warn)' : 'var(--ink)'}"></div></div></td>
    <td class="n">${s.n}</td><td class="n">${s.n - s.fri - s.sat - s.sun}</td><td class="n">${s.fri}</td><td class="n">${s.sat}</td><td class="n">${s.sun}</td><td class="n">${s.hol}</td><td class="n">${s.wOff}/${s.wTot}</td><td class="n">${s.q2 || ''}</td><td class="n">${(p.ytd.calls || 0) + s.n}</td><td class="n">${(p.ytd.wk || 0) + s.wk}</td><td class="n">${s.n * S.rules.callHours}</td></tr>`; }).join('')}
  </tbody></table></div><p class="small muted">Call hours use the call-length setting (${S.rules.callHours} h, Rules tab). The 80-hour check needs rotation hours, which aren’t in the data yet.</p></div>
  <div style="display:grid;gap:14px"><div class="panel"><h3>Areas for improvement</h3><ul class="issues">${improve.length ? improve.map(t => `<li class="soft">${esc(t)}</li>`).join('') : '<li class="ok">Nothing stands out this month.</li>'}</ul></div>
  <div class="panel small"><h3>Do the targets fit the slots?</h3><div class="kv"><span>Upper-level slots</span><b class="num">${st.A.length}</b><span>Upper-level minimum targets</span><b class="num">${upperAsk}</b><span>Mid-level slots</span><b class="num">${st.A.length - two}</b><span>Mid-level maximum targets</span><b class="num">${midCap}</b></div>
  <p class="muted">${upperAsk > st.A.length ? `Targets ask for ${upperAsk - st.A.length} more upper-level calls than there are slots, so some upper levels land under target. ` : ''}${midCap < st.A.length ? `Mids can cover ${midCap} of ${st.A.length} days. A PGY-4 never fills the mid slot (H2), so the rest go to two-person call or a mid over target. ` : ''}</p></div></div></div>`;
}
function improvements(ev, P, ppl) {
  const st = ev.stats, out = [];
  ppl.forEach(p => { const s = st[p.name]; if (s.n < p.tmin) out.push(`${p.name}: ${p.tmin - s.n} under target (${s.n} of ${p.tmin}${p.tmax > p.tmin ? '–' + p.tmax : ''}).`); if (s.n > p.tmax) out.push(`${p.name}: ${s.n - p.tmax} over target.`); if (s.q2 >= 2) out.push(`${p.name}: ${s.q2} every-other-day calls.`); if (s.wTot && s.wOff < 2) out.push(`${p.name}: only ${s.wOff} weekend off.`); if (s.bookBroken) out.push(`${p.name}: call on a weekend next to vacation.`); });
  const groups = { Interns: ppl.filter(p => p.lvl === 1), 'Mid levels': ppl.filter(p => p.lvl === 2 || p.lvl === 3), 'PGY-5s': ppl.filter(p => p.lvl === 5) };
  Object.entries(groups).forEach(([g, ps]) => { if (ps.length < 2) return; const v = ps.map(p => ({ n: p.name, w: (p.ytd.wk || 0) + st[p.name].wk })).sort((a, b) => b.w - a.w); if (v[0].w - v.at(-1).w >= 4) out.push(`${g}: weekend load year to date runs from ${v.at(-1).w} (${v.at(-1).n}) to ${v[0].w} (${v[0].n}). Next month should favor ${v.at(-1).n}.`); });
  requestMisses().forEach(r => out.push(`Request missed: ${r}.`));
  return out;
}

function viewHistory() {
  const k = S.histMonth, [y, m] = ym(k);
  const actual = B.actualAssign(DATA, k); const bt = BT[m];
  const A = S.histView === 'engine' && bt ? bt.engineA.map(a => ({ U: a.U || null, M: a.M || null, I: a.I || null })) : actual;
  const hist = DATA.history[k]; const hol = B.HOLIDAYS[k] || [];
  const tags = d => { const x = hist[d - 1]; const t = []; if (hol.includes(d)) t.push('Holiday'); if (x && x.vac.length && S.histView === 'actual') t.push('Vac: ' + x.vac.join(', ')); return t.join(' · '); };
  const row = (label, f) => `<tr><td>${label}</td>${[7, 8, 9, 10, 11].map(i => `<td class="n">${f(BT[i].actual)}</td><td class="n" style="color:var(--good)">${f(BT[i].engine)}</td>`).join('')}</tr>`;
  const hardN = x => Object.values(x.hard).reduce((a, b) => a + b, 0);
  return `<div class="row"><h2>History</h2><span class="spacer"></span>${['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].map(h => `<button class="btn ${h === k ? 'primary' : ''}" data-hm="${h}">${MONTHS[+h.slice(5) - 1]}</button>`).join('')}</div>
  <div class="panel"><h3>Published schedules vs the engine, same inputs</h3>
    <p class="small muted">Each month was rebuilt with what the schedulers knew: that month's vacations, plus PGY-5, fellow and holiday dates locked as they actually happened. Scored against the approved rules.</p>
    <div class="tablewrap"><table><thead><tr><th></th>${[7, 8, 9, 10, 11].map(i => `<th class="n">${MONTHS[i - 1]} actual</th><th class="n">${MONTHS[i - 1]} engine</th>`).join('')}</tr></thead><tbody>
      ${row('Hard-rule breaks', hardN)}${row('Every-other-day calls', x => x.q2)}${row('Vacation bookends broken', x => x.bookendsBroken)}${row('Residents outside target', x => x.outTarget)}${row('Two-person days', x => x.two)}</tbody></table></div>
    <p class="small muted">Most "breaks" in the real schedules are rules written down this month (H15 sister services; H2, which rules out a PGY-4 in the mid slot), not mistakes. The engine uses more two-person days for the same reason.</p></div>
  <div class="panel" style="padding:10px"><div class="row" style="padding:4px 6px 10px"><h3>${MONTHS_LONG[m - 1]} ${y}</h3><span class="spacer"></span>
    <button class="btn ${S.histView === 'actual' ? 'primary' : ''}" data-hv="actual">Published schedule</button><button class="btn ${S.histView === 'engine' ? 'primary' : ''}" data-hv="engine">Engine version</button></div>
    ${calendarHTML(A, k, { click: false, tags })}
    ${S.histView === 'actual' && bt && bt.actualIssues.length ? `<details style="margin-top:10px"><summary class="small">Rule breaks in the published ${MONTHS_LONG[m - 1]} schedule (${bt.actualIssues.length})</summary><ul class="issues">${bt.actualIssues.map(i => `<li class="hard">${esc(i)}</li>`).join('')}</ul></details>` : ''}</div>`;
}

function viewNotes() {
  const st = cur(), roster = Object.keys(st.inputs), mn = MONTHS_LONG[ym(S.month)[1] - 1];
  return `<div class="row"><h2>Notes for Claude · ${mn}</h2><span class="muted small">Write requests in plain English. Claude turns each into a rule, a scheduler accepts it, then the app rebuilds. The schedule never needs notes to be built.</span></div>
  <div class="grid2"><div class="panel"><label for="notes" class="small muted">Notes (requests come in by text; paste them here)</label>
    <textarea id="notes">${esc(st.notesText)}</textarea>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="interpret" ${sample ? '' : 'disabled'}>Interpret with Claude</button><span class="small muted">${sample ? 'Each note becomes a proposed rule below. Nothing changes until a scheduler accepts it.' : 'Claude isn’t available in this view. Add rules by hand on the right.'}</span></div>
    <div style="margin-top:12px">${proposalsHTML()}</div></div>
  <div style="display:grid;gap:14px"><div class="panel"><h3>Accepted rules for ${mn}</h3>
    ${st.constraints.length ? `<ul class="issues">${st.constraints.map((c, i) => `<li class="ok">${esc(describe(c))} ${isScheduler() ? `<button class="btn" data-rm="${i}" style="float:right;padding:1px 8px">Remove</button>` : ''}</li>`).join('')}</ul>` : '<p class="small muted">None yet.</p>'}
    <div class="row" style="margin-top:10px"><button class="btn primary" id="applyNotes" ${canEdit() && st.constraints.length ? '' : 'disabled'}>Rebuild with these</button></div></div>
  <div class="panel small"><h3>Add a rule by hand</h3><div class="kv">
    <label for="mType">Type</label><select id="mType" class="f"><option value="off">Day off request</option><option value="want">Wants call</option><option value="block">Unavailable (firm)</option><option value="protected">Protected event (no post-call)</option><option value="colorectal">Big colorectal day</option></select>
    <label for="mName">Resident</label><select id="mName" class="f">${roster.map(n => `<option>${n}</option>`).join('')}</select>
    <label for="mDays">${mn} days</label><input id="mDays" type="text" placeholder="e.g. 11-13 or 16"><label for="mWhy">Reason</label><input id="mWhy" type="text" placeholder="optional"></div>
    <div class="row" style="margin-top:10px"><button class="btn" id="addManual" ${isScheduler() ? '' : 'disabled'}>Add rule</button></div></div></div></div>`;
}
function describe(c) { const mo = MONTHS[ym(S.month)[1] - 1]; const days = c.days.map(d => mo + ' ' + d).join(', '); const t = { off: 'off (best effort, S6)', want: 'wants call (best effort)', block: 'unavailable (firm)', protected: 'protected: not post-call (S2)', colorectal: 'big colorectal day: GS2 resident not post-call (S3)' }[c.type]; return `${c.type === 'colorectal' ? 'GS2' : c.name}: ${days} ${t}${c.reason ? ' — ' + c.reason : ''}`; }
function proposalsHTML() { if (!S.proposals.length) return ''; return `<h3 style="margin-bottom:6px">Claude's reading</h3><ul class="issues">${S.proposals.map((c, i) => `<li class="${c.problem ? 'hard' : 'soft'}">${esc(describe(c))}${c.problem ? ` <b>— ${esc(c.problem)}</b>` : ''}<span style="float:right;display:flex;gap:6px">${c.problem || !isScheduler() ? '' : `<button class="btn" data-acc="${i}" style="padding:1px 8px">Accept</button>`}<button class="btn" data-rej="${i}" style="padding:1px 8px">Reject</button></span></li>`).join('')}</ul>`; }
async function interpret() {
  const st = cur(); const txt = $('#notes').value.trim(); if (!txt) return; st.notesText = txt;
  const [y, m] = ym(S.month); const roster = Object.entries(st.inputs).map(([n, r]) => `${n} (${LEVEL(n)}, ${r.rotation})`).join('; ');
  const prompt = `You convert residency call-schedule notes into structured rules. Month: ${MONTHS_LONG[m - 1]} ${y} (day 1 is a ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][E.dow(y, m, 1)]}; ${ndays(S.month)} days). Roster: ${roster}. Nicknames: ${DATA.nicknames || 'none'}.
Rule types: "off" = asks not to be on call those days (best effort); "want" = asks to be on call those days; "block" = firmly unavailable (leave, away, sick); "protected" = an exam or event: the person must not be post-call that day (Step 3, boards, ABSITE, ATLS); "colorectal" = big colorectal case day (name = the GS2 resident).
If a weekend is mentioned as off, include Fri, Sat and Sun. Use day numbers in this month only.
Return JSON only: {"rules":[{"type":"off|want|block|protected|colorectal","name":"<exact roster name>","days":[<ints>],"reason":"<short>"}]}.
Notes:
${txt}`;
  const btn = $('#interpret'); btn.disabled = true; btn.textContent = 'Reading notes…';
  try { const { data: v, error } = await sb.functions.invoke('interpret-notes', { body: { prompt } }); if (error) throw error; if (v && v.error) throw new Error(v.error); S.proposals = ((v && v.rules) || []).map(r => { const c = { type: r.type, name: r.name, days: (r.days || []).filter(d => d >= 1 && d <= ndays(S.month)), reason: r.reason || '' }; if (!['off', 'want', 'block', 'protected', 'colorectal'].includes(c.type)) c.problem = 'unknown rule type'; else if (c.type !== 'colorectal' && !st.inputs[c.name]) c.problem = 'name not on this month’s roster'; else if (!c.days.length) c.problem = 'no dates in this month'; return c; }); if (!S.proposals.length) toast('Claude found no rules in those notes.'); }
  catch (e) { toast('Claude couldn’t read the notes: ' + ((e && e.message) || 'error')); }
  btn.disabled = false; btn.textContent = 'Interpret with Claude'; render();
}

function viewRules() {
  const R = S.rules, t = R.targets, dis = isScheduler() ? '' : 'disabled';
  const tr = (k, label) => `<tr><td>${label}</td><td><input type="number" min="0" max="12" data-t="${k}" data-i="0" value="${t[k][0]}" ${dis} aria-label="${label} minimum"></td><td><input type="number" min="0" max="12" data-t="${k}" data-i="1" value="${t[k][1]}" ${dis} aria-label="${label} maximum"></td></tr>`;
  const p4 = Object.keys(DATA.pgy).filter(n => DATA.pgy[n] === 4);
  return `<div class="row"><h2>Rules</h2><span class="muted small">Rules v1.3 (v1.1 PD approved Nov 5; v1.3 weekend changes pending PD sign-off). Every number here is a setting each year's schedulers can change without rebuilding the app.</span></div>
  <div class="grid2"><div class="panel"><h3>Call targets per month (F1)</h3>
    <table style="max-width:420px"><thead><tr><th>Group</th><th>Min</th><th>Max</th></tr></thead><tbody>${tr(1, 'Interns')}${tr(2, 'PGY-2')}${tr(3, 'PGY-3')}${tr(4, 'PGY-4')}${tr(5, 'PGY-5')}${tr('F', 'Fellow')}</tbody></table>
    <h3 style="margin-top:16px">Limits</h3><div class="kv"><label for="rCap">Fellow cap (H7)</label><input id="rCap" type="number" min="0" max="10" value="${R.fellowCap}" ${dis}><label for="rQ2">Max calls in a row, every other day (H14)</label><input id="rQ2" type="number" min="1" max="6" value="${R.maxQ2Run}" ${dis}><label for="rHrs">Call length for hour estimates</label><input id="rHrs" type="number" min="12" max="36" value="${R.callHours}" ${dis}></div></div>
  <div style="display:grid;gap:14px">
    <div class="panel small"><h3>Two-person call exceptions (H3)</h3><p class="muted">Not eligible for two-person call until a PGY-5 chief removes them.</p>
      ${p4.map(n => `<label class="row"><input type="checkbox" data-ntp="${esc(n)}" ${(R.noTwoPerson || []).includes(n) ? 'checked' : ''} ${S.role === 'Chief' ? '' : 'disabled'}> ${esc(n)}</label>`).join('')}</div>
    <div class="panel small"><h3>Open question</h3><label class="row" style="align-items:flex-start;gap:8px"><input type="checkbox" id="rSS" ${R.sameServiceBlocked ? 'checked' : ''} ${dis}><span><b>Two residents on the same service never share a call day.</b> Not in the rules (H15 covers sister services only). Happened 6 times Jul–Nov.</span></label></div>
    <div class="panel small"><h3>Always on</h3><p class="muted">ACGME limits, H1–H15 (a PGY-4 never fills the mid slot), holiday trios, vacation and leave, excluded rotations (Richardson, Peds, Transplant), Fri/Sat/Sun callers work that weekend's rounding (H9). Rounding counts as a worked weekend (S5, F2, S7: avoid back-to-back weekends). Fill-in rounders rotate (cross-cover first if the service's resident worked last weekend); one resident covers HPB and Transplant, two when feasible (W2); the SICU fellow takes call only and never rounds (W3).</p>
      <button class="btn primary" id="rulesApply" ${canEdit() ? '' : 'disabled'}>Rebuild with these rules</button></div></div></div>`;
}

function viewApproval() {
  const st = cur(), steps = ['Draft', 'Scheduler review', 'PD review', 'Published'], idx = Math.max(0, steps.indexOf(st.status)), r = S.role;
  let actions = '';
  if (r === 'Scheduler' && ['Draft', 'Scheduler review'].includes(st.status) && st.A) actions = `<button class="btn" id="saveVer">Save version</button><button class="btn primary" id="toPD">Send to the PD</button>`;
  if (r === 'Program Director' && st.status === 'PD review') actions = `<input type="text" id="pdNote" placeholder="Comment (optional)" style="min-width:220px"><button class="btn" id="sendBack">Send back to schedulers</button><button class="btn primary" id="approve">Approve and publish</button>`;
  if (r === 'Scheduler' && st.status === 'Published') actions = `<button class="btn" id="revise">Start a revised version</button>`;
  return `<div class="row"><h2>Approval · ${monthName(S.month)}</h2><span class="muted small">The PGY-4 schedulers build, the PD approves, then it goes out. Every version is kept. Swaps after publishing: a scheduler or PGY-5 chief approves (SW3).</span></div>
  <div class="stepper">${steps.map((s, i) => `<div class="step ${i < idx ? 'done' : i === idx ? 'now' : ''}"><b>${s}</b><span class="small muted">${['Schedulers edit and rebuild', 'Schedulers check the dashboard', 'PD approves or sends back', 'Shared as the calendar'][i]}</span></div>`).join('')}</div>
  <div class="panel"><div class="row">${actions || `<span class="muted small">Nothing for the ${esc(roleName())} to do at this stage.</span>`}<span class="spacer"></span><button class="btn" id="copyTxt" ${st.A ? '' : 'disabled'}>Copy schedule as text</button></div></div>
  <div class="grid2"><div class="panel"><h3>Versions</h3>${st.versions.length ? `<div class="tablewrap"><table><thead><tr><th>Version</th><th>Saved</th><th>Status</th><th class="n">Changed days</th><th></th></tr></thead><tbody>${st.versions.slice().reverse().map(v => `<tr><td>v${v.n}</td><td>${new Date(v.at).toLocaleString()}</td><td>${esc(v.status)}</td><td class="n">${v.changed == null ? '—' : v.changed}</td><td>${canEdit() ? `<button class="btn" data-restore="${v.n}" style="padding:1px 8px">Restore</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">No saved versions yet.</p>'}</div>
  <div class="panel"><h3>Activity</h3><ul class="issues">${st.log.slice(-14).reverse().map(l => `<li class="ok small"><b>${esc(l.role)}</b> ${esc(l.text)} <span class="muted">· ${new Date(l.at).toLocaleString()}</span></li>`).join('') || '<li class="ok small">No activity yet.</li>'}</ul></div></div>`;
}
function saveVersion(status) { const st = cur(); const prev = st.versions.at(-1); const A = st.A.map(a => [a.U, a.M, a.I]); const changed = prev ? A.filter((a, i) => a.join() !== (prev.A[i] || []).join()).length : null; const n = (prev ? prev.n : 0) + 1; st.versions.push({ n, at: new Date().toISOString(), status, A, changed }); const k = S.month; const ins = () => sb.from('versions').insert({ month_key: k, n, status, schedule: A, changed, created_by: me.id }).then(() => {}); if (existing.has(k)) ins(); else setTimeout(ins, 1500); }
function scheduleText() { const k = S.month; return `${monthName(k)} call schedule (${cur().status})\n` + cur().A.map((a, i) => `${dateLabel(k, i + 1)}: ${[a.U, a.M, a.I].filter(Boolean).join(' / ')}${a.M ? '' : ' (two-person)'}${(HOLNAMES[k] || {})[i + 1] ? ' [' + HOLNAMES[k][i + 1] + ']' : ''}`).join('\n'); }

// ---------- PDF ----------
async function downloadPDF() {
  const k = S.month, st = cur(), [y, m] = ym(k);
  try {
    const rb = E.roundingBlocks(E.prepare(buildInput()), st.A, B.HOLIDAYS[k] || []);
    const { jsPDF } = window.jspdf; const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
    const W = 792, H = 612, mx = 28, top = 70, cw = (W - 2 * mx) / 7;
    const first = E.dow(y, m, 1), rows = Math.ceil((first + st.A.length) / 7), ch = (H - top - 40) / rows;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text(`${monthName(k)} — General Surgery Call`, mx, 36);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(`${st.status}${st.status === 'Published' ? ' (approved by the PD)' : ''} · Upper / Mid / Intern · generated ${new Date().toLocaleDateString()}`, mx, 52);
    DOW.forEach((d, i) => { doc.setFont('helvetica', 'bold'); doc.text(d.toUpperCase(), mx + i * cw + 4, top - 6); });
    for (let r = 0; r < rows; r++) for (let c = 0; c < 7; c++) {
      const x = mx + c * cw, yy = top + r * ch, d = r * 7 + c - first + 1;
      doc.setDrawColor(190); doc.rect(x, yy, cw, ch);
      if (d < 1 || d > st.A.length) continue;
      const a = st.A[d - 1]; doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(String(d), x + 4, yy + 12);
      const hn = (HOLNAMES[k] || {})[d]; if (hn) { doc.setFontSize(7); doc.setTextColor(160, 25, 79); doc.text(hn.toUpperCase(), x + cw - 4, yy + 11, { align: 'right' }); doc.setTextColor(0); }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
      const lines = roundLines(rb, k, d), showR = !!lines;
      const nameGap = showR ? 10.5 : 12; [a.U, a.M || '(two-person)', a.I].forEach((n, i) => doc.text(String(n || ''), x + 6, yy + 25 + i * nameGap));
      if (showR) {
        const top0 = yy + 25 + 3 * nameGap, lh = Math.min(6.6, (yy + ch - 3 - top0) / lines.length);
        doc.setFontSize(Math.max(4.6, lh * 0.88)); doc.setTextColor(70);
        lines.forEach((t, i) => doc.text(doc.splitTextToSize(t, cw - 10)[0], x + 6, top0 + i * lh));
        doc.setTextColor(0);
      }
    }
    doc.setFontSize(7); doc.setTextColor(90); doc.text('Weekend/holiday rounding in small print (T/EGS, ICU, GS1, GS2, V/T = Vasc/Thor, HPB/Tx). * = cross-cover.', mx, H - 14); doc.setTextColor(0);
    const blob = doc.output('blob'); const name = `${k}-01-monthly-call-schedule-${MONTHS_LONG[m - 1].toLowerCase()}${st.status === 'Published' ? '' : '-draft'}.pdf`;
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); toast('Downloaded ' + name);
  } catch (e) { toast('Download didn’t go through: ' + ((e && (e.message || e.code)) || 'declined')); }
}

// ---------- drawer ----------
function openDrawer(d, s) {
  const k = S.month, st = cur(); const { P } = CUR; const a = st.A[d - 1]; const curN = a[s];
  const hol = isHolidayLock(k, d); const used = [a.U, a.M, a.I].filter(Boolean);
  let replaceHTML = '';
  if (canEdit()) {
    const lvlOK = p => s === 'I' ? p.lvl === 1 : s === 'M' ? (p.lvl === 2 || p.lvl === 3) : ([4, 5, 'F'].includes(p.lvl) || p.lvl === 3);
    const cands = P.people.filter(lvlOK).map(p => {
      let why = '';
      if (p.excluded) why = p.rotation === 'Leave' ? 'on leave' : `on ${p.rotation} (not in pool)`;
      else if (p.out.has(d)) why = 'vacation, leave or unavailable';
      else if (used.includes(p.name) && p.name !== curN) why = 'already on this day';
      else { const near = [d - 1, d + 1].filter(x => x >= 1 && x <= st.A.length && [st.A[x - 1].U, st.A[x - 1].M, st.A[x - 1].I].includes(p.name)); if (near.length) why = `on call ${MONTHS[ym(k)[1] - 1]} ${near[0]} (back-to-back)`; }
      if (!why && s === 'U' && p.lvl === 3 && k < '2027-01') why = 'PGY-3 upper call starts Jan (H6)';
      return { p, why, n: CUR.ev.stats[p.name] ? CUR.ev.stats[p.name].n : 0 };
    }).sort((x, y) => (!!x.why - !!y.why) || x.n - y.n);
    const fs = [5, 6].includes(E.dow(...ym(k), d)), nt = (S.rules.noTwoPerson || []).includes(a.U), p4 = DATA.pgy[a.U] === 4;
    replaceHTML = `<h3>Replace</h3><p class="small muted">Greyed names are unavailable that day; the rule check catches anything else.</p><div style="display:grid;gap:6px">${cands.map(c => `<button class="opt ${c.p.name === curN ? 'cur' : ''}" data-pick="${esc(c.p.name)}" ${c.why || hol ? 'disabled' : ''}><span>${esc(c.p.name)} <span class="why">${LEVEL(c.p.name)} · ${esc(c.p.rotation)}</span></span><span class="why">${c.why ? esc(c.why) : c.n + ' calls'}</span></button>`).join('')}
    ${s === 'M' && !hol ? `<button class="opt" data-pick="" ${fs || nt || !p4 ? 'disabled' : ''}><span>Make it two-person call</span><span class="why">${fs ? 'not on Fri/Sat (H4)' : !p4 ? 'needs a PGY-4 upper level' : nt ? a.U + ' not eligible (H3)' : 'PGY-4 + intern'}</span></button>` : ''}</div>
    <label class="row small"><input type="checkbox" id="dLock" ${st.locks[d + '|' + s] !== undefined ? 'checked' : ''} ${hol ? 'disabled' : ''}> Lock this cell so rebuilding keeps it</label>`;
  }
  let swapHTML = '';
  if (canSwap() && curN && !hol) {
    const type = dayType(k, d); const opts = [];
    st.A.forEach((b, i) => { const d2 = i + 1; if (d2 === d || isHolidayLock(k, d2) || dayType(k, d2) !== type || !b[s] || b[s] === curN) return;
      const trial = st.A.map(x => Object.assign({}, x)); trial[d - 1][s] = b[s]; trial[i][s] = curN;
      const ev = E.evaluate(E.prepare(buildInput()), trial); if (!ev.hard) opts.push({ d2, other: b[s] }); });
    swapHTML = `<h3>Swap (like for like: ${type})</h3><p class="small muted">Only swaps that keep every hard rule are listed (SW1, SW2). ${st.status === 'Published' ? 'This becomes a revised version.' : ''}</p>
      <div style="display:grid;gap:6px">${opts.length ? opts.map(o => `<button class="opt" data-swap="${o.d2}"><span>${esc(curN)} ⇄ ${esc(o.other)}</span><span class="why">${dateLabel(k, o.d2)}</span></button>`).join('') : '<p class="small muted">No legal like-for-like swap this month.</p>'}</div>`;
  }
  $('#drawer').innerHTML = `<div class="row"><h3>${dateLabel(k, d)} · ${SLOTNAME[s]}</h3><span class="spacer"></span><button class="btn" id="dClose">Close</button></div>
    ${hol ? '<div class="banner">Holiday call is locked to the Working list (HD1). Use "Swap start" for the trios.</div>' : ''}
    <p class="small">Now: <b>${esc(curN || (s === 'M' ? 'two-person call' : 'empty'))}</b>${CUR.est[d + s] ? ` <span style="color:var(--crit)">⚠ ${esc(CUR.est[d + s])}</span>` : ''}</p>${replaceHTML}${swapHTML}`;
  $('#drawer').classList.add('open');
  $('#dClose').onclick = () => $('#drawer').classList.remove('open');
  $('#drawer').querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { const v = b.dataset.pick || null; st.A[d - 1][s] = v; st.locks[d + '|' + s] = v; logEvent(k, `Set ${dateLabel(k, d)} ${SLOTNAME[s].toLowerCase()} to ${v || 'two-person call'}`); save(); $('#drawer').classList.remove('open'); render(); });
  $('#drawer').querySelectorAll('[data-swap]').forEach(b => b.onclick = () => { const d2 = +b.dataset.swap, other = st.A[d2 - 1][s]; st.A[d2 - 1][s] = curN; st.A[d - 1][s] = other; st.locks[d + '|' + s] = other; st.locks[d2 + '|' + s] = curN; logEvent(k, `Swap approved: ${curN} ${dateLabel(k, d)} ⇄ ${other} ${dateLabel(k, d2)}`); if (st.status === 'Published') saveVersion('Revised (swap)'); save(); $('#drawer').classList.remove('open'); render(); toast('Swap done and logged.'); });
  const lk = $('#dLock'); if (lk) lk.onchange = e => { if (e.target.checked) st.locks[d + '|' + s] = st.A[d - 1][s]; else delete st.locks[d + '|' + s]; save(); render(); };
}


// ---------- people (admins) ----------
let PEOPLE = null, peopleMsg = '';
async function loadPeople() { const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'list' } }); if (error || (data && data.error)) { peopleMsg = 'Could not load accounts: ' + ((data && data.error) || error.message); PEOPLE = []; } else PEOPLE = data.users; if (route() === 'people') render(); }
function viewPeople() {
  if (!S.isAdmin) return '<div class="panel">Only admins manage accounts.</div>';
  if (PEOPLE === null) { loadPeople(); return '<div class="panel">Loading accounts…</div>'; }
  const ROLES = [['scheduler', 'Scheduler (PGY-4)'], ['chief', 'PGY-5 chief'], ['pd', 'Program director'], ['resident', 'Resident']];
  return `<div class="row"><h2>People</h2><span class="muted small">Admins add accounts and pick each username. People set their own password from the link they get.</span></div>
  ${peopleMsg ? `<div class="banner">${esc(peopleMsg)}</div>` : ''}
  <div class="grid2"><div class="panel"><div class="tablewrap"><table><thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Admin</th><th>Active</th><th></th></tr></thead><tbody>
  ${PEOPLE.map(p => `<tr><td>${esc(p.display_name)}</td><td>${esc(p.username)}</td><td class="small">${esc(p.email || '')}${p.confirmed ? '' : ' <span class="pill warn">no password yet</span>'}</td>
    <td><select class="f" data-prole="${p.id}" ${p.id === me.id ? 'disabled' : ''} aria-label="Role for ${esc(p.username)}">${ROLES.map(([v, l]) => `<option value="${v}" ${v === p.role ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
    <td><input type="checkbox" data-padmin="${p.id}" ${p.is_admin ? 'checked' : ''} ${p.id === me.id ? 'disabled' : ''} aria-label="Admin"></td>
    <td><input type="checkbox" data-pactive="${p.id}" ${p.active ? 'checked' : ''} ${p.id === me.id ? 'disabled' : ''} aria-label="Active"></td>
    <td><button class="btn" data-plink="${p.id}" style="padding:1px 8px">${p.confirmed ? 'Reset link' : 'Setup link'}</button></td></tr>`).join('')}
  </tbody></table></div><p class="small muted">Unchecking Active blocks sign-in but keeps the person's history. You can't change your own role, admin or active status, so nobody locks themselves out.</p></div>
  <div class="panel"><h3>Add a person</h3><div class="kv small">
    <label for="nName">Full name</label><input id="nName" type="text" placeholder="Jane Doe">
    <label for="nUser">Username</label><input id="nUser" type="text" placeholder="tsmith (lowercase)">
    <label for="nEmail">Email</label><input id="nEmail" type="text" placeholder="for the password link">
    <label for="nRole">Role</label><select id="nRole" class="f">${ROLES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    <label for="nAdmin">Admin</label><input id="nAdmin" type="checkbox"></div>
    <label class="row small" style="margin-top:8px"><input type="checkbox" id="nSend" checked> Email them the set-password link (uncheck to copy the link and text it instead)</label>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="nAdd">Add person</button></div>
    <div id="linkOut" class="small" style="margin-top:8px;word-break:break-all"></div></div></div>`;
}
async function peopleAction(body, okMsg) { const { data, error } = await sb.functions.invoke('admin-users', { body }); if (error || (data && data.error)) { toast((data && data.error) || error.message); return null; } if (okMsg) toast(okMsg); return data; }
function wirePeople() {
  document.querySelectorAll('[data-prole]').forEach(el => el.onchange = async () => { await peopleAction({ action: 'update', id: el.dataset.prole, role: el.value }, 'Role updated.'); loadPeople(); });
  document.querySelectorAll('[data-padmin]').forEach(el => el.onchange = async () => { await peopleAction({ action: 'update', id: el.dataset.padmin, is_admin: el.checked }, 'Admin updated.'); loadPeople(); });
  document.querySelectorAll('[data-pactive]').forEach(el => el.onchange = async () => { await peopleAction({ action: 'update', id: el.dataset.pactive, active: el.checked }, el.checked ? 'Account turned back on.' : 'Account turned off.'); loadPeople(); });
  document.querySelectorAll('[data-plink]').forEach(el => el.onclick = async () => { const d = await peopleAction({ action: 'link', id: el.dataset.plink }); if (d && d.link) showLink(d.link); });
  const add = $('#nAdd'); if (add) add.onclick = async () => {
    const body = { action: 'create', display_name: $('#nName').value.trim(), username: $('#nUser').value.trim().toLowerCase(), email: $('#nEmail').value.trim(), role: $('#nRole').value, is_admin: $('#nAdmin').checked, send_email: $('#nSend').checked };
    if (!body.display_name || !body.username || !body.email) return toast('Name, username and email are all needed.');
    const d = await peopleAction(body, body.send_email ? 'Added. They’ll get an email to set their password.' : 'Added. Copy the link below and send it to them.');
    if (d) { PEOPLE = null; render(); if (d.link) setTimeout(() => showLink(d.link), 400); }
  };
}
function showLink(link) { const o = $('#linkOut'); if (!o) return toast('Link ready; open People to copy it.'); o.innerHTML = `<b>One-time link</b> (expires in 24 h): <span>${esc(link)}</span> <button class="btn" id="cpLink" style="padding:1px 8px">Copy</button>`; $('#cpLink').onclick = () => navigator.clipboard.writeText(link).then(() => toast('Copied.'), () => toast('Copy blocked; select the link instead.')); }

// ---------- router ----------
const VIEWS = { people: viewPeople, schedule: viewSchedule, inputs: viewInputs, dashboard: viewDashboard, history: viewHistory, notes: viewNotes, rules: viewRules, approval: viewApproval };
function route() { const h = location.hash.slice(1); return VIEWS[h] ? h : 'schedule'; }
function render() {
  const r = route();
  const pv = $('#previewNote'); if (pv) pv.hidden = !(S.isAdmin && roleKey(S.role) !== S.realRole);
  document.querySelectorAll('nav.tabs a').forEach(a => a.setAttribute('aria-current', a.getAttribute('href') === '#' + r ? 'page' : 'false'));
  if (cur().A && !['schedule', 'dashboard'].includes(r)) evaluateNow();
  $('#main').innerHTML = VIEWS[r](); wire();
  if (r === 'schedule' && !cur().A && isScheduler() && !cur()._auto) { cur()._auto = true; generate(false); }
}
function wire() {
  const st = cur(), k = S.month;
  wirePeople();
  const on = (sel, f) => { const el = $(sel); if (el) el.onclick = f; };
  on('#fresh', () => generate(false)); on('#regen', () => generate(true)); on('#pdf', downloadPDF);
  on('#swapX', () => { S.trioSwap.xmas = !S.trioSwap.xmas; logEvent(k, 'Swapped which Christmas trio starts'); generate(true); });
  on('#swapN', () => { S.trioSwap.ny = !S.trioSwap.ny; logEvent(k, 'Swapped which New Year trio starts (January follows)'); generate(true); });
  document.querySelectorAll('.cal .chip:not([disabled])').forEach(b => b.onclick = () => openDrawer(+b.dataset.d, b.dataset.s));
  document.querySelectorAll('[data-hm]').forEach(b => b.onclick = () => { S.histMonth = b.dataset.hm; render(); });
  document.querySelectorAll('[data-hv]').forEach(b => b.onclick = () => { S.histView = b.dataset.hv; render(); });
  document.querySelectorAll('[data-in]').forEach(i => i.onchange = () => { st.inputs[i.dataset.n][i.dataset.in] = i.value.trim(); logEvent(k, `Input: ${i.dataset.n} ${i.dataset.in} = ${i.value.trim() || '(none)'}`); save(); });
  document.querySelectorAll('[data-lv]').forEach(i => i.onchange = () => { const n = i.dataset.n, f = i.dataset.lv; S.people[n] = S.people[n] || {}; S.people[n][f] = i.type === 'checkbox' ? i.checked : i.value; if (f !== 'leaveConfirmed') S.people[n].leaveConfirmed = false; logEvent(k, `Leave: ${n} ${f} = ${i.type === 'checkbox' ? i.checked : i.value}`); save(); render(); });
  on('#inputsApply', () => { location.hash = 'schedule'; generate(true); });
  on('#interpret', interpret);
  const notes = $('#notes'); if (notes) notes.oninput = () => { st.notesText = notes.value; };
  document.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => { const c = S.proposals.splice(+b.dataset.acc, 1)[0]; delete c.problem; st.constraints.push(c); logEvent(k, 'Accepted rule: ' + describe(c)); save(); render(); });
  document.querySelectorAll('[data-rej]').forEach(b => b.onclick = () => { S.proposals.splice(+b.dataset.rej, 1); render(); });
  document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { const c = st.constraints.splice(+b.dataset.rm, 1)[0]; logEvent(k, 'Removed rule: ' + describe(c)); save(); render(); });
  on('#applyNotes', () => { location.hash = 'schedule'; generate(true); });
  on('#addManual', () => { const c = { type: $('#mType').value, name: $('#mName').value, days: parseDays($('#mDays').value, ndays(k)), reason: $('#mWhy').value.trim() }; if (!c.days.length) return toast('Add at least one day, like 16 or 11-13.'); st.constraints.push(c); logEvent(k, 'Added rule: ' + describe(c)); save(); render(); });
  document.querySelectorAll('[data-t]').forEach(i => i.onchange = () => { S.rules.targets[i.dataset.t][+i.dataset.i] = Math.max(0, +i.value || 0); save(); });
  const num = (id, kk) => { const el = $(id); if (el) el.onchange = () => { S.rules[kk] = +el.value; save(); }; };
  num('#rCap', 'fellowCap'); num('#rQ2', 'maxQ2Run'); num('#rHrs', 'callHours');
  const ss = $('#rSS'); if (ss) ss.onchange = () => { S.rules.sameServiceBlocked = ss.checked; save(); };
  document.querySelectorAll('[data-ntp]').forEach(i => i.onchange = () => { const n = i.dataset.ntp; S.rules.noTwoPerson = (S.rules.noTwoPerson || []).filter(x => x !== n); if (i.checked) S.rules.noTwoPerson.push(n); logEvent(k, `${n} ${i.checked ? 'not eligible' : 'eligible again'} for two-person call`); save(); });
  on('#rulesApply', () => { logEvent(k, 'Changed rule settings'); location.hash = 'schedule'; generate(true); });
  on('#saveVer', () => { saveVersion(st.status); logEvent(k, 'Saved a version'); save(); render(); toast('Version saved.'); });
  on('#toPD', () => { const ev = CUR.ev; const hard = ev.issues.filter(i => i.sev === 'hard').length; const est = Object.keys(CUR.est).length; if (hard) return toast(`Fix the ${hard} hard-rule break(s) first.`); if (est && !confirmInline()) return; st.status = 'PD review'; saveVersion('Sent to PD'); logEvent(k, 'Sent to the PD for approval' + (est ? ` with ${est} call(s) on unconfirmed dates` : '')); save(); render(); });
  on('#approve', () => { st.status = 'Published'; saveVersion('Approved'); logEvent(k, 'Approved and published' + ($('#pdNote').value ? ': ' + $('#pdNote').value : '')); save(); render(); });
  on('#sendBack', () => { st.status = 'Scheduler review'; logEvent(k, 'Sent back' + ($('#pdNote').value ? ': ' + $('#pdNote').value : '')); save(); render(); });
  on('#revise', () => { st.status = 'Scheduler review'; logEvent(k, 'Started a revised version'); save(); render(); });
  on('#copyTxt', async () => { try { await navigator.clipboard.writeText(scheduleText()); toast('Copied. Paste it into a text or email.'); } catch (e) { toast('Copy was blocked here.'); } });
  document.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => { const v = st.versions.find(v => v.n === +b.dataset.restore); if (v) { st.A = v.A.map(([U, M, I]) => ({ U, M, I })); logEvent(k, 'Restored v' + v.n); save(); render(); } });
}
let estConfirmArmed = false;
function confirmInline() { if (estConfirmArmed) { estConfirmArmed = false; return true; } estConfirmArmed = true; toast('Some calls depend on unconfirmed dates (⚠). Click Send again to send anyway.'); setTimeout(() => estConfirmArmed = false, 6000); return false; }
const rs = $('#roleSel'); if (rs) { rs.value = S.role; rs.onchange = e => { S.role = e.target.value; render(); }; }
$('#monthSel').innerHTML = KEYS.map(k => `<option value="${k}">${monthName(k)}</option>`).join('');
$('#monthSel').onchange = e => { S.month = e.target.value; S.proposals = []; render(); };
window.addEventListener('hashchange', () => { $('#drawer').classList.remove('open'); render(); });
render();
connect();
window.__schedRender = render;
};
