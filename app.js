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
const RULE_LABEL = { S1: 'S1 every-other-day call', S2: 'S2 protected time', S3: 'S3 colorectal day', S4: 'S4 vacation bookends', S5: 'S5 weekend off', S6: 'S6 requests', S7: 'S7 back-to-back weekends', W3: 'W3 ICU alternation', H16: 'H16 partner away', W6: 'W6 T/EGS alternation', F1: 'F1 call targets', F2: 'F2 second weekend off', F3: 'F3 weekend balance (YTD)', F4: 'F4 two-person balance' };
const ym = k => k.split('-').map(Number);
const ndays = k => { const [y, m] = ym(k); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const iso = (k, d) => k + '-' + String(d).padStart(2, '0');

// ---------- state ----------
const S = {
  month: '2026-12', role: ({ scheduler: 'Scheduler', chief: 'Chief', pd: 'Program Director', resident: 'Resident' })[CTX.profile.role], realRole: CTX.profile.role, isAdmin: CTX.profile.is_admin, histMonth: '2026-11', histView: 'actual', proposals: [],
  rules: { pgy4MidSlot: false, sameServiceBlocked: false, noTwoPerson: [], fellowCap: 4, maxQ2Run: 3, callHours: 24, targets: { 1: [5, 6], 2: [5, 6], 3: [5, 6], 4: [6, 7], 5: [6, 6], F: [4, 4] } },
  trioSwap: { xmas: false, ny: false },
  people: {}, // leave dates by name (stored in the database, not here)
  M: {}, requests: [], notes: {}, swaps: [], acct: {}
};
function blankMonth(k) {
  const inputs = {};
  Object.entries(DATA.rotations[k]).forEach(([n, r]) => { inputs[n] = { rotation: r.rotation, vac: r.vac_txt || '', picks: '' }; });
  return { A: null, locks: {}, flags: {}, rndEdit: {}, constraints: [], status: 'Draft', versions: [], log: [], inputs,
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
  inp.rndOverride = st.rndEdit || {};
  cons(k).forEach(c => {
    if (c.source === 'pd') { // requests the PD adds are always honored
      if (c.type === 'off') { const p = inp.people.find(p => p.name === c.name); if (p) p.blockDays = (p.blockDays || []).concat(c.days); return; }
      if (c.type === 'want') { const lv = DATA.pgy[c.name], slot = lv === 1 ? 'I' : (lv === 2 || lv === 3) ? 'M' : 'U'; c.days.forEach(d => { if (!inp.locks.some(l => l.day === d && l.slot === slot)) inp.locks.push({ day: d, slot, name: c.name }); }); return; }
    }
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
  CUR = { inp, P, ev, rb: getRB(S.month, P), est: estimated(st.A) };
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
    st.A = best.A.map(a => ({ U: a.U || null, M: a.M || null, I: a.I || null })); st.stale = false;
    st.flags = keepLocks ? Object.fromEntries(Object.entries(st.flags || {}).filter(([kk]) => st.locks[kk] !== undefined)) : {};
    logEvent(k, keepLocks ? 'Regenerated around locked cells' : 'Generated a fresh draft');
    save(k); render(); toast(best.ev.hard ? 'Done, but some hard rules could not be met. See the list.' : 'Done. All hard rules met.');
  }, 30);
}

// ---------- persistence (Supabase) ----------
function monthData(k) { const st = S.M[k]; return { A: st.A ? st.A.map(a => [a.U, a.M, a.I]) : null, locks: st.locks, flags: st.flags || {}, rndEdit: st.rndEdit || {}, inputs: st.inputs, rnd: st.A ? packRB(E.roundingBlocks(E.prepare(buildInput(k)), st.A, B.HOLIDAYS[k] || [])) : null }; } // requests and notes live in their own tables
// Rounding is worked out by admins (who can see leave dates) and saved with the month; residents draw it from the saved copy.
function packRB(rb) { const seen = new Map(); Object.keys(rb).map(Number).sort((a, b) => a - b).forEach(d => { const r = rb[d]; if (!seen.has(r)) seen.set(r, { days: [], blocks: r.blocks, weekend: !!r.weekend, holiday: !!r.holiday }); seen.get(r).days.push(d); }); return [...seen.values()]; }
function unpackRB(list) { const rb = {}; (list || []).forEach(x => { const r = { blocks: x.blocks, weekend: x.weekend, holiday: x.holiday }; x.days.forEach(d => rb[d] = r); }); return rb; }
function getRB(k, P) { const st = S.M[k]; if (!S.isAdmin && st.rnd) return unpackRB(st.rnd); return E.roundingBlocks(P, st.A, B.HOLIDAYS[k] || []); }
function adoptMonth(row) {
  const k = row.key; if (!S.M[k]) return; const st = S.M[k], d = row.data || {};
  if (d.A) st.A = d.A.map(([U, M, I]) => ({ U, M, I }));
  ['locks', 'inputs', 'rnd', 'flags', 'rndEdit'].forEach(x => { if (d[x] !== undefined) st[x] = d[x]; });
  st.status = row.status || st.status; existing.add(k);
}
function adoptSettings(r) { if (!r) return; if (r.rules && Object.keys(r.rules).length) S.rules = Object.assign(S.rules, r.rules); if (r.trio_swap) S.trioSwap = r.trio_swap; if (r.people && Object.keys(r.people).length) S.people = r.people; }
const timers = {}; let settingsTimer = null, pendingOwn = 0;
function save(k) {
  k = k || S.month; if (applyingRemote) return; clearTimeout(timers[k]);
  timers[k] = setTimeout(async () => {
    const st = S.M[k]; pendingOwn++;
    const body = S.realRole === 'pd' ? { status: st.status } : { status: st.status, data: monthData(k) }; // the PD only moves the status
    const q = existing.has(k) ? sb.from('months').update(body).eq('key', k) : sb.from('months').insert(Object.assign({ key: k }, body));
    const { error } = await q; setTimeout(() => pendingOwn--, 1500);
    if (error) { toast('Not saved: ' + (/Approval step not allowed/.test(error.message) ? 'your account’s role can’t take that approval step. (Preview mode only changes the screen, not your permissions.)' : /row-level|permission/i.test(error.message) ? 'your role can’t make this change.' : error.message));
      const { data: row } = await sb.from('months').select('*').eq('key', k).maybeSingle(); if (row) { applyingRemote = true; adoptMonth(row); applyingRemote = false; render(); } }
    else existing.add(k);
  }, 600);
  saveSettings();
}
function saveSettings() {
  if (!['scheduler', 'chief', 'pd'].includes(S.realRole)) return;
  clearTimeout(settingsTimer); settingsTimer = setTimeout(async () => { pendingOwn++; const { error } = await sb.from('settings').update({ rules: S.rules, trio_swap: S.trioSwap, people: S.people }).eq('id', 1); setTimeout(() => pendingOwn--, 1500); if (error) toast('Settings not saved: ' + error.message); }, 700);
}
function logEvent(k, text) { S.M[k].log.push({ at: new Date().toISOString(), role: roleName(), text: (me.name ? me.name + ': ' : '') + text }); sb.from('activity_log').insert({ user_id: me.id, month_key: k, text: `${me.name} (${roleName()}): ${text}` }).then(() => {}); }
const roleKey = r => ({ Scheduler: 'scheduler', Chief: 'chief', 'Program Director': 'pd', Resident: 'resident' })[r];
const roleName = () => ({ Scheduler: 'Scheduler', Chief: 'PGY-5 chief', 'Program Director': 'PD', Resident: 'Resident' }[S.role]);
function connect() {
  sb.channel('board').on('postgres_changes', { event: '*', schema: 'public', table: 'months' }, p => { if (pendingOwn || !p.new) return; applyingRemote = true; adoptMonth(p.new); applyingRemote = false; render(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, p => { if (pendingOwn || !p.new) return; adoptSettings(p.new); render(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, () => { loadRequests().then(render); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'swaps' }, () => { loadSwaps().then(render); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'published' }, () => { if (!S.isAdmin) loadPublished().then(pub => { render(); publishAlerts(pub); }); }).subscribe();
}
(CTX.months || []).forEach(adoptMonth);
adoptSettings(CTX.settings);
(CTX.versions || []).forEach(v => { const st = S.M[v.month_key]; if (st) st.versions.push({ n: v.n, at: v.created_at, status: v.status, A: v.schedule, changed: v.changed }); });
(CTX.logs || []).slice().reverse().forEach(l => { const st = S.M[l.month_key]; if (st) st.log.push({ at: l.at, role: '', text: l.text }); });
if (['scheduler', 'chief'].includes(S.realRole) && !existing.has('2026-12') && S.M['2026-12'].A) save('2026-12');
// backfill the saved rounding copy residents read from
if (['scheduler', 'chief'].includes(S.realRole)) Object.keys(S.M).forEach(k => { const st = S.M[k]; if (existing.has(k) && st.A && !st.rnd && st.status !== 'PD review') save(k); });

// roster = everyone on this year's current/upcoming monthly schedules (people who left, like a former fellow, drop off)
const ROSTER_NAMES = () => [...new Set(KEYS.flatMap(k => Object.keys(DATA.rotations[k] || {})))].sort((x, y) => order(x) - order(y) || x.localeCompare(y));
// ---------- requests (own table; residents only ever load their own) ----------
const cons = k => S.requests.filter(r => r.month_key === k && r.status === 'accepted').map(r => ({ id: r.id, type: r.type, name: r.resident, days: r.days, reason: r.note, source: r.source, by: r.decided_by || r.created_by, at: r.decided_at || r.created_at }));
const canDecide = () => isScheduler() || S.role === 'Program Director';
const whoName = id => (S.names && S.names[id]) || 'someone';
const whenTxt = t => t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
async function loadNames() { const { data } = await sb.from('profiles').select('id,display_name,roster_name,active'); S.names = Object.fromEntries((data || []).map(p => [p.id, p.display_name])); S.acct = Object.fromEntries((data || []).filter(p => p.roster_name && p.active).map(p => [p.roster_name, p.id])); }
async function loadSwaps() { const { data } = await sb.from('swaps').select('*').order('created_at'); S.swaps = data || []; }
async function loadRequests() { const { data, error } = await sb.from('requests').select('*').order('created_at'); if (!error) S.requests = data || []; }
async function loadNotes() { if (!adminView() && !S.isAdmin) return; const { data } = await sb.from('month_notes').select('*'); (data || []).forEach(r => S.notes[r.key] = r.notes_text); }
let notesTimer = null;
function saveNotes(k) { clearTimeout(notesTimer); notesTimer = setTimeout(() => sb.from('month_notes').upsert({ key: k, notes_text: S.notes[k] || '', updated_at: new Date().toISOString() }).then(({ error }) => { if (error) toast('Notes not saved: ' + error.message); }), 600); }
async function addRequest(row) { const { data, error } = await sb.from('requests').insert(row).select().single(); if (error) { toast('Not saved: ' + error.message); return null; } if (!S.requests.some(r => r.id === data.id)) S.requests.push(data); return data; }
async function setRequest(id, patch) { const { error } = await sb.from('requests').update(patch).eq('id', id); if (error) return toast('Not saved: ' + error.message); Object.assign(S.requests.find(r => r.id === id) || {}, patch); }
async function dropRequest(id) { const { error } = await sb.from('requests').delete().eq('id', id); if (error) return toast('Not removed: ' + error.message); S.requests = S.requests.filter(r => r.id !== id); }
const reqDeadline = k => { const [y, m] = ym(k); return new Date(y, m - 2, 15, 23, 59); }; // mid-month before the schedule month
const isLate = r => new Date(r.created_at) > reqDeadline(r.month_key);

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Instant tooltips for anything with title/data-tip (native titles are slow or never show in some browsers)
(() => { const box = () => { let t = $('#tipbox'); if (!t) { t = document.createElement('div'); t.id = 'tipbox'; document.body.appendChild(t); } return t; };
  document.addEventListener('mouseover', e => { const el = e.target.closest && e.target.closest('[title],[data-tip]'); const t = box(); if (!el) { t.style.display = 'none'; return; }
    if (el.hasAttribute('title')) { if (el.title) el.dataset.tip = el.title; el.removeAttribute('title'); } if (!el.dataset.tip) { t.style.display = 'none'; return; }
    t.textContent = el.dataset.tip; t.style.display = 'block'; const r = el.getBoundingClientRect();
    t.style.left = Math.max(8, Math.min(r.left, innerWidth - t.offsetWidth - 8)) + 'px'; t.style.top = (r.bottom + 6 + t.offsetHeight > innerHeight ? r.top - t.offsetHeight - 6 : r.bottom + 6) + 'px'; });
  document.addEventListener('scroll', () => { const t = $('#tipbox'); if (t) t.style.display = 'none'; }, true);
  // click outside the side drawer closes it (modals already close on an outside click)
  document.addEventListener('mousedown', e => { const d = $('#drawer'); if (!d || !d.classList.contains('open') || d.contains(e.target) || e.target.closest('.modal-ov,#tipbox,#toast')) return; d.classList.remove('open'); });
})();
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); el.onclick = () => el.classList.remove('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), Math.min(15000, 6000 + String(t).length * 60)); }
const adminView = () => S.isAdmin && S.role !== 'Resident'; // schedulers, chiefs and the PD are admins; 'Preview as Resident' hides admin screens
const isScheduler = () => S.role === 'Scheduler' || S.role === 'Chief'; // chiefs can do everything the PGY-4 schedulers do
const canEdit = () => isScheduler() && !['Published', 'PD review', 'Approved'].includes(cur().status);
const canSwap = () => S.role === 'Scheduler' || S.role === 'Chief';
const monthName = k => { const [y, m] = ym(k); return `${MONTHS_LONG[m - 1]} ${y}`; };
const dateLabel = (k, d) => { const [y, m] = ym(k); return `${DOW[E.dow(y, m, d)]} ${MONTHS[m - 1]} ${d}`; };
const dayType = (k, d) => { const [y, m] = ym(k); const w = E.dow(y, m, d); return w === 5 ? 'Friday' : (w === 6 || w === 0) ? 'weekend' : 'weekday'; };
function deadline(k) { const [y, m] = ym(k); const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; const dl = new Date(py, pm - 1, 15); const days = Math.ceil((dl - new Date(new Date().toDateString())) / 864e5); return { label: `${MONTHS[pm - 1]} 15`, days }; }

// ---------- calendar ----------
const RABBR = { 'Trauma/EGS': 'T/EGS', ICU: 'ICU', GS1: 'GS1', GS2: 'GS2', 'Vasc/Thor': 'V/T', 'HPB/Transplant': 'HPB/Tx' };
// Same rule as the PDF: rounding prints on Sat, Sun and holiday cells.
const RBC = {};
function rbFor(k) {
  if (DATA.history[k] && !(S.M[k] && S.M[k].A)) { const rb = {}; DATA.history[k].forEach(x => { if (x.round && Object.values(x.round).some(v => v && v.length)) rb[x.d] = { blocks: x.round, holiday: (B.HOLIDAYS[k] || []).includes(x.d) }; }); return rb; } // as published
  try { const st = S.M[k], A = st && st.A ? st.A : null; if (!A) return null;
    const sig = JSON.stringify(A) + JSON.stringify(st && st.rndEdit || {}) + (st && st.rnd ? JSON.stringify(st.rnd) : '');
    if (RBC[k] && RBC[k].sig === sig) return RBC[k].rb;
    const [y, m] = ym(k), P = E.prepare(st ? buildInput(k) : B.buildInput(dataWithDrafts(k), y, m, 'draft'));
    const rb = st ? getRB(k, P) : E.roundingBlocks(P, A, B.HOLIDAYS[k] || []); RBC[k] = { sig, rb }; return rb; } catch (e) { return null; }
}
function roundLines(rb, k, d) {
  const [y, m] = ym(k), w = E.dow(y, m, d), rec = rb && rb[d];
  if (!rec || !(w === 6 || w === 0 || rec.holiday || (HOLNAMES[k] || {})[d])) return null;
  return Object.entries(rec.blocks).map(([b, v]) => `${RABBR[b] || b}: ${v.map(n => n.replace(' (cross-cover)', '*')).join('/') || '-'}`);
}
// "My calls only": just the days you're on call or rounding (remembered on this device)
let MINE = false; try { MINE = localStorage.getItem('gs-mine') === '1'; } catch (e) {}
function calendarHTML(A, k, o) {
  const [y, m] = ym(k), first = E.dow(y, m, 1); let h = o.mine ? '' : DOW.map(d => `<div class="hd">${d}</div>`).join('');
  // spill-over days from the months before/after so every box is filled; the previous month is read-only,
  // the next month's days can be edited (clicking jumps to that month)
  const adjKey = dlt => { const dt = new Date(y, m - 1 + dlt, 1); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`; };
  const adjDay = (k2, d, edit) => {
    const [y2, m2] = ym(k2), w = E.dow(y2, m2, d), wk = w === 0 || w === 6 || w === 5, st2 = S.M[k2];
    let trio = st2 && st2.A && st2.A[d - 1] ? [['U', st2.A[d - 1].U], ['M', st2.A[d - 1].M], ['I', st2.A[d - 1].I]] : null;
    if (!trio && DATA.history[k2]) { const x = DATA.history[k2].find(r => r.d === d); if (x) trio = x.call.map(n => [DATA.pgy[n] === 1 ? 'I' : [2, 3].includes(DATA.pgy[n]) ? 'M' : 'U', n]); }
    const can = edit && o.click && st2 && st2.A;
    const chips = (trio || []).map(([sl, n]) => n ? `<button class="chip ${sl}" data-k="${k2}" data-d="${d}" data-s="${sl}" ${can ? '' : 'disabled'} title="${esc(n)} · ${LEVEL(n)} · ${esc(monthName(k2))}${can ? ' (click to edit there)' : ''}">${esc(n)}</button>` : (sl === 'M' ? `<button class="chip empty" data-k="${k2}" data-d="${d}" data-s="M" ${can ? '' : 'disabled'}>two-person call</button>` : '')).join('');
    const tag = (HOLNAMES[k2] || {})[d] || '';
    const rl = roundLines(rbFor(k2), k2, d);
    return `<div class="day adj ${wk ? 'wk' : ''}"><div class="dn"><span class="num">${MONTHS[m2 - 1]} ${d}</span><span class="tag">${esc(tag)}</span></div>${chips}${rl ? `<div class="rnd">${rl.map(t => `<div>${esc(t)}</div>`).join('')}</div>` : ''}</div>`; };
  if (!o.mine) { const pk = adjKey(-1), pn = new Date(y, m - 1, 0).getDate(); for (let i = 0; i < first; i++) h += adjDay(pk, pn - first + 1 + i, false); }
  A.forEach((a, i) => {
    const d = i + 1, w = E.dow(y, m, d), wk = w === 0 || w === 6 || w === 5;
    const chips = ['U', 'M', 'I'].map(s => {
      const n = a[s], key = d + s, est = o.est && o.est[key], lk = o.locked ? o.locked(d, s, n) : '';
      if (!n) return `<button class="chip empty" data-d="${d}" data-s="${s}" ${o.click ? '' : 'disabled'}>${s === 'M' ? 'two-person call' : 'no ' + SLOTNAME[s].toLowerCase()}</button>`;
      const fl = o.flags && o.flags[d + '|' + s], ch = o.changed && o.changed[d + '|' + s];
      return `<button class="chip ${s} ${est ? 'est' : ''} ${fl ? 'bad' : ''}" data-d="${d}" data-s="${s}" ${o.click || (o.own && n === o.own) ? '' : 'disabled'} title="${esc(n)} · ${LEVEL(n)}${lk === 'holiday' ? ' · locked: holiday list' : lk === 'locked' ? ' · locked' : ''}${est ? ' · ' + esc(est) : ''}${fl ? ' · breaks a rule: ' + esc(fl) : ''}${ch ? ' · ' + esc(ch) : ''}">${fl ? '⛔ ' : ''}${ch ? '<b class="chg">↻</b> ' : ''}${est ? '⚠ ' : ''}${esc(n)}${lk ? `<span class="lk">${lk === 'holiday' || lk === 'locked' ? '🔒' : lk}</span>` : ''}</button>`;
    }).join('');
    const rl = o.rb ? roundLines(o.rb, k, d) : null;
    if (o.mine && ![a.U, a.M, a.I].includes(o.mine) && !(rl && rl.some(t => new RegExp('\\b' + o.mine + '\\b').test(t)))) return;
    const rnd = rl ? `<div class="rnd" title="Weekend/holiday rounding">${rl.map(t => `<div>${esc(t)}</div>`).join('')}</div>` : '';
    h += `<div class="day ${wk ? 'wk' : ''}"><div class="dn"><span class="num"><span class="wd">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][E.dow(...ym(k), d)]} </span>${d}</span><span class="tag">${esc(o.tags ? o.tags(d) : '')}</span></div>${chips}${rnd}</div>`;
  });
  if (!o.mine) { const last = E.dow(y, m, A.length), nk = adjKey(1); for (let i = 1; i <= 6 - last; i++) h += adjDay(nk, i, true); }
  if (o.mine && !h) return `<div class="panel small">You're not on call or rounding in ${esc(monthName(k))}.</div>`;
  return `<div class="cal ${o.mine ? 'list' : ''}">${h}</div>`;
}

// ---------- views ----------
function setRnd(ref, b, list) { const st = cur(); st.rndEdit = st.rndEdit || {}; st.rndEdit[ref] = Object.assign({}, st.rndEdit[ref], { [b]: list }); logEvent(S.month, `Rounding edit: ${dateLabel(S.month, ref)} ${b} → ${list.join(', ') || 'nobody'}`); save(); render(); }
// why a person shouldn't be on a weekend team (shown red; still allowed)
function rndIssue(n, rec, ref, b, recs) {
  const P = CUR.P, p = P.byName[n.replace(' (cross-cover)', '')]; if (!p) return '';
  const name = p.name, days = Object.keys(CUR.rb).map(Number).filter(d => CUR.rb[d] === rec);
  if (days.some(d => p.vacAll.has(d) || (p.leaveDays || []).includes(d))) return 'away that weekend';
  if (Object.entries(rec.blocks).some(([bb, v]) => bb !== b && v.some(m => m.replace(' (cross-cover)', '') === name))) return 'already on another team';
  if (rec.weekend && p.lvl === 'F' && !rec.fellowWeek) return 'not the fellow’s ICU weekend (W3)';
  if (rec.weekend && p.rotation === 'ICU' && p.lvl !== 'F' && rec.fellowWeek) return 'the fellow’s ICU weekend (W3)';
  if ((rec.tegsOff || []).includes(name)) return 'their T/EGS off weekend (W6)';
  const i = recs.findIndex(x => x.r === rec), nb = [recs[i - 1], recs[i + 1]].filter(x => x && x.r.weekend && rec.weekend && Math.abs(x.d - ref) === 7);
  if (nb.some(x => x.r.workers && x.r.workers.has(name))) return 'back-to-back weekend (S7)';
  return '';
}
function roundingTable(recs, recLabel, BL, k) {
  const st = cur(), ed = canEdit() && adminView(), roster = ROSTER_NAMES().filter(n => CUR.P.byName[n] && !CUR.P.byName[n].excluded || CUR.P.byName[n] && ['Transplant'].includes(CUR.P.byName[n].rotation));
  return `<div class="tablewrap"><table class="rtable"><thead><tr><th>Days</th>${BL.map(b => `<th>${b}</th>`).join('')}${ed ? '<th></th>' : ''}</tr></thead><tbody>${recs.map(x => { const ref = x.d, edits = (st.rndEdit || {})[ref] || {};
    return `<tr><td>${recLabel(x)}</td>${BL.map(b => { const v = x.r.blocks[b] || [];
      const tags = v.map((n, i) => { const why = adminView() ? rndIssue(n, x.r, ref, b, recs) : ''; return `<span class="rtag ${why ? 'bad' : ''}" ${why ? `data-tip="${esc(why)}"` : ''}>${esc(n.replace(' (cross-cover)', '*'))}${why ? `<button class="why" data-why="${esc(why)}" aria-label="Why is this red?">⛔</button>` : ''}${ed ? `<button class="rx" data-rx="${ref}|${b}|${i}" aria-label="Remove ${esc(n)}">✕</button>` : ''}</span>`; }).join(' ');
      const add = ed ? `<select class="radd" data-ra="${ref}|${b}" aria-label="Add to ${b}"><option value="">+</option>${roster.filter(n => !v.some(m => m.replace(' (cross-cover)', '') === n)).map(n => { const why = rndIssue(n, x.r, ref, b, recs); return `<option value="${esc(n)}">${esc(n)}${why ? ' — ' + esc(why) : ''}</option>`; }).join('')}</select>` : '';
      return `<td class="${edits[b] ? 'edited' : ''}">${tags || '<span class="muted">—</span>'} ${add}</td>`; }).join('')}${ed ? `<td>${Object.keys(edits).length ? `<button class="btn" data-rreset="${ref}" style="padding:1px 8px" title="Undo your edits for this weekend">Reset</button>` : ''}</td>` : ''}</tr>`; }).join('')}</tbody></table></div>`;
}
// Rule check popups
function showRuleCheck(id) {
  const { ev, P } = CUR, k = S.month;
  if (id[0] === 'h') { const it = ev.issues.filter(i => i.sev === 'hard')[+id.slice(1)]; if (!it) return; const rule = RULE_BY_ID[it.k] || {};
    const name = ROSTER_NAMES().find(n => new RegExp('\\b' + n + '\\b').test(it.msg)); const days = [...it.msg.matchAll(/(?:day|Day|[A-Z][a-z]{2})\s+(\d{1,2})\b/g)].map(m => +m[1]).filter(d => d >= 1 && d <= P.nd);
    const p = name && P.byName[name];
    if (p) return showImprove({ t: it.msg, name, calls: ev.stats[name] ? ev.stats[name].calls : [], vac: [...p.vacAll], flag: days, note: `${rule.id || it.k} ${rule.title || ''}: ${rule.plain || ''}` });
    return modal(`<h3 style="margin-top:0">${esc(it.msg)}</h3><p class="small"><b>${esc(rule.id || it.k)} ${esc(rule.title || '')}.</b> ${esc(rule.plain || '')}</p><p class="small muted">${esc(rule.computer || '')}</p><button class="btn" data-close>Close</button>`);
  }
  const kk = id.slice(1), rule = RULE_BY_ID[kk] || {}, all = improvements(ev, P, P.people.filter(p => !p.excluded));
  const match = { F1: /target/, S1: /every-other-day/, S5: /weekend off/, F2: /weekend off/, S7: /back-to-back/, S4: /next to vacation/, S6: /Request missed/ }[kk];
  const items = match ? all.filter(x => x.name && match.test(x.t)) : [];
  IMPROVE = items;
  modal(`<div class="row"><h3 style="margin:0">${esc(RULE_LABEL[kk] || kk)}</h3><span class="spacer"></span><button class="btn" data-close>Close</button></div>
    <p class="small"><b>${esc(rule.title || '')}.</b> ${esc(rule.plain || '')}</p><p class="small muted">What the app checks: ${esc(rule.computer || '')}</p>
    ${items.length ? `<p class="small muted">Click a name for their calendar.</p><ul class="issues">${items.map((x, i) => `<li class="soft"><button class="linkish" data-imp2="${i}">${esc(x.t)}</button></li>`).join('')}</ul>` : `<p class="small">${softDetail(kk, ev)}</p>`}`,
    (ov, close) => ov.querySelectorAll('[data-imp2]').forEach(b => b.onclick = () => { close(); showImprove(items[+b.dataset.imp2]); }));
}
function noDraft() { if (!adminView()) return `<div class="panel"><h2>${monthName(S.month)}</h2><p>No schedule has been published yet. You'll get an alert here when it is. Past months are on the History tab.</p></div>`;
  return noDraft2(); }
function noDraft2() { return `<div class="panel"><h2>${monthName(S.month)}</h2><p class="muted">No draft yet. ${isScheduler() ? 'Check the Inputs tab, then build it.' : 'The schedulers haven’t built it yet.'}</p>${isScheduler() ? '<button class="btn primary" id="fresh">Build the first draft</button>' : ''}</div>`; }
function viewSchedule() {
  const st = cur(); const dl = deadline(S.month);
  const banner = `<div class="deadline"><b>Requests for ${MONTHS_LONG[ym(S.month)[1] - 1]}</b><span>due ${dl.label}</span><span class="pill ${dl.days < 0 ? 'neutral' : dl.days <= 3 ? 'crit' : dl.days <= 7 ? 'warn' : 'good'}">${dl.days < 0 ? 'closed' : dl.days === 0 ? 'today' : dl.days + ' days left'}</span><span class="muted small">Late requests are best effort (S6).</span></div>`;
  if (!st.A) return banner + noDraft();
  const { ev, rb, est } = evaluateNow(); const k = S.month;
  const hard = ev.issues.filter(i => i.sev === 'hard');
  const softKeys = Object.entries(ev.br).filter(([kk]) => /^(S|F)/.test(kk));
  const picked = new Set(picksOf(k).map(p => p.day + '|' + p.name));
  const locked = (d, s, n) => !adminView() ? '' : isHolidayLock(k, d) ? 'holiday' : st.locks[d + '|' + s] !== undefined ? 'locked' : picked.has(d + '|' + n) ? 'picked' : (s === 'U' && n && [5, 'F'].includes(DATA.pgy[n])) ? 'proposed' : '';
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
    ${adminView() ? `<button class="btn" id="regen" ${canEdit() ? '' : 'disabled'}>Regenerate around locks</button>
    <button class="btn primary" id="fresh" ${canEdit() ? '' : 'disabled'}>Generate fresh draft</button>` : ''}</div>
  ${!isScheduler() && adminView() ? `<div class="banner">${S.role === 'Program Director' ? 'PD' : 'Admin'} view. The schedulers and chiefs build this.${canSwap() ? ' You can approve like-for-like swaps: click a name.' : ''}${S.role === 'Chief' ? ' Enter your own call picks on the Inputs tab.' : ''}</div>` : ''}
  <div class="grid2">
    <div class="panel" style="padding:10px">
      <div class="legend" style="padding:4px 6px 10px"><span><i style="background:var(--lv-u)"></i>Upper (PGY-4/5, fellow)</span><span><i style="background:var(--lv-m)"></i>Mid (PGY-2/3)</span><span><i style="background:var(--lv-i)"></i>Intern</span><span>Shaded = Fri–Sun</span>${adminView() ? '<span>⚠ = depends on an unconfirmed date</span><span>"proposed" = PGY-5/fellow date the app picked</span>' : ''}<span>Small print on Sat/Sun/holidays = rounding (V/T = Vasc/Thor, * = cross-cover)</span></div>
      ${MY_NAME ? `<label class="mineToggle ${MINE ? 'on' : ''}"><input type="checkbox" id="mineT" ${MINE ? 'checked' : ''}> 👤 My calls only${MINE ? ` <span class="muted">· ${st.A.filter(a => [a.U, a.M, a.I].includes(MY_NAME)).length} calls</span>` : ''}</label>` : ''}
      ${calendarHTML(st.A, k, { mine: MINE && MY_NAME ? MY_NAME : null, click: adminView() && (canEdit() || canSwap()), own: !adminView() && st.status === 'Published' ? MY_NAME : null, locked, est, rb, flags: adminView() ? st.flags : null, tags: d => (HOLNAMES[k] || {})[d] || '' })}
      <h3 style="margin:16px 6px 6px">Weekend and holiday rounding</h3>
      <p class="small muted" style="margin:0 6px 8px">${canEdit() ? 'The app fills these in (W1–W6). Click ✕ to take someone off a team or “+” to add someone. Your edits stay through rebuilds; red means the edit breaks a rule. ' : ''}* = cross-cover. Shown on Sat, Sun and holiday cells above and in the PDF.</p>
      ${roundingTable(recs, recLabel, BL, k)}
    </div>
    <div style="display:grid;gap:14px">
      ${adminView() ? `<div class="panel"><h3>Rule check</h3>${hard.length || softKeys.length ? '<p class="small muted">Click one for the dates and what the rule means.</p>' : ''}<ul class="issues">
        ${st.stale ? '<li class="soft">Rules changed since the last build. Click “Regenerate around locks” to apply them.</li>' : ''}
        ${hard.length ? hard.map((i, n) => `<li class="hard"><button class="linkish" data-rc="h${n}">${esc(i.msg)}</button></li>`).join('') : '<li class="ok">All ACGME and hard program rules are met.</li>'}
        ${estList.map(t => `<li class="hard">⚠ ${esc(t)}. Confirm it on the Inputs tab before sending to the PD.</li>`).join('')}
        ${softKeys.map(([kk]) => `<li class="soft"><button class="linkish" data-rc="s${kk}">${esc(RULE_LABEL[kk] || kk)}: ${softDetail(kk, ev)}</button></li>`).join('')}</ul></div>
      ${holPanel}` : ''}
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
  if (k === 'S3') return 'GS2 resident on call a Sunday or Tuesday night (before a big colorectal day)';
  if (k === 'S6') return requestMisses().join(', ') || 'none';
  if (k === 'S2') return 'someone is post-call on protected time';
  if (k === 'F3') return 'weekend + holiday load, year to date, is uneven inside a group (see Stats)';
  if (k === 'F4') return 'two-person call uneven across PGY-4s';
  return '';
}
function requestMisses() { const st = cur(), out = []; cons(S.month).forEach(c => { if (c.type !== 'off' && c.type !== 'want') return; c.days.forEach(d => { const a = st.A && st.A[d - 1]; const hit = a && [a.U, a.M, a.I].includes(c.name); if ((c.type === 'off' && hit) || (c.type === 'want' && !hit)) out.push(`${c.name} ${MONTHS[ym(S.month)[1] - 1]} ${d}`); }); }); return out; }

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
    <td><input type="${lv.leaveFrom ? 'date' : 'text'}" onfocus="this.type='date'" onblur="if(!this.value)this.type='text'" data-lv="leaveFrom" data-n="${esc(n)}" value="${esc(lv.leaveFrom || '')}" ${ed ? '' : 'disabled'} aria-label="${esc(n)} leave from" style="min-width:8.5em"></td>
    <td><input type="${lv.leaveTo ? 'date' : 'text'}" onfocus="this.type='date'" onblur="if(!this.value)this.type='text'" data-lv="leaveTo" data-n="${esc(n)}" value="${esc(lv.leaveTo || '')}" ${ed ? '' : 'disabled'} aria-label="${esc(n)} leave to" style="min-width:8.5em"></td>
    <td>${lv.leaveTo ? `<label class="row small"><input type="checkbox" data-lv="leaveConfirmed" data-n="${esc(n)}" ${lv.leaveConfirmed ? 'checked' : ''} ${ed ? '' : 'disabled'}> ${lv.leaveConfirmed ? 'yes' : '<span style="color:var(--crit)">estimate</span>'}</label>` : ''}</td>
    <td>${pick ? `<input type="text" data-in="picks" data-n="${esc(n)}" value="${esc(v.picks)}" placeholder="e.g. 4, 9, 15" ${pickEd ? '' : 'disabled'} aria-label="${esc(n)} call picks">` : ''}</td></tr>`; }).join('')}
  </tbody></table></div>
  <p class="small muted">Vacation days are that month's dates (Mon–Fri block calls; weekends next to it are protected by S4). Leave dates carry across months. Unconfirmed leave dates show ⚠ on every call they affect. Call picks lock that person into the upper slot on those days.</p>
  <div class="row"><button class="btn primary" id="inputsApply" ${isScheduler() && st.status !== 'Published' ? '' : 'disabled'}>Rebuild ${MONTHS_LONG[ym(k)[1] - 1]} with these inputs</button></div></div>`;
}
function order(n) { const p = DATA.pgy[n]; return p === 'F' ? -1 : 6 - p; } // fellow first, then PGY-5 down to interns

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
  const improve = improvements(ev, P, ppl); IMPROVE = improve;
  return `<div class="row"><h2>${STATV === 'ytd' ? 'Year-to-date' : monthName(S.month)} stats</h2><span class="muted small">Live from the current draft.</span></div>
  <div class="seg" role="tablist"><button class="${STATV === 'month' ? 'on' : ''}" data-statv="month">${monthName(S.month)}</button><button class="${STATV === 'ytd' ? 'on' : ''}" data-statv="ytd">Year to date</button></div>
  <div class="tiles" ${STATV === 'ytd' ? 'style="display:none"' : ''}>
    <div class="tile ${hard ? 'crit' : 'good'}"><div class="v">${hard}</div><div class="l">Hard-rule breaks</div></div>
    <div class="tile ${inT === ppl.length ? 'good' : 'warn'}"><div class="v">${inT}/${ppl.length}</div><div class="l">Residents in call target</div></div>
    <div class="tile ${q2 > 8 ? 'warn' : 'good'}"><div class="v">${q2}</div><div class="l">Every-other-day calls</div></div>
    <div class="tile ${minW < 1 ? 'crit' : minW < 2 ? 'warn' : 'good'}"><div class="v">${minW}</div><div class="l">Fewest weekends off (anyone)</div></div>
    <div class="tile ${two > 3 ? 'warn' : 'good'}"><div class="v">${two}</div><div class="l">Two-person days</div></div>
  </div>
  ${STATV === 'ytd' ? ytdHTML(P) : ''}
  <div class="grid2" ${STATV === 'ytd' ? 'style="display:none"' : ''}><div class="panel"><h3>Per resident</h3><div class="tablewrap"><table><thead><tr><th>Name</th><th>Level</th><th>Rotation</th><th>Calls vs target</th><th class="n">Calls</th><th class="n">Wkday</th><th class="n">Fri</th><th class="n">Sat</th><th class="n">Sun</th><th class="n">Holiday</th><th class="n">Wknds off</th><th class="n">q2</th><th class="n">Call hrs</th></tr></thead><tbody>
  ${ppl.map(p => { const s = S2[p.name], lo = p.tmin, hi = p.tmax, mx = 8, off = s.n < lo || s.n > hi;
    return `<tr><td>${esc(p.name)}</td><td>${LEVEL(p.name)}</td><td>${esc(p.rotation)}</td><td><div class="bar" aria-label="${s.n} calls, target ${lo}-${hi}"><div class="band" style="left:${lo / mx * 100}%;width:${Math.max(6, (hi - lo) / mx * 100)}%"></div><div class="dot" style="left:${Math.min(100, s.n / mx * 100)}%;background:${off ? 'var(--warn)' : 'var(--ink)'}"></div></div></td>
    <td class="n">${s.n}</td><td class="n">${s.n - s.fri - s.sat - s.sun}</td><td class="n">${s.fri}</td><td class="n">${s.sat}</td><td class="n">${s.sun}</td><td class="n">${s.hol}</td><td class="n">${s.wOff}/${s.wTot}</td><td class="n">${s.q2 || ''}</td><td class="n">${s.n * S.rules.callHours}</td></tr>`; }).join('')}
  </tbody></table></div><p class="small muted">Call hours use the call-length setting (${S.rules.callHours} h, Rules tab). The 80-hour check needs rotation hours, which aren’t in the data yet.</p></div>
  <div style="display:grid;gap:14px"><div class="panel"><h3>Areas for improvement</h3>${improve.some(x => x.name) ? '<p class="small muted">Click one to see the dates on a calendar.</p>' : ''}<ul class="issues">${improve.length ? improve.map((x, i) => x.name ? `<li class="soft"><button class="linkish" data-imp="${i}">${esc(x.t)}</button></li>` : `<li class="soft">${esc(x.t)}</li>`).join('') : '<li class="ok">Nothing stands out this month.</li>'}</ul></div>
  <div class="panel small"><h3>Do the targets fit the slots?</h3><div class="kv"><span>Upper-level slots</span><b class="num">${st.A.length}</b><span>Upper-level minimum targets</span><b class="num">${upperAsk}</b><span>Mid-level slots</span><b class="num">${st.A.length - two}</b><span>Mid-level maximum targets</span><b class="num">${midCap}</b></div>
  <p class="muted">${upperAsk > st.A.length ? `Targets ask for ${upperAsk - st.A.length} more upper-level calls than there are slots, so some upper levels land under target. ` : ''}${midCap < st.A.length ? `Mids can cover ${midCap} of ${st.A.length} days. A PGY-4 never fills the mid slot (H2), so the rest go to two-person call or a mid over target. ` : ''}</p></div></div></div>`;
}
let STATV = (() => { try { return localStorage.getItem('gs-statv') || 'month'; } catch (e) { return 'month'; } })();
// Year to date: every call from July (actual schedules), earlier drafts, and this month's draft
function ytdHTML(P) {
  const [y, m] = ym(S.month), ay = m >= 7 ? y : y - 1, from = `${ay}-07`, D = dataWithDrafts(S.month), st = cur();
  const months = Object.keys(D.history).filter(h => h >= from && h < S.month).sort();
  const src = months.map(h => ({ h, rows: D.history[h], draft: !DATA.history[h] })); if (st.A) src.push({ h: S.month, rows: st.A.map((a, i) => ({ d: i + 1, call: [a.U, a.M, a.I].filter(Boolean) })), draft: true });
  const T = {}, get = n => T[n] = T[n] || { n: 0, wkd: 0, fri: 0, sat: 0, sun: 0, hol: 0, two: 0, wkends: new Set(), months: new Set() };
  src.forEach(({ h, rows }) => { const [yy, mm] = ym(h), hol = (B.HOLIDAYS[h] || []);
    rows.forEach(x => { const w = E.dow(yy, mm, x.d); x.call.forEach(n => { const s = get(n); s.n++; s.months.add(h); if (w === 5) s.fri++; else if (w === 6) s.sat++; else if (w === 0) s.sun++; else s.wkd++;
      if (hol.includes(x.d)) s.hol++; if (x.call.length === 2) s.two++; if (w === 5 || w === 6 || w === 0) { const sat = new Date(yy, mm - 1, x.d + (w === 5 ? 1 : w === 0 ? -1 : 0)); s.wkends.add(sat.toDateString()); } }); }); });
  // each month's call target (depends on that month's rotation), averaged over the months they were in the pool
  const TG = {}; src.forEach(({ h }) => { let PP; try { const [yy, mm] = ym(h); PP = E.prepare(S.M[h] ? buildInput(h) : B.buildInput(dataWithDrafts(h), yy, mm, 'draft')); } catch (e) { return; }
    PP.people.forEach(q => { if (q.excluded) return; const t = TG[q.name] = TG[q.name] || { lo: 0, hi: 0, k: 0 }; t.lo += q.tmin; t.hi += q.tmax; t.k++; }); });
  const tgt = p => { const t = TG[p.name]; return t && t.k ? { lo: t.lo / t.k, hi: t.hi / t.k } : { lo: p.tmin, hi: p.tmax }; };
  const ppl = P.people.filter(p => T[p.name]).sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
  const grp = p => p.lvl === 1 ? 'I' : (p.lvl === 2 || p.lvl === 3) ? 'M' : 'U';
  const avg = p => T[p.name].n / Math.max(1, T[p.name].months.size);
  // within each level group, flag whoever is well above/below the group's average weekends worked
  const wkMean = {}; ['I', 'M', 'U'].forEach(g => { const v = ppl.filter(p => grp(p) === g).map(p => T[p.name].wkends.size); wkMean[g] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; });
  const label = src.length ? `${MONTHS[ym(src[0].h)[1] - 1]} ${ym(src[0].h)[0]} – ${monthName(S.month)}` : '';
  const drafts = src.filter(x => x.draft).map(x => MONTHS[ym(x.h)[1] - 1]);
  return `<div class="panel"><h3>Year to date · ${esc(label)}</h3><p class="small muted">Actual schedules${drafts.length ? ` + ${drafts.join(', ')} (draft, can still change)` : ''}. Calls only; weekend rounding from past months isn't in the data. Weekends = distinct weekends with a Fri/Sat/Sun call. Bar: shaded band = their average monthly target (each month's target depends on that month's rotation); dot = their actual average, orange if outside the band. Weekends ▲ orange / ▼ blue = 2+ above/below the average for their level.</p>
  <div class="tablewrap"><table><thead><tr><th>Name</th><th>Level</th><th>Avg/mo vs target</th><th class="n">Calls</th><th class="n">Months</th><th class="n">Avg/mo</th><th class="n">Wkday</th><th class="n">Fri</th><th class="n">Sat</th><th class="n">Sun</th><th class="n">Weekends</th><th class="n">Holiday</th><th class="n">Two-person</th><th class="n">Call hrs</th></tr></thead><tbody>
  ${ppl.map(p => { const s = T[p.name], dw = s.wkends.size - wkMean[grp(p)];
    const g = tgt(p), a = avg(p), mx = 8, off = a < g.lo - 0.25 || a > g.hi + 0.25, tl = `${g.lo.toFixed(1)}${g.hi - g.lo >= 0.05 ? '–' + g.hi.toFixed(1) : ''}`;
    return `<tr><td>${esc(p.name)}</td><td>${LEVEL(p.name)}</td><td><div class="bar" data-tip="Avg ${a.toFixed(1)} calls/month · target ${tl}" aria-label="average ${a.toFixed(1)} calls a month, target ${tl}"><div class="band" style="left:${g.lo / mx * 100}%;width:${Math.max(6, (g.hi - g.lo) / mx * 100)}%"></div><div class="dot" style="left:${Math.min(100, a / mx * 100)}%;background:${off ? 'var(--warn)' : 'var(--ink)'}"></div></div></td><td class="n"><b>${s.n}</b></td><td class="n">${s.months.size}</td><td class="n">${avg(p).toFixed(1)}</td><td class="n">${s.wkd}</td><td class="n">${s.fri}</td><td class="n">${s.sat}</td><td class="n">${s.sun}</td><td class="n ${dw >= 2 ? 'worse' : dw <= -2 ? 'better' : ''}" data-tip="${esc(`${p.name}: ${s.wkends.size} weekends with a call. ${{ I: 'Intern', M: 'Mid-level (PGY-2/3)', U: 'Upper-level (PGY-4/5, fellow)' }[grp(p)]} average ${wkMean[grp(p)].toFixed(1)}, so ${Math.abs(dw).toFixed(1)} ${dw >= 0 ? 'above' : 'below'}.${dw >= 2 ? ' Should get lighter weekends going forward.' : dw <= -2 ? ' Due for more weekends.' : ''}`)}">${dw >= 2 ? '▲ ' : dw <= -2 ? '▼ ' : ''}${s.wkends.size}</td><td class="n">${s.hol || ''}</td><td class="n">${s.two || ''}</td><td class="n">${s.n * S.rules.callHours}</td></tr>`; }).join('')}
  </tbody></table></div></div>`;
}
function improvements(ev, P, ppl) {
  const st = ev.stats, out = [], k = S.month, rb = E.roundingBlocks(P, cur().A, B.HOLIDAYS[k] || []);
  const wkDays = P.weekends.map(g => g.filter(d => d <= P.nd)).filter(g => g.length === 3);
  const worked = n => wkDays.filter(g => g.some(d => st[n].calls.includes(d)) || (rb[g[1]] && rb[g[1]].workers && rb[g[1]].workers.has(n)));
  ppl.forEach(p => { const s = st[p.name], n = p.name, base = { name: n, calls: s.calls, vac: [...p.vacAll] };
    if (s.n < p.tmin) out.push({ ...base, t: `${n}: ${p.tmin - s.n} under target (${s.n} of ${p.tmin}${p.tmax > p.tmin ? '–' + p.tmax : ''}).`, flag: [], note: 'Their calls this month.' });
    if (s.n > p.tmax) out.push({ ...base, t: `${n}: ${s.n - p.tmax} over target.`, flag: [], note: 'Their calls this month.' });
    if (s.q2 >= 2) out.push({ ...base, t: `${n}: ${s.q2} every-other-day calls.`, flag: s.calls.filter(d => s.calls.includes(d + 2) || s.calls.includes(d - 2)), note: 'Red = call two days after (or before) another call.' });
    if (s.wTot && s.wOff < 2) out.push({ ...base, t: `${n}: only ${s.wOff} weekend off.`, flag: worked(n).flat(), note: 'Red = weekends they work (call or rounding).' });
    if (s.b2b) { const w = worked(n); out.push({ ...base, t: `${n}: ${s.b2b} back-to-back working weekend${s.b2b > 1 ? 's' : ''}.`, flag: w.filter((g, i) => (w[i - 1] && w[i - 1][0] === g[0] - 7) || (w[i + 1] && w[i + 1][0] === g[0] + 7)).flat(), note: 'Red = back-to-back weekends they work. A first weekend can also follow last month’s final weekend.' }); }
    if (s.bookBroken) out.push({ ...base, t: `${n}: call on a weekend next to vacation.`, flag: s.calls.filter(d => { const w = P.days[d - 1].w; return (w === 0 || w >= 5) && [...p.vacAll].some(v => Math.abs(v - d) <= 3); }), note: 'Red = weekend call next to their vacation (grey).' }); });
  const groups = { Interns: ppl.filter(p => p.lvl === 1), 'Mid levels': ppl.filter(p => p.lvl === 2 || p.lvl === 3), 'PGY-5s': ppl.filter(p => p.lvl === 5) };
  Object.entries(groups).forEach(([g, ps]) => { if (ps.length < 2) return; const v = ps.map(p => ({ n: p.name, w: (p.ytd.wk || 0) + st[p.name].wk })).sort((a, b) => b.w - a.w); if (v[0].w - v.at(-1).w >= 4) out.push({ t: `${g}: weekend load year to date runs from ${v.at(-1).w} (${v.at(-1).n}) to ${v[0].w} (${v[0].n}). Next month should favor ${v.at(-1).n}.` }); });
  requestMissDetail().forEach(r => { const p = P.byName[r.name]; out.push({ t: `Request missed: ${r.name} ${MONTHS[ym(k)[1] - 1]} ${r.day} (${r.type === 'off' ? 'asked off' : 'wanted call'}).`, name: r.name, calls: st[r.name] ? st[r.name].calls : [], vac: p ? [...p.vacAll] : [], flag: [r.day], note: r.type === 'off' ? 'Red = the day they asked off but are on call.' : 'Red = the day they wanted call.' }); });
  return out;
}
function requestMissDetail() { const st = cur(), out = []; cons(S.month).forEach(c => { if (c.type !== 'off' && c.type !== 'want') return; c.days.forEach(d => { const a = st.A && st.A[d - 1]; const hit = a && [a.U, a.M, a.I].includes(c.name); if ((c.type === 'off' && hit) || (c.type === 'want' && !hit)) out.push({ name: c.name, day: d, type: c.type }); }); }); return out; }
let IMPROVE = [];
function modal(html, onWire) { const ov = document.createElement('div'); ov.className = 'modal-ov'; ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`; document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', k_); }; const k_ = e => { if (e.key === 'Escape') close(); };
  ov.onclick = e => { if (e.target === ov) close(); }; document.addEventListener('keydown', k_); ov.querySelectorAll('[data-close]').forEach(b => b.onclick = close); if (onWire) onWire(ov, close); highlightMe(ov); return ov; }
function askRebuild(k) {
  S.M[k].stale = true;
  if (!(isScheduler() && !['Published', 'PD review', 'Approved'].includes(S.M[k].status))) return;
  modal(`<h3 style="margin-top:0">Rebuild ${esc(monthName(k))} now?</h3><p class="small">The new rule only changes the schedule after a rebuild. Locked cells stay as they are.</p>
    <div class="row" style="gap:8px"><button class="btn primary" id="rbNow">Rebuild now</button><button class="btn" data-close>Later</button></div>`,
    (ov, close) => { ov.querySelector('#rbNow').onclick = () => { close(); S.month = k; $('#monthSel').value = k; location.hash = 'schedule'; generate(true, k); }; });
}
function showImprove(x) {
  const k = x.month || S.month, RB0 = rbFor(k), [y, m] = ym(k), nd = new Date(y, m, 0).getDate(), first = new Date(y, m - 1, 1).getDay(), hol = HOLNAMES[k] || {};
  let cells = '<div class="mc-h">S</div><div class="mc-h">M</div><div class="mc-h">T</div><div class="mc-h">W</div><div class="mc-h">T</div><div class="mc-h">F</div><div class="mc-h">S</div>' + '<div></div>'.repeat(first);
  for (let d = 1; d <= nd; d++) { const w = (first + d - 1) % 7, c = [];
    if (w === 0 || w === 6) c.push('wk'); if (x.vac.includes(d)) c.push('vac'); if (x.calls.includes(d)) c.push('call'); if (x.flag.includes(d)) c.push('flag');
    const rl = roundLines(RB0, k, d), rTeam = rl && x.name ? (rl.find(t => new RegExp('\\b' + x.name + '\\b').test(t)) || '').split(':')[0] : '';
    cells += `<div class="mc-d ${c.join(' ')}" title="${hol[d] ? esc(hol[d]) : ''}${rTeam ? ' · rounds ' + esc(rTeam) : ''}"><span>${d}</span>${x.calls.includes(d) ? '<i>call</i>' : rTeam ? `<i class="rd">rounds ${esc(rTeam)}</i>` : ''}</div>`; }
  const ov = document.createElement('div'); ov.className = 'modal-ov';
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(x.t)}"><div class="row"><h3 style="margin:0">${esc(x.t)}</h3><span class="spacer"></span><button class="btn" id="mcClose">Close</button></div>
    <p class="small muted" style="margin:6px 0 10px">${esc(monthName(k))} · ${esc(x.name)}. ${esc(x.note || '')}</p><div class="minical">${cells}</div>
    <div class="row small" style="margin-top:10px;gap:14px"><span><span class="sw call"></span>On call</span><span><span class="sw flag"></span>${esc(x.flagLabel || 'The problem')}</span><span><span class="sw vac"></span>Vacation</span><span><span class="sw wk"></span>Weekend</span></div></div>`;
  document.body.appendChild(ov); highlightMe(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc_); }; const esc_ = e => { if (e.key === 'Escape') close(); };
  ov.onclick = e => { if (e.target === ov) close(); }; ov.querySelector('#mcClose').onclick = close; document.addEventListener('keydown', esc_); ov.querySelector('#mcClose').focus();
}

// Published vs engine, re-scored live: counts plus where each problem happens (who and which dates)
const BTD = {};
function btDetail(m) {
  if (BTD[m]) return BTD[m];
  const k = `2026-${String(m).padStart(2, '0')}`, mn = MONTHS[m - 1], P = E.prepare(B.buildInput(DATA, 2026, m, 'backtest'));
  const one = A => { const ev = E.evaluate(P, A), st = ev.stats, ppl = P.people.filter(p => !p.excluded && st[p.name]), o = {};
    o.hardL = ev.issues.filter(x => x.sev === 'hard').map(x => x.msg.replace(/Day (\d+)/g, (_, d) => `${mn} ${d}`));
    o.q2L = []; ppl.forEach(p => { const c = st[p.name].calls; c.filter(d => c.includes(d + 2)).forEach(d => o.q2L.push(`${p.name}: ${mn} ${d} → ${d + 2}`)); });
    o.bookL = []; ppl.forEach(p => { const c = st[p.name].calls, vd = [...p.vacAll].filter(d => { const w = P.days[d - 1] && P.days[d - 1].w; return w >= 1 && w <= 5; }).sort((a, b) => a - b); if (!vd.length) return;
      const f = vd[0], l = vd.at(-1); [f - 3, f - 2, f - 1].filter(d => c.includes(d)).slice(0, 1).forEach(d => o.bookL.push(`${p.name}: call ${mn} ${d}, right before vacation (${mn} ${f}–${l})`));
      [l + 1, l + 2, l + 3].filter(d => c.includes(d)).slice(0, 1).forEach(d => o.bookL.push(`${p.name}: call ${mn} ${d}, right after vacation (${mn} ${f}–${l})`)); });
    o.outL = ppl.filter(p => st[p.name].n < p.tmin || st[p.name].n > p.tmax).map(p => `${p.name}: ${st[p.name].n} calls (target ${p.tmin}${p.tmax > p.tmin ? '–' + p.tmax : ''}), ${st[p.name].n < p.tmin ? 'under' : 'over'}`);
    o.twoL = A.map((a, i) => !a.M ? `${mn} ${i + 1}: ${a.U || '?'} + ${a.I || '?'}` : null).filter(Boolean);
    ['hard', 'q2', 'book', 'out', 'two'].forEach(x => o[x] = o[x + 'L'].length); return o; };
  return BTD[m] = { actual: one(B.actualAssign(DATA, k)), engine: one(BT[m].engineA.map(a => ({ U: a.U || null, M: a.M || null, I: a.I || null }))) };
}
let PUBH = null; // published_history rows (every published version, newest edits included)
async function loadPubHist() { try { const { data } = await sb.from('published_history').select('month_key,version,schedule,rnd,published_at').order('month_key').order('version'); PUBH = data || []; } catch (e) { PUBH = []; } if (location.hash.slice(1) === 'history') render(); }
function viewHistory() {
  if (PUBH === null) { PUBH = []; loadPubHist(); }
  const pubMonths = [...new Set(PUBH.map(r => r.month_key))].filter(h => !DATA.history[h] && h < S.month); // the month being worked on isn't history yet
  const allMonths = Object.keys(DATA.history).filter(h => h >= '2026-07').sort().concat(pubMonths.sort());
  if (!allMonths.includes(S.histMonth)) S.histMonth = allMonths.at(-1);
  const k = S.histMonth, [y, m] = ym(k), hol = B.HOLIDAYS[k] || [];
  const btns = `<div class="row"><h2>History</h2><span class="spacer"></span>${allMonths.map(h => `<button class="btn ${h === k ? 'primary' : ''}" data-hm="${h}">${MONTHS[+h.slice(5) - 1]}${h.slice(0, 4) !== '2026' ? ' ’' + h.slice(2, 4) : ''}</button>`).join('')}</div>`;
  if (DATA.history[k]) { // schedules from before the app
    const hist = DATA.history[k], bt = BT[m];
    const tags = d => { const x = hist[d - 1]; const t = []; if (hol.includes(d)) t.push('Holiday'); if (x && x.vac.length) t.push('Vac: ' + x.vac.join(', ')); return t.join(' · '); };
    const MS = [7, 8, 9, 10, 11].filter(i => BT[i]);
    const row = (label, key, what) => `<tr><td data-tip="${esc(what)}">${label}</td>${MS.map(i => { const D = btDetail(i), a = D.actual[key], e = D.engine[key];
      const tip = side => { const L = D[side][key + 'L']; return `${label} · ${MONTHS_LONG[i - 1]} ${side === 'actual' ? 'as published' : 'engine version'} (${L.length})${L.length ? ':\n' + L.slice(0, 12).join('\n') + (L.length > 12 ? `\n+${L.length - 12} more (click for all)` : '') : ''}`; };
      return `<td class="n clk" data-tip="${esc(tip('actual'))}" data-btd="${i}|actual|${key}|${esc(label)}">${a}</td><td class="n clk ${e < a ? 'better' : e > a ? 'worse' : ''}" data-tip="${esc(tip('engine'))}" data-btd="${i}|engine|${key}|${esc(label)}">${e < a ? '▼ ' : e > a ? '▲ ' : ''}${e}</td>`; }).join('')}</tr>`;
    const cmp = adminView() && MS.length ? `<div class="panel"><h3>Published schedules vs what the engine would have made</h3>
      <p class="small muted">Each month rebuilt with what the schedulers knew then (that month's vacations, plus PGY-5, fellow and holiday dates locked as they happened), both scored live against today's rules. Lower is better: <b class="better">▼ blue</b> = engine did better, <b class="worse">▲ orange</b> = engine did worse.</p>
      <div class="tablewrap"><table><thead><tr><th></th>${MS.map(i => `<th class="n">${MONTHS[i - 1]} actual</th><th class="n">${MONTHS[i - 1]} engine</th>`).join('')}</tr></thead><tbody>
      ${row('Hard-rule breaks', 'hard', 'Breaks of any hard rule in v1.3 (ACGME limits, post-call, sister services, level rules…).')}${row('Every-other-day calls', 'q2', 'Calls exactly two days after that person’s previous call (q2). Fewer = more rest between calls.')}${row('Vacation bookends broken', 'book', 'Weekend call right before or after someone’s vacation, which eats into the time off.')}${row('Residents outside target', 'out', 'People whose call count for the month landed below or above their target range.')}${row('Two-person days', 'two', 'Days covered by a PGY-4 + intern with no mid level. Not a rule break, but heavier for those two.')}</tbody></table></div>
      <p class="small muted">Hover a number to see where it happens; click it for the full list. Many "breaks" in the real schedules are rules that were only written down this month (H15 sister services; H2, no PGY-4 in the mid slot), so they weren't mistakes at the time. The engine uses more two-person days for the same reason.</p></div>` : '';
    return `${btns}${cmp}<div class="panel" style="padding:10px"><div class="row" style="padding:4px 6px 10px"><h3>${MONTHS_LONG[m - 1]} ${y}</h3><span class="muted small">Published schedule (before the app)</span></div>
    ${calendarHTML(B.actualAssign(DATA, k), k, { click: false, tags, rb: rbFor(k) })}
    ${adminView() && bt && bt.actualIssues.length ? `<details style="margin-top:10px"><summary class="small">Rule breaks in the published ${MONTHS_LONG[m - 1]} schedule (${bt.actualIssues.length})</summary><ul class="issues">${bt.actualIssues.map(i => `<li class="hard">${esc(i)}</li>`).join('')}</ul></details>` : ''}</div>`;
  }
  // published from the app: every version, newest first by default; changed cells marked vs the version before
  const vers = PUBH.filter(r => r.month_key === k); if (!vers.length) return btns + '<div class="panel small muted">Loading…</div>';
  const vSel = vers.find(r => r.version === S.histVer && S.histVerKey === k) || vers.at(-1), prev = vers.find(r => r.version === vSel.version - 1);
  const toA = sc => (sc || []).map(a => Array.isArray(a) ? { U: a[0] || null, M: a[1] || null, I: a[2] || null } : a);
  const A = toA(vSel.schedule), P0 = prev ? toA(prev.schedule) : null, flags = {};
  if (P0) A.forEach((a, i) => ['U', 'M', 'I'].forEach(sl => { const was = P0[i] && P0[i][sl]; if ((a[sl] || null) !== (was || null)) flags[(i + 1) + '|' + sl] = `changed in v${vSel.version} (was ${was || 'nobody'})`; }));
  const when = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const nChanged = Object.keys(flags).length;
  return `${btns}<div class="panel" style="padding:10px"><div class="row" style="padding:4px 6px 10px;gap:6px;flex-wrap:wrap"><h3>${MONTHS_LONG[m - 1]} ${y}</h3><span class="spacer"></span>
    ${vers.map(r => `<button class="btn ${r === vSel ? 'primary' : ''}" data-hver="${r.version}">${r.version === 1 ? 'Published' : 'Update ' + (r.version - 1)} · ${when(r.published_at)}</button>`).join('')}</div>
    ${prev ? `<p class="small muted" style="margin:0 6px 8px">${nChanged ? `${nChanged} cell${nChanged > 1 ? 's' : ''} changed from the version before, marked ↻ (hover to see who it was).` : 'No call changes from the version before (rounding may have changed).'}</p>` : ''}
    ${calendarHTML(A, k, { click: false, changed: flags, rb: vSel.rnd ? unpackRB(vSel.rnd) : rbFor(k), tags: d => (HOLNAMES[k] || {})[d] || (hol.includes(d) ? 'Holiday' : '') })}</div>`;
}

function viewNotes() {
  if (!adminView()) return viewRequests();
  const st = cur(), k = S.month, roster = Object.keys(st.inputs), mn = MONTHS_LONG[ym(k)[1] - 1], C = cons(k);
  const pend = S.requests.filter(r => r.month_key === k && r.status === 'pending'), denied = S.requests.filter(r => r.month_key === k && r.status === 'denied');
  const otherPend = S.requests.filter(r => r.month_key !== k && r.status === 'pending').length;
  return `<div class="row"><h2>Requests · ${mn}</h2><span class="muted small">Resident requests come in below. Texted requests can be pasted and read by Claude. Nothing changes the schedule until a scheduler or chief accepts it.</span></div>
  <div class="panel"><h3>Incoming requests for ${mn} (${pend.length})</h3>${otherPend ? `<p class="small muted">${otherPend} more pending for other months. Switch the month at the top to see them.</p>` : ''}
    ${pend.length ? `<ul class="issues">${pend.map(r => `<li class="soft"><button class="linkish" data-qcal="${r.id}" title="See it on ${esc(r.resident)}'s calendar"><b>${esc(r.resident)}</b>: ${esc(describe({ type: r.type, name: '', days: r.days, reason: r.note }).trim())} 📅</button>${isLate(r) ? ' <span class="pill warn">late</span>' : ''} <span class="muted small">· sent ${new Date(r.created_at).toLocaleDateString()}</span>
      <div class="row" style="margin-top:6px;gap:6px">${canDecide() ? `<button class="btn primary" data-qacc="${r.id}" style="padding:1px 10px">Accept</button><button class="btn" data-qden="${r.id}" style="padding:1px 10px">Deny</button><input type="text" data-qwhy="${r.id}" placeholder="Reason if denying (they'll see it)" style="min-width:220px;flex:1">` : '<span class="small muted">A scheduler or chief decides.</span>'}</div></li>`).join('')}</ul>` : '<p class="small muted">No pending requests.</p>'}</div>
  ${CTX.profile.can_preview ? stressPanel(k) : ''}
  ${adminSwapsHTML(k)}
  <div class="grid2" style="margin-top:14px"><div class="panel"><label for="notes" class="small muted">Texted requests (paste them here; only admins can see this box)</label>
    <textarea id="notes">${esc(S.notes[k] || '')}</textarea>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="interpret" ${sample ? '' : 'disabled'}>Interpret with Claude</button><span class="small muted">${sample ? 'Each note becomes a proposed rule below. Nothing changes until a scheduler accepts it.' : 'Claude isn’t connected.'}</span></div>
    <div style="margin-top:12px">${proposalsHTML()}</div></div>
  <div style="display:grid;gap:14px"><div class="panel"><h3>Accepted rules for ${mn}</h3>
    ${C.length ? `<ul class="issues">${C.map(c => `<li class="ok">${esc(describe(c))}${c.source === 'resident' ? ' <span class="pill">request</span>' : ''}${c.source === 'pd' ? ' <span class="pill good">PD: always honored</span>' : ''} ${canDecide() ? `<button class="btn" data-rm="${c.id}" style="float:right;padding:1px 8px">Remove</button>` : ''}<div class="small muted">${c.source === 'resident' ? 'Accepted' : 'Added'} by ${esc(whoName(c.by))} · ${esc(whenTxt(c.at))}</div></li>`).join('')}</ul>` : '<p class="small muted">None yet.</p>'}
    ${denied.length ? `<details><summary class="small">Denied (${denied.length})</summary><ul class="issues">${denied.map(r => `<li class="small">${esc(r.resident)}: ${esc(describe({ type: r.type, name: '', days: r.days, reason: r.note }).trim())}${r.reason ? ' — “' + esc(r.reason) + '”' : ''}<div class="muted">Denied by ${esc(whoName(r.decided_by))} · ${esc(whenTxt(r.decided_at))}</div></li>`).join('')}</ul></details>` : ''}
    <div class="row" style="margin-top:10px"><button class="btn primary" id="applyNotes" ${canEdit() && C.length ? '' : 'disabled'}>Rebuild with these</button></div></div>
  <div class="panel small"><h3>Add a rule by hand</h3><div class="kv">
    <label for="mType">Type</label><select id="mType" class="f"><option value="off">Day off request</option><option value="want">Wants call</option><option value="block">Unavailable (firm)</option><option value="protected">Protected event (no post-call)</option><option value="colorectal">Big colorectal day</option></select>
    <label for="mName">Resident</label><select id="mName" class="f">${roster.map(n => `<option>${n}</option>`).join('')}</select>
    <label for="mDays">${mn} days</label><input id="mDays" type="text" placeholder="e.g. 11-13 or 16"><label for="mWhy">Reason</label><input id="mWhy" type="text" placeholder="optional"></div>
    <div class="row" style="margin-top:10px"><button class="btn" id="addManual" ${canDecide() ? '' : 'disabled'}>Add rule</button></div>${S.role === 'Program Director' ? '<p class="small muted" style="margin-top:6px">Rules you add as PD are always honored: “off” becomes firmly unavailable and “wants call” locks them into that day.</p>' : ''}</div></div></div>`;
}
const RTYPES = [['off', 'Day off (best effort)'], ['want', 'Wants call'], ['block', 'Unavailable (firm: leave, away)'], ['protected', 'Exam or event (not post-call that day)']];
const STATUS_PILL = { pending: '<span class="pill">pending</span>', accepted: '<span class="pill good">accepted</span>', denied: '<span class="pill crit">denied</span>' };
function viewRequests() {
  const myName = CTX.profile.roster_name || MY_NAME;
  if (!myName) return `<div class="panel"><h2>Requests</h2><p>Your account isn’t linked to the roster yet. Ask a scheduler or chief to set your roster name on the People tab.</p></div>`;
  const months = Object.keys(S.M).filter(k => S.M[k].status !== 'Published'), k = months.includes(S.month) ? S.month : months[0] || S.month;
  const mine = S.requests.filter(r => r.source === 'resident' && r.created_by === me.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const dl = reqDeadline(k);
  return `<div class="row"><h2>Requests</h2><span class="muted small">Only you and the schedulers/chiefs can see your requests. Due by ${dl.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} for ${monthName(k)}; later ones are marked late.</span></div>
  <div class="grid2"><div class="panel"><h3>New request</h3><div class="kv">
    <label for="qMonth">Month</label><select id="qMonth" class="f">${months.map(m => `<option value="${m}" ${m === k ? 'selected' : ''}>${monthName(m)}</option>`).join('')}</select>
    <label for="qType">Type</label><select id="qType" class="f">${RTYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    <label for="qDays">Days</label><input id="qDays" type="text" placeholder="e.g. 11-13 or 16, 20">
    <label for="qNote">Note</label><input id="qNote" type="text" placeholder="optional, e.g. wedding"></div>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="qSend">Send request</button></div>
    ${sample ? `<hr style="margin:14px 0;border:0;border-top:1px solid var(--line)"><label for="qText" class="small muted">Or describe it and Claude fills in the form</label><textarea id="qText" rows="2" placeholder="e.g. I need the weekend of the 12th off for a wedding"></textarea><div class="row" style="margin-top:8px"><button class="btn" id="qClaude">Fill in with Claude</button></div>` : ''}</div>
  <div class="panel"><h3>My requests</h3>${mine.length ? `<ul class="issues">${mine.map(r => `<li class="${r.status === 'denied' ? 'hard' : r.status === 'accepted' ? 'ok' : 'soft'}">${STATUS_PILL[r.status]} <b>${esc(monthName(r.month_key))}</b>: ${esc((RTYPES.find(t => t[0] === r.type) || [, r.type])[1])}, ${esc(r.days.join(', '))}${r.note ? ' · ' + esc(r.note) : ''}${isLate(r) ? ' <span class="pill warn">late</span>' : ''}${r.status === 'denied' && r.reason ? `<div class="small">Why: ${esc(r.reason)}</div>` : ''}${r.status === 'pending' ? ` <button class="btn" data-qwd="${r.id}" style="float:right;padding:1px 8px">Withdraw</button>` : ''}</li>`).join('')}</ul>` : '<p class="small muted">No requests yet.</p>'}</div></div>
  ${residentSwapsHTML()}`;
}

function describe(c) { const mo = MONTHS[ym(S.month)[1] - 1]; const days = c.days.map(d => mo + ' ' + d).join(', '); const t = { off: 'off (best effort, S6)', want: 'wants call (best effort)', block: 'unavailable (firm)', protected: 'protected: not post-call (S2)', colorectal: 'big colorectal day: GS2 resident not post-call (S3)' }[c.type]; return `${c.type === 'colorectal' ? 'GS2' : c.name}: ${days} ${t}${c.reason ? ' — ' + c.reason : ''}`; }
function proposalsHTML() { if (!S.proposals.length) return ''; return `<h3 style="margin-bottom:6px">Claude's reading</h3><ul class="issues">${S.proposals.map((c, i) => `<li class="${c.problem ? 'hard' : 'soft'}">${esc(describe(c))}${c.problem ? ` <b>— ${esc(c.problem)}</b>` : ''}<span style="float:right;display:flex;gap:6px">${c.problem || !canDecide() ? '' : `<button class="btn" data-acc="${i}" style="padding:1px 8px">Accept</button>`}<button class="btn" data-rej="${i}" style="padding:1px 8px">Reject</button></span></li>`).join('')}</ul>`; }
async function interpret() {
  const st = cur(); const txt = $('#notes').value.trim(); if (!txt) return; S.notes[S.month] = txt; saveNotes(S.month);
  const [y, m] = ym(S.month); const roster = Object.entries(st.inputs).map(([n, r]) => `${n} (${LEVEL(n)}, ${r.rotation})`).join('; ');
  const prompt = `You convert residency call-schedule notes into structured rules. Month: ${MONTHS_LONG[m - 1]} ${y} (day 1 is a ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][E.dow(y, m, 1)]}; ${ndays(S.month)} days). Roster: ${roster}. Nicknames: ${DATA.nicknames || 'none'}.
Rule types: "off" = asks not to be on call those days (best effort); "want" = asks to be on call those days; "block" = firmly unavailable (leave, away, sick); "protected" = an exam or event: the person must not be post-call that day (Step 3, boards, ABSITE, ATLS); "colorectal" = big colorectal case day (name = the GS2 resident).
If a weekend is mentioned as off, include Fri, Sat and Sun. Use day numbers in this month only.
Return JSON only: {"rules":[{"type":"off|want|block|protected|colorectal","name":"<exact roster name>","days":[<ints>],"reason":"<short>"}]}.
Notes:
${txt}`;
  const btn = $('#interpret'); btn.disabled = true; btn.textContent = 'Reading notes…';
  try { const { data: v, error } = await sb.functions.invoke('interpret-notes', { body: { prompt } }); if (error || (v && v.error)) throw new Error(await fnError(error, v)); S.proposals = ((v && v.rules) || []).map(r => { const c = { type: r.type, name: r.name, days: (r.days || []).filter(d => d >= 1 && d <= ndays(S.month)), reason: r.reason || '' }; if (!['off', 'want', 'block', 'protected', 'colorectal'].includes(c.type)) c.problem = 'unknown rule type'; else if (c.type !== 'colorectal' && !st.inputs[c.name]) c.problem = 'name not on this month’s roster'; else if (!c.days.length) c.problem = 'no dates in this month'; return c; }); if (!S.proposals.length) toast('Claude found no rules in those notes.'); }
  catch (e) { toast('Claude couldn’t read the notes: ' + ((e && e.message) || 'error')); }
  btn.disabled = false; btn.textContent = 'Interpret with Claude'; render();
}

const RC = window.RULES_CATALOG;
const RULE_BY_ID = Object.fromEntries(RC.groups.flatMap(g => (g.rules || []).concat(...(g.sections || []).map(s => s.rules))).map(r => [r.id, r]));
function ruleItem(r) { return `<li class="rule" id="rule-${r.id}"><div><b class="rid">${esc(r.id)}</b> <b>${esc(r.title)}.</b> ${esc(r.plain)}</div><div class="small muted">What the app checks: ${esc(r.computer)}</div></li>`; }
function rulesCatalogHTML() {
  return RC.groups.map(g => `<div class="panel" id="rg-${g.id}" style="margin-top:14px"><div class="row"><h3 style="margin:0">${esc(g.title)}</h3><span class="pill neutral">${esc(g.tier)}</span></div><p class="small muted">${esc(g.intro)}</p>
    ${g.sections ? g.sections.map(s => `<h4 style="margin:12px 0 4px">${esc(s.title)}</h4><ul class="rules">${s.rules.map(ruleItem).join('')}</ul>`).join('') : `<ul class="rules">${g.rules.map(ruleItem).join('')}</ul>`}</div>`).join('')
  + `<div class="panel" id="rguide" style="margin-top:14px"><h3 style="margin-top:0">How to use this app</h3>${RC.guide.map(s => `<h4 style="margin:12px 0 4px">${esc(s.title)}</h4><ol class="small" style="margin:0;padding-left:20px">${s.steps.map(t => `<li style="margin:3px 0">${esc(t)}</li>`).join('')}</ol>`).join('')}</div>`;
}
function viewRules() {
  const R = S.rules, t = R.targets, dis = isScheduler() || S.role === 'Program Director' ? '' : 'disabled'; // the PD can change any rule setting
  const tr = (k, label) => `<tr><td>${label}</td><td><input type="number" min="0" max="12" data-t="${k}" data-i="0" value="${t[k][0]}" ${dis} aria-label="${label} minimum"></td><td><input type="number" min="0" max="12" data-t="${k}" data-i="1" value="${t[k][1]}" ${dis} aria-label="${label} maximum"></td></tr>`;
  const p4 = Object.keys(DATA.pgy).filter(n => DATA.pgy[n] === 4);
  return `<div class="row"><h2>Rules</h2><span class="muted small">Rules ${esc(RC.version)} (v1.1 PD approved Nov 5; v1.3 changes pending PD sign-off). Settings first, then every rule in plain English, then a how-to guide.</span></div>
  <nav class="row small" style="gap:12px;margin:-4px 0 10px"><a href="#rules" data-jump="rsettings">Settings</a>${RC.groups.map(g => `<a href="#rules" data-jump="rg-${g.id}">${esc(g.title)}</a>`).join('')}<a href="#rules" data-jump="rguide">How to use this app</a></nav>
  <div class="grid2" id="rsettings"><div class="panel"><h3>Call targets per month (F1)</h3>
    <table style="max-width:420px"><thead><tr><th>Group</th><th>Min</th><th>Max</th></tr></thead><tbody>${tr(1, 'Interns')}${tr(2, 'PGY-2')}${tr(3, 'PGY-3')}${tr(4, 'PGY-4')}${tr(5, 'PGY-5')}${tr('F', 'Fellow')}</tbody></table>
    <h3 style="margin-top:16px">Limits</h3><div class="kv"><label for="rCap">Fellow cap (H7)</label><input id="rCap" type="number" min="0" max="10" value="${R.fellowCap}" ${dis}><label for="rQ2">Max calls in a row, every other day (H14)</label><input id="rQ2" type="number" min="1" max="6" value="${R.maxQ2Run}" ${dis}><label for="rHrs">Call length for hour estimates</label><input id="rHrs" type="number" min="12" max="36" value="${R.callHours}" ${dis}></div></div>
  <div style="display:grid;gap:14px">
    <div class="panel small"><h3>Two-person call exceptions (H3)</h3><p class="muted">Not eligible for two-person call until a PGY-5 chief or the PD removes them.</p>
      ${p4.map(n => `<label class="row"><input type="checkbox" data-ntp="${esc(n)}" ${(R.noTwoPerson || []).includes(n) ? 'checked' : ''} ${S.role === 'Chief' || S.role === 'Program Director' ? '' : 'disabled'}> ${esc(n)}</label>`).join('')}</div>
    <div class="panel small"><h3>Open question</h3><label class="row" style="align-items:flex-start;gap:8px"><input type="checkbox" id="rSS" ${R.sameServiceBlocked ? 'checked' : ''} ${dis}><span><b>Two residents on the same service never share a call day.</b> Not in the rules (H15 covers sister services only). Happened 6 times Jul–Nov.</span></label></div>
    <div class="panel small"><h3>Always on</h3><p class="muted">ACGME limits, H1–H15 (a PGY-4 never fills the mid slot), holiday trios, vacation and leave, excluded rotations (Richardson, Peds, Transplant), Fri/Sat/Sun callers work that weekend's rounding (H9). Rounding counts as a worked weekend (S5, F2, S7: avoid back-to-back weekends). Fill-in rounders rotate (cross-cover first if the service's resident worked last weekend); one resident covers HPB and Transplant, two when feasible (W2); the SICU fellow and the ICU resident alternate ICU weekends, fellow two a month; each one's off weekend is fully off, no call (W3). Locked picks and the holiday list decide whose weekend it is when they can. T/EGS residents PGY-3 and up alternate weekends, each with a lower level; off weekend fully off (W6). If an ICU partner or a T/EGS PGY-3+ partner is away, the other isn't post-call on weekdays (H16). Big colorectal days are Mon/Wed (S3).</p>
      <button class="btn primary" id="rulesApply" ${canEdit() ? '' : 'disabled'}>Rebuild with these rules</button></div></div></div>
  ${rulesCatalogHTML()}`;
}

function viewApproval() {
  const st = cur(), steps = ['Draft', 'Scheduler review', 'PD review', 'Approved', 'Published'], idx = Math.max(0, steps.indexOf(st.status)), r = S.role, previewing = roleKey(S.role) !== S.realRole;
  let actions = '';
  if ((r === 'Scheduler' || r === 'Chief') && ['Draft', 'Scheduler review'].includes(st.status) && st.A) actions = `<button class="btn" id="saveVer">Save version</button><button class="btn primary" id="toPD">Send to the PD</button>`;
  if (r === 'Program Director' && st.status === 'PD review') actions = `<input type="text" id="pdNote" placeholder="Comment (optional)" style="min-width:220px"><button class="btn" id="sendBack">Send back with changes</button><button class="btn" id="approveHold">Approve, send to schedulers</button><button class="btn primary" id="approve">Approve and publish</button>`;
  if ((r === 'Scheduler' || r === 'Chief') && st.status === 'Approved') actions = `<span class="small">The PD approved this. Publish when you're ready.</span><button class="btn" id="unapprove">Reopen for edits</button><button class="btn primary" id="publish">Publish</button>`;
  if ((r === 'Scheduler' || r === 'Chief') && st.status === 'Published') actions = `<button class="btn" id="revise">Start a revised version</button>`;
  return `<div class="row"><h2>Approval · ${monthName(S.month)}</h2><span class="muted small">The scheduler/chief builds, the PD approves, then it goes out. Every version is kept. Swaps after publishing: a scheduler or PGY-5 chief approves (SW3).</span></div>
  <div class="stepper">${steps.map((s, i) => `<div class="step ${i < idx ? 'done' : i === idx ? 'now' : ''}"><b>${s}</b><span class="small muted">${['Schedulers edit and rebuild', 'Schedulers check Stats', 'PD approves or sends back', 'PD approved; schedulers publish', 'Residents see it'][i]}</span></div>`).join('')}</div>
  ${previewing && adminView() ? `<div class="banner">Preview: these are the ${esc(roleName())}'s buttons, shown for reference. Only a real ${esc(roleName())} account can press them (the database checks). To test the PD steps, add a test account with the Program director role on People and sign in as it in a private window.</div>` : ''}
  ${!adminView() ? `<p class="small muted">Where this month's schedule is in the approval process. You'll see it on the Schedule tab once it's published.</p>` : `<div class="panel"><div class="row actions ${previewing ? 'preview' : ''}">${actions || `<span class="muted small">Nothing for the ${esc(roleName())} to do at this stage.</span>`}<span class="spacer"></span><button class="btn" id="copyTxt" ${st.A ? '' : 'disabled'}>Copy schedule as text</button></div></div>
  <div class="grid2"><div class="panel"><h3>Versions</h3>${st.versions.length ? `<div class="tablewrap"><table><thead><tr><th>Version</th><th>Saved</th><th>Status</th><th class="n">Changed days</th><th></th></tr></thead><tbody>${st.versions.slice().reverse().map(v => `<tr><td>v${v.n}</td><td>${new Date(v.at).toLocaleString()}</td><td>${esc(v.status)}</td><td class="n">${v.changed == null ? '—' : v.changed}</td><td>${canEdit() ? `<button class="btn" data-restore="${v.n}" style="padding:1px 8px">Restore</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">No saved versions yet.</p>'}</div>
  <div class="panel"><h3>Activity</h3><ul class="issues">${st.log.slice(-14).reverse().map(l => `<li class="ok small"><b>${esc(l.role)}</b> ${esc(l.text)} <span class="muted">· ${new Date(l.at).toLocaleString()}</span></li>`).join('') || '<li class="ok small">No activity yet.</li>'}</ul></div></div>`}`;
}
function saveVersion(status) { const st = cur(); const prev = st.versions.at(-1); const A = st.A.map(a => [a.U, a.M, a.I]); const changed = prev ? A.filter((a, i) => a.join() !== (prev.A[i] || []).join()).length : null; const n = (prev ? prev.n : 0) + 1; st.versions.push({ n, at: new Date().toISOString(), status, A, changed }); const k = S.month; const ins = () => sb.from('versions').insert({ month_key: k, n, status, schedule: A, changed, created_by: me.id }).then(() => {}); if (existing.has(k)) ins(); else setTimeout(ins, 1500); }
function scheduleText() { const k = S.month; return `${monthName(k)} call schedule (${cur().status})\n` + cur().A.map((a, i) => `${dateLabel(k, i + 1)}: ${[a.U, a.M, a.I].filter(Boolean).join(' / ')}${a.M ? '' : ' (two-person)'}${(HOLNAMES[k] || {})[i + 1] ? ' [' + HOLNAMES[k][i + 1] + ']' : ''}`).join('\n'); }

// ---------- PDF ----------
async function downloadPDF() {
  const k = S.month, st = cur(), [y, m] = ym(k);
  try {
    const rb = getRB(k, E.prepare(buildInput()));
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
// ---------- resident-to-resident trades (published months only) ----------
const SW_STATUS = { pending: 'waiting on them', agreed: 'agreed; waiting on schedulers', declined: 'declined', approved: 'approved', denied: 'denied by schedulers', withdrawn: 'withdrawn', cancelled: 'cancelled (schedule changed)' };
const openSwap = (k, d, s, n) => S.swaps.some(x => x.month_key === k && x.slot === s && ['pending', 'agreed'].includes(x.status) && ((x.day_a === d && x.requester === n) || (x.day_b === d && x.target === n)));
function swapOptions(k, d, s) {
  const st = S.M[k], me_ = st.A[d - 1][s], type = dayType(k, d), P = E.prepare(buildInput(k)), base = E.evaluate(P, st.A).hard, out = [];
  st.A.forEach((b, i) => { const d2 = i + 1, other = b[s]; if (d2 === d || !other || other === me_ || isHolidayLock(k, d2) || dayType(k, d2) !== type) return;
    if (!S.acct[other] || openSwap(k, d2, s, other)) return;
    const trial = st.A.map(x => Object.assign({}, x)); trial[d - 1][s] = other; trial[i][s] = me_;
    if (E.evaluate(P, trial).hard <= base) out.push({ d2, other }); });
  return out;
}
function openSwapAsk(d, s) {
  const k = S.month, st = cur(), n = st.A[d - 1][s];
  const busy = openSwap(k, d, s, n), opts = busy ? [] : swapOptions(k, d, s);
  $('#drawer').innerHTML = `<div class="row"><h3>Swap ${dateLabel(k, d)}</h3><span class="spacer"></span><button class="btn" id="dClose">Close</button></div>
    <p class="small muted">Trades only, like for like (${dayType(k, d)} for ${dayType(k, d)}). Only trades that keep every hard rule are listed. The other resident agrees, then a scheduler or chief approves.</p>
    ${busy ? '<p class="small">This call already has an open swap. See Requests.</p>' : opts.length ? `<label class="small" for="swNote">Note (optional)</label><input id="swNote" type="text" placeholder="e.g. family wedding" style="width:100%;margin-bottom:8px">
      <div style="display:grid;gap:6px">${opts.map(o => `<button class="opt" data-ask="${o.d2}"><span>You take <b>${dateLabel(k, o.d2)}</b> · ${esc(o.other)} takes yours</span><span class="why">ask ${esc(o.other)}</span></button>`).join('')}</div>`
      : '<p class="small">No trade fits the rules for this call (or the other residents don’t have accounts yet).</p>'}`;
  $('#drawer').classList.add('open'); $('#dClose').onclick = () => $('#drawer').classList.remove('open');
  $('#drawer').querySelectorAll('[data-ask]').forEach(b => b.onclick = async () => { const d2 = +b.dataset.ask, other = st.A[d2 - 1][s];
    const { error } = await sb.from('swaps').insert({ month_key: k, slot: s, day_a: d, day_b: d2, requester: n, target: other, requester_id: me.id, note: ($('#swNote').value || '').trim() });
    if (error) return toast('Not sent: ' + error.message);
    await loadSwaps(); $('#drawer').classList.remove('open'); render(); toast(`Sent. ${other} will see it next time they sign in; track it on Requests.`); });
}
function swapLine(x) { const k = x.month_key; return `${esc(x.requester)} ${dateLabel(k, x.day_a)} ⇄ ${esc(x.target)} ${dateLabel(k, x.day_b)} <span class="muted small">(${SLOTNAME[x.slot].toLowerCase()})</span>`; }
function residentSwapsHTML() {
  const mine = S.swaps.filter(x => x.requester_id === me.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const forMe = S.swaps.filter(x => x.target_id === me.id && x.status === 'pending');
  const answered = S.swaps.filter(x => x.target_id === me.id && x.status !== 'pending').sort((a, b) => (b.target_at || b.created_at).localeCompare(a.target_at || a.created_at));
  const TGT = { agreed: 'you agreed; waiting on schedulers', declined: 'you declined', approved: 'approved', denied: 'denied by schedulers', withdrawn: 'withdrawn by them', cancelled: 'cancelled (schedule changed)' };
  return `<div class="panel" style="margin-top:14px"><h3>Swaps</h3><p class="small muted">To ask for a trade, click one of your calls on a published Schedule.</p>
    ${forMe.length ? `<h4 style="margin:10px 0 4px">Asked of you</h4><ul class="issues">${forMe.map(x => `<li class="soft">${swapLine(x)}${x.note ? ` · “${esc(x.note)}”` : ''}<div class="row" style="gap:6px;margin-top:6px"><button class="btn primary" data-swyes="${x.id}" style="padding:1px 10px">Agree</button><button class="btn" data-swno="${x.id}" style="padding:1px 10px">Decline</button><input type="text" data-swwhy="${x.id}" placeholder="Reason (optional)" style="flex:1;min-width:160px"></div></li>`).join('')}</ul>` : ''}
    ${answered.length ? `<h4 style="margin:10px 0 4px">You answered</h4><ul class="issues">${answered.map(x => `<li class="${['declined', 'denied', 'cancelled', 'withdrawn'].includes(x.status) ? 'hard' : x.status === 'approved' ? 'ok' : 'soft'}">${swapLine(x)} · <b>${esc(TGT[x.status] || x.status)}</b>${x.status === 'approved' ? ` · you now have ${dateLabel(x.month_key, x.day_a)} instead of ${dateLabel(x.month_key, x.day_b)}` : ''}${x.admin_reason ? ` · schedulers: “${esc(x.admin_reason)}”` : ''}</li>`).join('')}</ul>` : ''}
    <h4 style="margin:10px 0 4px">Yours</h4>${mine.length ? `<ul class="issues">${mine.map(x => `<li class="${['declined', 'denied', 'cancelled'].includes(x.status) ? 'hard' : x.status === 'approved' ? 'ok' : 'soft'}">${swapLine(x)} · <b>${esc(SW_STATUS[x.status])}</b>${x.target_reason ? ` · ${esc(x.target)}: “${esc(x.target_reason)}”` : ''}${x.admin_reason ? ` · schedulers: “${esc(x.admin_reason)}”` : ''}${['pending', 'agreed'].includes(x.status) ? ` <button class="btn" data-swwd="${x.id}" style="float:right;padding:1px 8px">Withdraw</button>` : ''}</li>`).join('')}</ul>` : '<p class="small muted">None yet.</p>'}</div>`;
}
function adminSwapsHTML(k) {
  const agreed = S.swaps.filter(x => x.status === 'agreed'), waiting = S.swaps.filter(x => x.status === 'pending'), done = S.swaps.filter(x => ['approved', 'denied'].includes(x.status)).slice(-8).reverse();
  const check = x => { const st = S.M[x.month_key]; if (!st || !st.A) return 'month not loaded'; const A = st.A; if (A[x.day_a - 1][x.slot] !== x.requester || A[x.day_b - 1][x.slot] !== x.target) return 'schedule changed since they asked';
    const P = E.prepare(buildInput(x.month_key)), base = E.evaluate(P, A), trial = A.map(y => Object.assign({}, y)); trial[x.day_a - 1][x.slot] = x.target; trial[x.day_b - 1][x.slot] = x.requester; const ev = E.evaluate(P, trial);
    if (ev.hard > base.hard) { const before = new Set(base.issues.map(i => i.msg)); const nw = ev.issues.find(i => i.sev === 'hard' && !before.has(i.msg)); return nw ? nw.msg : 'breaks a hard rule'; } return ''; };
  return `<div class="panel" style="margin-top:14px"><h3>Swaps (${agreed.length} to approve)</h3><p class="small muted">Both residents agreed. Approving updates the published schedule right away; the PD isn't involved (SW3).</p>
    ${agreed.length ? `<ul class="issues">${agreed.map(x => { const p = check(x); return `<li class="${p ? 'hard' : 'soft'}"><button class="linkish" data-swcal="${x.id}" title="See the trade on a calendar">${swapLine(x)} 📅</button> · ${esc(monthName(x.month_key))}${x.note ? ` · “${esc(x.note)}”` : ''}<div class="small">${p ? '⛔ ' + esc(p) : '✅ Keeps every hard rule'}</div>
      ${isScheduler() ? `<div class="row" style="gap:6px;margin-top:6px"><button class="btn primary" data-swok="${x.id}" ${p ? 'disabled' : ''} style="padding:1px 10px">Approve</button><button class="btn" data-swden="${x.id}" style="padding:1px 10px">Deny</button><input type="text" data-swdwhy="${x.id}" placeholder="Reason (they'll see it)" style="flex:1;min-width:180px"></div>` : ''}</li>`; }).join('')}</ul>` : '<p class="small muted">Nothing waiting.</p>'}
    ${waiting.length ? `<details><summary class="small">Waiting on the other resident (${waiting.length})</summary><ul class="issues">${waiting.map(x => `<li class="small">${swapLine(x)}</li>`).join('')}</ul></details>` : ''}
    ${done.length ? `<details><summary class="small">Recent decisions</summary><ul class="issues">${done.map(x => `<li class="small">${swapLine(x)} · ${esc(x.status)} by ${esc(whoName(x.decided_by))} · ${esc(whenTxt(x.decided_at))}${x.admin_reason ? ' · “' + esc(x.admin_reason) + '”' : ''}</li>`).join('')}</ul></details>` : ''}</div>`;
}
// ---------- stress test (tester account only; everything stays in memory, nothing is saved) ----------
function stressPanel(k) {
  return `<div class="panel" style="margin-bottom:14px;border:1px dashed var(--line)"><h3 style="margin-top:0">Stress test · ${esc(monthName(k))} <span class="pill neutral">only you see this</span></h3>
    <p class="small muted">Makes fake requests from random residents, accepts them all, builds ${esc(monthName(k))} around them, and reports what the generator honored. Nothing is saved: real requests and the real draft aren't touched.</p>
    <div class="row" style="gap:8px"><label class="small" for="stN">Requests</label><input id="stN" type="number" min="5" max="80" value="25" style="width:5em"><button class="btn primary" id="stRun">Run stress test</button><span class="small muted" id="stMsg"></span></div></div>`;
}
function fakeRequests(k, n) {
  const nd = ndays(k), [y, m] = ym(k), ppl = E.prepare(buildInput(k)).people.filter(p => !p.excluded && p.lvl !== 'F'), out = [];
  const rnd = a => a[Math.floor(Math.random() * a.length)], fris = []; for (let d = 1; d <= nd - 2; d++) if (E.dow(y, m, d) === 5) fris.push(d);
  for (let i = 0; i < n; i++) { const p = rnd(ppl), r = Math.random(); let type, days;
    if (r < .35) { type = 'off'; const f = rnd(fris); days = [f, f + 1, f + 2]; }                       // a weekend off
    else if (r < .6) { type = 'off'; const d = 1 + Math.floor(Math.random() * (nd - 2)); days = Math.random() < .5 ? [d] : [d, d + 1]; }
    else if (r < .78) { type = 'want'; days = [1 + Math.floor(Math.random() * nd)]; }
    else if (r < .9) { type = 'protected'; days = [1 + Math.floor(Math.random() * nd)]; }
    else { type = 'block'; const d = 1 + Math.floor(Math.random() * (nd - 3)); days = [d, d + 1, d + 2]; }
    out.push({ id: -1 - i, month_key: k, resident: p.name, type, days: days.filter(d => d >= 1 && d <= nd), note: 'stress test', status: 'accepted', source: 'resident' }); }
  return out;
}
function runStress(k, n) {
  const fakes = fakeRequests(k, n), keep = S.requests;
  S.requests = keep.concat(fakes);                       // only for building the input below
  let inp; try { inp = buildInput(k); } finally { S.requests = keep; }
  let best = null; for (let i = 0; i < 2; i++) { const r = E.solve(inp, { seed: (Date.now() + i * 7919) % 100000, iters: 30000 }); if (!best || r.ev.cost < best.ev.cost) best = r; }
  const A = best.A, ev = best.ev, on = (n, d) => { const a = A[d - 1]; return !!a && [a.U, a.M, a.I].includes(n); };
  const lockedFor = (n, d) => (inp.locks || []).some(l => l.day === d && l.name === n), lk = (n, ds) => ds.some(d => lockedFor(n, d)) ? ' (locked: holiday list or a pick, so it wins)' : '';
  const res = fakes.map(f => { let ok, why = '';
    if (f.type === 'off' || f.type === 'block') { const hit = f.days.filter(d => on(f.resident, d)); ok = !hit.length; if (!ok) why = 'on call ' + hit.map(d => dateLabel(k, d)).join(', ') + lk(f.resident, hit); }
    else if (f.type === 'want') { ok = f.days.some(d => on(f.resident, d)); if (!ok) why = 'not on call that day'; }
    else { const hit = f.days.filter(d => d > 1 && on(f.resident, d - 1)); ok = !hit.length; if (!ok) why = 'post-call on ' + hit.map(d => dateLabel(k, d)).join(', ') + lk(f.resident, hit.map(d => d - 1)); }
    return Object.assign({ ok, why }, f); });
  return { res, ev, P: E.prepare(inp) };
}
function showStress(k, out) {
  const { res, ev, P } = out, ok = res.filter(r => r.ok).length, st = ev.stats, ppl = P.people.filter(p => !p.excluded);
  const firm = res.filter(r => r.type === 'block' || r.type === 'protected'), firmMiss = firm.filter(r => !r.ok).length;
  const hard = ev.issues.filter(i => i.sev === 'hard'), b2b = ppl.filter(p => st[p.name] && st[p.name].b2b).length, noWk = ppl.filter(p => st[p.name] && st[p.name].wTot && !st[p.name].wOff).length;
  const tgt = ppl.filter(p => st[p.name] && (st[p.name].n < p.tmin || st[p.name].n > p.tmax)).length;
  const label = { off: 'day off', want: 'wants call', protected: 'exam/event', block: 'unavailable' };
  modal(`<div class="row"><h3 style="margin:0">Stress test · ${esc(monthName(k))}</h3><span class="spacer"></span><button class="btn" data-close>Close</button></div>
    <div class="kpis" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0">
      <div class="panel" style="padding:8px"><div class="small muted">Requests honored</div><b style="font-size:20px">${ok}/${res.length}</b> <span class="small">(${Math.round(100 * ok / res.length)}%)</span></div>
      <div class="panel" style="padding:8px"><div class="small muted">Firm ones missed</div><b style="font-size:20px;color:${firmMiss ? 'var(--crit)' : 'inherit'}">${firmMiss}</b> <span class="small">of ${firm.length}</span></div>
      <div class="panel" style="padding:8px"><div class="small muted">Hard-rule breaks</div><b style="font-size:20px;color:${hard.length ? 'var(--crit)' : 'inherit'}">${hard.length}</b></div></div>
    <p class="small">Also: ${tgt} off call target · ${b2b} with back-to-back weekends · ${noWk} with no weekend off.</p>
    ${hard.length ? `<ul class="issues">${hard.slice(0, 6).map(i => `<li class="hard small">${esc(i.msg)}</li>`).join('')}</ul>` : ''}
    <div class="tablewrap" style="max-height:300px;overflow:auto"><table><thead><tr><th></th><th>Resident</th><th>Request</th><th>Days</th><th>Result</th></tr></thead><tbody>
    ${res.sort((a, b) => a.ok - b.ok).map(r => `<tr><td>${r.ok ? '✅' : '❌'}</td><td>${esc(r.resident)}</td><td>${label[r.type]}</td><td>${esc(r.days.join(', '))}</td><td class="small">${r.ok ? 'honored' : esc(r.why)}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted" style="margin-bottom:0">Random requests can clash with each other (two people off the same weekend) or with locked calls and holidays, so a few misses are normal. Firm ones (unavailable, exams) should almost never miss. Run it again for a new random set.</p>`);
}
async function approveSwap(id) {
  const x = S.swaps.find(y => y.id === id), k = x.month_key, st = S.M[k];
  if (st.A[x.day_a - 1][x.slot] !== x.requester || st.A[x.day_b - 1][x.slot] !== x.target) { await sb.from('swaps').update({ status: 'cancelled', decided_by: me.id, decided_at: new Date().toISOString(), admin_reason: 'The schedule changed before approval.' }).eq('id', id); await loadSwaps(); return render(); }
  st.A[x.day_a - 1][x.slot] = x.target; st.A[x.day_b - 1][x.slot] = x.requester; st.locks[x.day_a + '|' + x.slot] = x.target; st.locks[x.day_b + '|' + x.slot] = x.requester;
  logEvent(k, `Swap approved: ${x.requester} ${dateLabel(k, x.day_a)} ⇄ ${x.target} ${dateLabel(k, x.day_b)} (asked by ${x.requester}, agreed by ${x.target})`);
  if (st.status === 'Published') saveVersion('Revised (swap)'); save(k);
  await sb.from('swaps').update({ status: 'approved', decided_by: me.id, decided_at: new Date().toISOString() }).eq('id', id); await loadSwaps(); render(); toast('Swap approved. Both residents will see it at their next sign-in.');
}
// calendar popups for requests and swaps under review
function requestCal(r) {
  const k = r.month_key, st = S.M[k], P = st && st.A ? E.prepare(buildInput(k)) : null, p = P && P.byName[r.resident];
  const calls = st && st.A ? st.A.map((a, i) => [a.U, a.M, a.I].includes(r.resident) ? i + 1 : 0).filter(Boolean) : [];
  const clash = r.type === 'want' ? [] : r.type === 'protected' ? r.days.filter(d => calls.includes(d - 1)) : r.days.filter(d => calls.includes(d));
  const what = { off: 'asks to be off', want: 'asks to be on call', block: 'is unavailable', protected: 'has an exam or event (not post-call)', colorectal: 'big colorectal day' }[r.type] || r.type;
  showImprove({ month: k, t: `${r.resident} ${what}: ${r.days.map(d => dateLabel(k, d)).join(', ')}`, name: r.resident, calls, vac: p ? [...p.vacAll] : [], flag: r.days, flagLabel: 'Requested',
    note: (r.note ? `“${r.note}”. ` : '') + (!st || !st.A ? 'No draft yet for this month, so there are no calls to compare.' : clash.length ? `Right now the draft has them on call ${clash.map(d => dateLabel(k, d)).join(', ')}${r.type === 'protected' ? ' (the night before)' : ''}; accepting and rebuilding should move that.` : r.type === 'want' ? (r.days.some(d => calls.includes(d)) ? 'The draft already has them on call that day.' : 'The draft doesn’t have them on call that day yet.') : 'The current draft already fits this request.') });
}
function swapCal(x) {
  const k = x.month_key, st = S.M[k], P = st && st.A ? E.prepare(buildInput(k)) : null, p = P && P.byName[x.requester];
  const calls = st && st.A ? st.A.map((a, i) => [a.U, a.M, a.I].includes(x.requester) ? i + 1 : 0).filter(Boolean) : [];
  showImprove({ month: k, t: `${x.requester} gives ${dateLabel(k, x.day_a)} to ${x.target}, takes ${dateLabel(k, x.day_b)}`, name: x.requester, calls, vac: p ? [...p.vacAll] : [], flag: [x.day_a, x.day_b], flagLabel: 'The two days being traded',
    note: `${x.requester}'s calendar today. After the trade, ${x.requester} works ${dateLabel(k, x.day_b)} instead of ${dateLabel(k, x.day_a)}; ${x.target} does the opposite.` });
}
function swapNotices() { // shown at sign-in to residents
  const out = [];
  S.swaps.filter(x => x.target_id === me.id && x.status === 'pending').forEach(x => out.push(`🔁 ${x.requester} asked to swap: you'd take ${dateLabel(x.month_key, x.day_a)}, they'd take your ${dateLabel(x.month_key, x.day_b)}. Answer on Requests.`));
  S.swaps.filter(x => x.requester_id === me.id && !x.requester_seen && ['declined', 'denied', 'approved', 'cancelled'].includes(x.status)).forEach(x => out.push(
    x.status === 'declined' ? `❌ ${x.target} declined your swap (${dateLabel(x.month_key, x.day_a)} ⇄ ${dateLabel(x.month_key, x.day_b)})${x.target_reason ? ': “' + x.target_reason + '”' : ''}.`
    : x.status === 'denied' ? `❌ The schedulers denied your swap with ${x.target} (${dateLabel(x.month_key, x.day_a)} ⇄ ${dateLabel(x.month_key, x.day_b)})${x.admin_reason ? ': “' + x.admin_reason + '”' : ''}.`
    : x.status === 'approved' ? `✅ Your swap with ${x.target} is approved: you now have ${dateLabel(x.month_key, x.day_b)} instead of ${dateLabel(x.month_key, x.day_a)}.`
    : `Your swap with ${x.target} was cancelled because the schedule changed.`));
  return out;
}
async function markSwapsSeen() { const ids = S.swaps.filter(x => x.requester_id === me.id && !x.requester_seen && ['declined', 'denied', 'approved', 'cancelled'].includes(x.status)).map(x => x.id); for (const id of ids) await sb.from('swaps').update({ requester_seen: true }).eq('id', id); }
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
    // reason someone can't take a given slot on this day (used by the two-person picker); '' = fine
    const whyOn = (p, slot) => { if (p.excluded) return p.rotation === 'Leave' ? 'on leave' : `on ${p.rotation} (not in pool)`; if (p.out.has(d)) return 'vacation, leave or unavailable';
      const other = slot === 'U' ? a.I : a.U; if (p.name === other) return 'already on this day';
      const near = [d - 1, d + 1].filter(x => x >= 1 && x <= st.A.length && [st.A[x - 1].U, st.A[x - 1].M, st.A[x - 1].I].includes(p.name)); if (near.length) return `on call ${MONTHS[ym(k)[1] - 1]} ${near[0]} (back-to-back)`;
      if (slot === 'U' && (S.rules.noTwoPerson || []).includes(p.name)) return 'not eligible for two-person (H3)'; return ''; };
    CUR.twoPick = () => {
      const ups = P.people.filter(p => p.lvl === 4).map(p => ({ p, why: whyOn(p, 'U') })).sort((x, y) => (!!x.why - !!y.why) || (x.p.name < y.p.name ? -1 : 1));
      const ins = P.people.filter(p => p.lvl === 1).map(p => ({ p, why: p.name === a.I ? '' : whyOn(p, 'I') })).sort((x, y) => (y.p.name === a.I) - (x.p.name === a.I) || (!!x.why - !!y.why) || (x.p.name < y.p.name ? -1 : 1));
      const opt = (c, sel) => `<option value="${esc(c.p.name)}" ${sel ? 'selected' : ''}>${esc(c.p.name)}${c.why ? ' ⛔ ' + esc(c.why) : ''}</option>`;
      const upDef = DATA.pgy[a.U] === 4 ? a.U : (ups.find(c => !c.why) || ups[0] || {}).p?.name;
      modal(`<h3>Two-person call · ${dateLabel(k, d)}</h3><p class="small muted">${DATA.pgy[a.U] === 4 ? '' : `${esc(a.U || 'Nobody')} isn't a PGY-4, so pick who works it. `}${fs ? '<b style="color:var(--crit)">Fri/Sat two-person call breaks H4.</b> ' : ''}Both cells get locked so a rebuild keeps them. ⛔ = breaks a rule; you can still pick it and the cell turns red.</p>
        <label class="small">Upper level (PGY-4)<br><select id="tpU" style="width:100%">${ups.map(c => opt(c, c.p.name === upDef)).join('')}</select></label><br><br>
        <label class="small">Intern<br><select id="tpI" style="width:100%">${ins.map(c => opt(c, c.p.name === a.I)).join('')}</select></label>
        <div class="row" style="margin-top:14px;justify-content:flex-end;gap:8px"><button class="btn" data-close>Cancel</button><button class="btn primary" id="tpGo">Make it two-person</button></div>`, (ov, close) => {
        ov.querySelector('#tpGo').onclick = () => { const U = ov.querySelector('#tpU').value, I = ov.querySelector('#tpI').value; if (!U || !I) return;
          const wU = [fs ? 'two-person on Fri/Sat (H4)' : '', (ups.find(c => c.p.name === U) || {}).why].filter(Boolean).join('; '), wI = (ins.find(c => c.p.name === I) || {}).why || '';
          st.A[d - 1] = Object.assign(st.A[d - 1], { U, M: null, I }); st.flags = st.flags || {};
          [['U', U, wU], ['M', null, fs ? 'two-person on Fri/Sat (H4)' : ''], ['I', I, wI]].forEach(([sl, v, w]) => { st.locks[d + '|' + sl] = v; if (w) st.flags[d + '|' + sl] = w; else delete st.flags[d + '|' + sl]; });
          logEvent(k, `Set ${dateLabel(k, d)} to two-person call: ${U} + ${I}`); save(); close(); $('#drawer').classList.remove('open'); render(); toast(`Two-person call: ${U} + ${I}, locked.`); };
      });
    };
    const fs = [5, 6].includes(E.dow(...ym(k), d)), nt = (S.rules.noTwoPerson || []).includes(a.U), p4 = DATA.pgy[a.U] === 4;
    replaceHTML = `<h3>Replace</h3><p class="small muted">Names in red break a rule that day. You can still pick them; the cell turns red so it's obvious. The rule check catches anything else.</p><div style="display:grid;gap:6px">${cands.map(c => `<button class="opt ${c.p.name === curN ? 'cur' : ''}" data-pick="${esc(c.p.name)}" data-why="${esc(c.why)}" ${hol ? 'disabled' : ''} style="${c.why ? 'border-color:var(--crit);background:var(--crit-bg)' : ''}"><span>${esc(c.p.name)} <span class="why">${LEVEL(c.p.name)} · ${esc(c.p.rotation)}</span></span><span class="why">${c.why ? esc(c.why) : c.n + ' calls'}</span></button>`).join('')}
    ${s === 'M' && !hol ? `<button class="opt" ${p4 && !nt && !fs ? 'data-pick=""' : 'data-two="1"'} style="${fs ? 'border-color:var(--crit);background:var(--crit-bg)' : ''}"><span>Make it two-person call</span><span class="why">${fs ? 'breaks H4 (Fri/Sat), pick who works it' : !p4 ? 'no PGY-4 on, pick who works it' : nt ? a.U + ' not eligible (H3), pick who works it' : 'PGY-4 + intern'}</span></button>` : ''}</div>
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
  $('#drawer').querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { const v = b.dataset.pick || null; st.A[d - 1][s] = v; st.locks[d + '|' + s] = v; st.flags = st.flags || {}; if (b.dataset.why) st.flags[d + '|' + s] = b.dataset.why; else delete st.flags[d + '|' + s]; logEvent(k, `Set ${dateLabel(k, d)} ${SLOTNAME[s].toLowerCase()} to ${v || 'two-person call'}`); save(); $('#drawer').classList.remove('open'); render(); });
  $('#drawer').querySelectorAll('[data-two]').forEach(b => b.onclick = () => CUR.twoPick());
  $('#drawer').querySelectorAll('[data-swap]').forEach(b => b.onclick = () => { const d2 = +b.dataset.swap, other = st.A[d2 - 1][s]; st.A[d2 - 1][s] = curN; st.A[d - 1][s] = other; if (st.flags) { delete st.flags[d + '|' + s]; delete st.flags[d2 + '|' + s]; } st.locks[d + '|' + s] = other; st.locks[d2 + '|' + s] = curN; logEvent(k, `Swap approved: ${curN} ${dateLabel(k, d)} ⇄ ${other} ${dateLabel(k, d2)}`); if (st.status === 'Published') saveVersion('Revised (swap)'); save(); $('#drawer').classList.remove('open'); render(); toast('Swap done and logged.'); });
  const lk = $('#dLock'); if (lk) lk.onchange = e => { if (e.target.checked) st.locks[d + '|' + s] = st.A[d - 1][s]; else delete st.locks[d + '|' + s]; save(); render(); };
}


// ---------- people (admins) ----------
let PEOPLE = null, peopleMsg = '';
async function loadPeople() { const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'list' } }); if (error || (data && data.error)) { peopleMsg = 'Could not load accounts: ' + ((data && data.error) || error.message); PEOPLE = []; } else PEOPLE = data.users; if (route() === 'people') render(); }
function viewPeople() {
  if (!adminView()) return '<div class="panel">Only admins manage accounts.</div>';
  if (PEOPLE === null) { loadPeople(); return '<div class="panel">Loading accounts…</div>'; }
  const ROLES = [['scheduler', 'Scheduler (PGY-4)'], ['chief', 'PGY-5 chief (same powers as scheduler)'], ['pd', 'Program director'], ['resident', 'Resident']];
  return `<div class="row"><h2>People</h2><span class="muted small">Admins add people by name and email. Each person picks their own username and password from the link they get.</span></div>
  ${peopleMsg ? `<div class="banner">${esc(peopleMsg)}</div>` : ''}
  <div class="grid2"><div class="panel"><div class="tablewrap"><table><thead><tr><th>Name</th><th>Roster name</th><th>Username</th><th>Email</th><th>Role</th><th>Admin</th><th>Active</th><th></th></tr></thead><tbody>
  ${PEOPLE.map(p => `<tr><td>${esc(p.display_name)}</td><td><select class="f" data-proster="${p.id}" aria-label="Roster name for ${esc(p.display_name)}"><option value="">—</option>${ROSTER_NAMES().map(n => `<option ${n === p.roster_name ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></td><td>${p.username ? esc(p.username) : '<span class="muted">not picked yet</span>'}</td><td class="small">${/@no-email\.example\.com$/.test(p.email || '') ? '<span class="muted">no email</span>' : esc(p.email || '')}${p.confirmed ? '' : ' <span class="pill warn">no password yet</span>'}</td>
    <td><select class="f" data-prole="${p.id}" ${p.id === me.id ? 'disabled' : ''} aria-label="Role for ${esc(p.display_name)}">${ROLES.map(([v, l]) => `<option value="${v}" ${v === p.role ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
    <td><input type="checkbox" data-padmin="${p.id}" ${p.is_admin ? 'checked' : ''} ${p.id === me.id || p.role !== 'resident' ? 'disabled' : ''} aria-label="Admin" title="${p.role !== 'resident' ? 'Schedulers, chiefs and the PD are always admins' : ''}"></td>
    <td><input type="checkbox" data-pactive="${p.id}" ${p.active ? 'checked' : ''} ${p.id === me.id ? 'disabled' : ''} aria-label="Active"></td>
    <td style="white-space:nowrap"><button class="btn" data-plink="${p.id}" style="padding:1px 8px">${p.confirmed ? 'Reset link' : 'Setup link'}</button> ${p.id === me.id ? '' : `<button class="btn" data-pdel="${p.id}" style="padding:1px 8px;color:var(--crit)">Delete</button>`}</td></tr>`).join('')}
  </tbody></table></div><p class="small muted">Unchecking Active blocks sign-in but keeps the account (best for someone on leave). Delete removes the account for good; their past schedules, requests and log entries stay. You can't change or delete your own account, so nobody locks themselves out.</p></div>
  <div class="panel"><h3>Add a person</h3><div class="kv small">
    <label for="nName">Full name</label><input id="nName" type="text" placeholder="Jane Doe">
    <label for="nEmail">Email</label><input id="nEmail" type="text" placeholder="optional if you copy the link instead">
    <label for="nRoster">Roster name</label><select id="nRoster" class="f"><option value="">— (PD or not on the call roster)</option>${ROSTER_NAMES().map(n => `<option>${esc(n)}</option>`).join('')}</select>
    <label for="nRole">Role</label><select id="nRole" class="f">${ROLES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    <label for="nAdmin">Admin</label><input id="nAdmin" type="checkbox" style="justify-self:start;width:auto;margin:0"></div>
    <label class="row small" style="margin-top:8px"><input type="checkbox" id="nSend" checked> Email them the setup link to pick a username and password (uncheck to copy the link and text it instead)</label>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="nAdd">Add person</button></div>
    <div id="linkOut" class="small" style="margin-top:8px;word-break:break-all"></div></div></div>
  ${rosterPanel()}`;
}
const PGYS = [['1', 'PGY-1'], ['2', 'PGY-2'], ['3', 'PGY-3'], ['4', 'PGY-4'], ['5', 'PGY-5'], ['F', 'Fellow']];
function rosterPanel() {
  const ed = isScheduler(), names = ROSTER_NAMES();
  return `<div class="panel" style="margin-top:14px"><h3>Call roster (${names.length})</h3><p class="small muted">Who's on this year's schedules. This is separate from accounts: the roster is who gets scheduled; accounts are who can sign in. Removing someone takes them off upcoming months that aren't published yet. Past months and history keep them.${ed ? '' : ' A scheduler or chief edits the roster.'}</p>
    <div class="tablewrap"><table style="max-width:560px"><thead><tr><th>Roster name</th><th>Level</th><th></th></tr></thead><tbody>
    ${names.map(n => `<tr><td>${esc(n)}</td><td><select class="f" data-rpgy="${esc(n)}" ${ed ? '' : 'disabled'} aria-label="${esc(n)} level">${PGYS.map(([v, l]) => `<option value="${v}" ${String(DATA.pgy[n]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td><td>${ed ? `<button class="btn" data-rrm="${esc(n)}" style="padding:1px 8px">Remove</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    ${ed ? `<h3 style="margin-top:14px">Add to the roster</h3><div class="kv small" style="max-width:560px"><label for="rnName">Roster name</label><input id="rnName" type="text" placeholder="first name as it appears on the schedule">
      <label for="rnPgy">Level</label><select id="rnPgy" class="f">${PGYS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <label for="rnFrom">Starting</label><select id="rnFrom" class="f">${KEYS.map(k => `<option value="${k}">${monthName(k)}</option>`).join('')}</select>
      <label for="rnRot">Rotation</label><select id="rnRot" class="f">${ROTATIONS.map(r => `<option>${r}</option>`).join('')}</select></div>
      <p class="small muted">They get that rotation for every month from then on; fix individual months on the Inputs tab.</p>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="rnAdd">Add to roster</button></div>` : ''}</div>`;
}
async function saveRoster(msg) { const { error } = await sb.from('reference').update({ value: DATA }).eq('key', 'data'); if (error) return toast('Roster not saved: ' + error.message); toast(msg); }
// readable errors from the server functions instead of "non-2xx status code"
async function fnError(error, data) { if (data && data.error) return data.error; let msg = error && error.message; try { const r = error && error.context; if (r && r.status === 401) return 'Your sign-in ended (maybe another tab signed out or switched accounts). Reload and sign in again.'; const j = r && await r.json(); if (j && j.error) msg = j.error; } catch (e) {} return msg || 'Something went wrong.'; }
async function peopleAction(body, okMsg) { const { data, error } = await sb.functions.invoke('admin-users', { body }); if (error || (data && data.error)) { toast(await fnError(error, data)); return null; } if (okMsg) toast(okMsg); return data; }
function wirePeople() {
  document.querySelectorAll('[data-pdel]').forEach(el => el.onclick = async () => {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Delete forever?'; el.style.fontWeight = '700'; setTimeout(() => { if (el.isConnected) { el.dataset.armed = ''; el.textContent = 'Delete'; el.style.fontWeight = ''; } }, 5000); return; }
    const d = await peopleAction({ action: 'delete', id: el.dataset.pdel }, 'Account deleted.'); if (d) { PEOPLE = null; render(); } });
  document.querySelectorAll('[data-rpgy]').forEach(el => el.onchange = async () => { const n = el.dataset.rpgy; DATA.pgy[n] = el.value === 'F' ? 'F' : +el.value; await saveRoster(`${n} is now ${el.value === 'F' ? 'a fellow' : 'PGY-' + el.value}.`); logEvent(S.month, `Roster: ${n} level → ${el.value}`); render(); });
  document.querySelectorAll('[data-rrm]').forEach(el => el.onclick = async () => {
    const n = el.dataset.rrm; if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Remove ' + n + '?'; setTimeout(() => { if (el.isConnected) { el.dataset.armed = ''; el.textContent = 'Remove'; } }, 5000); return; }
    KEYS.forEach(k => { if (S.M[k] && S.M[k].status === 'Published') return; delete DATA.rotations[k][n]; if (S.M[k]) { delete S.M[k].inputs[n]; if (existing.has(k)) save(k); } });
    await saveRoster(`${n} removed from upcoming months.`); logEvent(S.month, `Roster: removed ${n}`); render(); });
  const rnAdd = $('#rnAdd'); if (rnAdd) rnAdd.onclick = (async () => { const n = ($('#rnName').value || '').trim(); if (!/^[A-Za-z][A-Za-z' -]{1,30}$/.test(n)) return toast('Use their first name as it appears on the schedule.'); if (ROSTER_NAMES().includes(n)) return toast(n + ' is already on the roster.');
    const v = $('#rnPgy').value, from = $('#rnFrom').value, rot = $('#rnRot').value; DATA.pgy[n] = v === 'F' ? 'F' : +v;
    KEYS.filter(k => k >= from).forEach(k => { if (S.M[k] && S.M[k].status === 'Published') return; DATA.rotations[k][n] = { rotation: rot, vac_txt: null }; if (S.M[k]) { S.M[k].inputs[n] = { rotation: rot, vac: '', picks: '' }; if (existing.has(k)) save(k); } });
    await saveRoster(`${n} added from ${monthName(from)}.`); logEvent(S.month, `Roster: added ${n} (${v === 'F' ? 'fellow' : 'PGY-' + v})`); render(); });
  document.querySelectorAll('[data-proster]').forEach(el => el.onchange = async () => { await peopleAction({ action: 'update', id: el.dataset.proster, roster_name: el.value || null }, 'Roster name updated.'); loadPeople(); });
  document.querySelectorAll('[data-prole]').forEach(el => el.onchange = async () => { await peopleAction({ action: 'update', id: el.dataset.prole, role: el.value }, 'Role updated.'); loadPeople(); });
  document.querySelectorAll('[data-padmin]').forEach(el => el.onchange = async () => { await peopleAction({ action: 'update', id: el.dataset.padmin, is_admin: el.checked }, 'Admin updated.'); loadPeople(); });
  document.querySelectorAll('[data-pactive]').forEach(el => el.onchange = async () => { await peopleAction({ action: 'update', id: el.dataset.pactive, active: el.checked }, el.checked ? 'Account turned back on.' : 'Account turned off.'); loadPeople(); });
  document.querySelectorAll('[data-plink]').forEach(el => el.onclick = async () => { const d = await peopleAction({ action: 'link', id: el.dataset.plink }); if (d && d.link) showLink(d.link); });
  const add = $('#nAdd'); if (add) add.onclick = async () => {
    const body = { action: 'create', roster_name: $('#nRoster').value || null, display_name: $('#nName').value.trim(), email: $('#nEmail').value.trim(), role: $('#nRole').value, is_admin: $('#nAdmin').checked, send_email: $('#nSend').checked };
    if (!body.display_name) return toast('Add their name.'); if (!body.email && body.send_email) return toast('No email: uncheck “Email them the setup link” and copy the link instead.');
    const d = await peopleAction(body, body.send_email ? 'Added. They’ll get an email to pick their username and password.' : 'Added. Copy the link below and send it to them.');
    if (d) { PEOPLE = null; render(); if (d.link) showLink(d.link); }
  };
}
function showLink(link) {
  const ov = document.createElement('div'); ov.className = 'modal-ov';
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="One-time setup link"><div class="row"><h3 style="margin:0">One-time link</h3><span class="spacer"></span><button class="btn" id="lkClose">Close</button></div>
    <p class="small muted" style="margin:6px 0 10px">Send this to the person, or open it yourself in a private window to set up a test account. It works once and expires in 24 hours.</p>
    <textarea id="lkText" readonly rows="4" style="width:100%;font-size:12px;word-break:break-all">${esc(link)}</textarea>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="lkCopy">Copy link</button><span class="small muted" id="lkMsg"></span></div></div>`;
  document.body.appendChild(ov);
  const ta = ov.querySelector('#lkText'); ta.focus(); ta.select();
  const close = () => { ov.remove(); document.removeEventListener('keydown', k_); }; const k_ = e => { if (e.key === 'Escape') close(); };
  ov.onclick = e => { if (e.target === ov) close(); }; ov.querySelector('#lkClose').onclick = close; document.addEventListener('keydown', k_);
  ov.querySelector('#lkCopy').onclick = async () => { ta.select(); let ok = false; try { await navigator.clipboard.writeText(link); ok = true; } catch (e) { try { ok = document.execCommand('copy'); } catch (e2) {} }
    ov.querySelector('#lkMsg').textContent = ok ? 'Copied.' : 'Copy blocked here: the link is selected, press Cmd+C.'; };
}

// ---------- router ----------
const VIEWS = { people: viewPeople, schedule: viewSchedule, inputs: viewInputs, dashboard: viewDashboard, history: viewHistory, notes: viewNotes, rules: viewRules, approval: viewApproval };
function route() { const h = location.hash.slice(1); return VIEWS[h] ? h : 'schedule'; }
// Make the signed-in person's own name stand out everywhere it appears (calendar, rounding, tables, dashboard).
const MY_NAME = (() => { if (CTX.profile.roster_name) return CTX.profile.roster_name; const dn = String(CTX.profile.display_name || '').trim().toLowerCase(), first = dn.split(/\s+/)[0];
  const names = Object.keys(DATA.pgy || {}); const nick = DATA.nicknameOf || {}; return names.find(n => n.toLowerCase() === dn) || names.find(n => n.toLowerCase() === first) || names.find(n => (nick[n] || '').toLowerCase() === first) || null; })();
function highlightMe(root) {
  if (!MY_NAME || !root) return;
  const full = String(CTX.profile.display_name || '').trim(), alts = [...new Set([full.split(/\s+/).length > 1 ? full : null, MY_NAME].filter(Boolean))].sort((x, y) => y.length - x.length);
  const re = new RegExp('\\b(?:' + alts.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|') + ')\\b');
  const skip = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'MARK']);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.parentElement && !skip.has(n.parentElement.tagName) && !n.parentElement.closest('select,textarea') && re.test(n.nodeValue)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  const hits = []; while (w.nextNode()) hits.push(w.currentNode);
  hits.forEach(t => { const parts = t.nodeValue.split(new RegExp('(' + re.source + ')')); const frag = document.createDocumentFragment();
    parts.forEach(s => { if (s && re.test(s) && alts.some(x => new RegExp('^' + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '$').test(s))) { const m = document.createElement('mark'); m.className = 'me'; m.textContent = s; frag.appendChild(m); } else if (s) frag.appendChild(document.createTextNode(s)); });
    t.parentNode.replaceChild(frag, t); });
  root.querySelectorAll('mark.me').forEach(m => { const c = m.closest('.chip'); if (c) c.classList.add('has-me'); });
}
const ADMIN_TABS = ['inputs', 'dashboard', 'rules', 'people'];
const TAB_ORDER = { default: ['schedule', 'notes', 'approval', 'inputs', 'dashboard', 'history', 'rules', 'people'], 'Program Director': ['schedule', 'approval', 'inputs', 'dashboard', 'notes', 'history', 'rules', 'people'] };
function orderTabs() { const nav = document.querySelector('nav.tabs'); if (!nav) return; (TAB_ORDER[S.role] || TAB_ORDER.default).forEach(t => { const el = nav.querySelector(`a[href="#${t}"]`); if (el) nav.appendChild(el); }); }
function render() {
  let r = route(); orderTabs();
  { const nb = S.swaps.filter(x => (x.target_id === me.id && x.status === 'pending') || (adminView() && x.status === 'agreed')).length + (adminView() ? S.requests.filter(q => q.status === 'pending').length : 0); const t = document.querySelector('nav.tabs a[href="#notes"]'); if (t) t.innerHTML = 'Requests' + (nb ? ` <span class="badge">${nb}</span>` : ''); }
  if (ADMIN_TABS.includes(r) && !adminView()) { r = 'schedule'; history.replaceState(null, '', '#schedule'); }
  document.querySelectorAll('nav.tabs a').forEach(a => { const t = a.getAttribute('href').slice(1); if (ADMIN_TABS.includes(t)) a.hidden = !adminView(); });
  const pv = $('#previewNote'); if (pv) pv.hidden = !(S.isAdmin && roleKey(S.role) !== S.realRole);
  document.querySelectorAll('nav.tabs a').forEach(a => a.setAttribute('aria-current', a.getAttribute('href') === '#' + r ? 'page' : 'false'));
  if (cur().A && !['schedule', 'dashboard'].includes(r)) evaluateNow();
  $('#main').innerHTML = VIEWS[r](); wire(); highlightMe($('#main'));
  if (r === 'schedule' && !cur().A && isScheduler() && !cur()._auto) { cur()._auto = true; generate(false); }
}
function wire() {
  const st = cur(), k = S.month;
  wirePeople();
  const on = (sel, f) => { const el = $(sel); if (el) el.onclick = f; };
  const mt = $('#mineT'); if (mt) mt.onchange = () => { MINE = mt.checked; try { localStorage.setItem('gs-mine', MINE ? '1' : '0'); } catch (e) {} render(); };
  document.querySelectorAll('[data-jump]').forEach(el => el.onclick = e => { e.preventDefault(); const t = document.getElementById(el.dataset.jump); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  document.querySelectorAll('[data-rc]').forEach(el => el.onclick = () => showRuleCheck(el.dataset.rc));
  document.querySelectorAll('[data-why]').forEach(el => el.onclick = e => { e.stopPropagation(); toast('⛔ ' + el.dataset.why); });
  document.querySelectorAll('[data-rx]').forEach(el => el.onclick = () => { const [ref, b, i] = el.dataset.rx.split('|'); const list = (CUR.rb[+ref].blocks[b] || []).slice(); list.splice(+i, 1); setRnd(+ref, b, list); });
  document.querySelectorAll('[data-ra]').forEach(el => el.onchange = () => { if (!el.value) return; const [ref, b] = el.dataset.ra.split('|'); const list = (CUR.rb[+ref].blocks[b] || []).concat(el.value); setRnd(+ref, b, list); });
  document.querySelectorAll('[data-rreset]').forEach(el => el.onclick = () => { const st2 = cur(); delete st2.rndEdit[el.dataset.rreset]; logEvent(S.month, 'Reset rounding edits'); save(); render(); });
  document.querySelectorAll('[data-statv]').forEach(b => b.onclick = () => { STATV = b.dataset.statv; try { localStorage.setItem('gs-statv', STATV); } catch (e) {} render(); });
  document.querySelectorAll('[data-imp]').forEach(el => el.onclick = () => showImprove(IMPROVE[+el.dataset.imp]));
  on('#fresh', () => generate(false)); on('#regen', () => generate(true)); on('#pdf', downloadPDF);
  on('#swapX', () => { S.trioSwap.xmas = !S.trioSwap.xmas; logEvent(k, 'Swapped which Christmas trio starts'); generate(true); });
  on('#swapN', () => { S.trioSwap.ny = !S.trioSwap.ny; logEvent(k, 'Swapped which New Year trio starts (January follows)'); generate(true); });
  document.querySelectorAll('.cal .chip:not([disabled])').forEach(b => b.onclick = () => b.dataset.k && b.dataset.k !== S.month ? (() => { S.month = b.dataset.k; $('#monthSel').value = S.month; S.proposals = []; render(); openDrawer(+b.dataset.d, b.dataset.s); toast(`Switched to ${monthName(S.month)} to edit.`); })() : adminView() ? openDrawer(+b.dataset.d, b.dataset.s) : openSwapAsk(+b.dataset.d, b.dataset.s));
  document.querySelectorAll('[data-hm]').forEach(b => b.onclick = () => { S.histMonth = b.dataset.hm; render(); });
  document.querySelectorAll('[data-btd]').forEach(el => el.onclick = () => { const [m, side, key, label] = el.dataset.btd.split('|'); const L = btDetail(+m)[side][key + 'L'];
    modal(`<h3>${esc(label)} · ${MONTHS_LONG[m - 1]} ${side === 'actual' ? 'as published' : 'engine version'} (${L.length})</h3>${L.length ? `<ul class="issues">${L.map(t => `<li class="small">${esc(t)}</li>`).join('')}</ul>` : '<p class="small muted">None.</p>'}<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" data-close>Close</button></div>`); });
  document.querySelectorAll('[data-hver]').forEach(b => b.onclick = () => { S.histVer = +b.dataset.hver; S.histVerKey = S.histMonth; render(); });
  document.querySelectorAll('[data-in]').forEach(i => i.onchange = () => { st.inputs[i.dataset.n][i.dataset.in] = i.value.trim(); logEvent(k, `Input: ${i.dataset.n} ${i.dataset.in} = ${i.value.trim() || '(none)'}`); save(); });
  document.querySelectorAll('[data-lv]').forEach(i => i.onchange = () => { const n = i.dataset.n, f = i.dataset.lv; S.people[n] = S.people[n] || {}; S.people[n][f] = i.type === 'checkbox' ? i.checked : i.value; if (f !== 'leaveConfirmed') S.people[n].leaveConfirmed = false; logEvent(k, `Leave: ${n} ${f} = ${i.type === 'checkbox' ? i.checked : i.value}`); save(); render(); });
  on('#inputsApply', () => { location.hash = 'schedule'; generate(true); });
  on('#interpret', interpret);
  const notes = $('#notes'); if (notes) notes.oninput = () => { S.notes[k] = notes.value; saveNotes(k); };
  document.querySelectorAll('[data-qcal]').forEach(b => b.onclick = () => requestCal(S.requests.find(x => x.id === +b.dataset.qcal)));
  document.querySelectorAll('[data-swcal]').forEach(b => b.onclick = () => swapCal(S.swaps.find(x => x.id === +b.dataset.swcal)));
  document.querySelectorAll('[data-qacc]').forEach(b => b.onclick = async () => { const r = S.requests.find(x => x.id === +b.dataset.qacc); await setRequest(r.id, { status: 'accepted', decided_by: me.id, decided_at: new Date().toISOString(), reason: '' }); logEvent(k, `Accepted ${r.resident}'s request`); render(); askRebuild(r.month_key); });
  document.querySelectorAll('[data-qden]').forEach(b => b.onclick = async () => { const r = S.requests.find(x => x.id === +b.dataset.qden); const why = (document.querySelector(`[data-qwhy="${r.id}"]`) || {}).value || ''; await setRequest(r.id, { status: 'denied', decided_by: me.id, decided_at: new Date().toISOString(), reason: why.trim() }); logEvent(k, `Denied ${r.resident}'s request`); render(); });
  const swUpd = async (id, patch, msg) => { const { error } = await sb.from('swaps').update(patch).eq('id', id); if (error) return toast('Not saved: ' + error.message); await loadSwaps(); render(); if (msg) toast(msg); };
  document.querySelectorAll('[data-swyes]').forEach(b => b.onclick = () => swUpd(+b.dataset.swyes, { status: 'agreed', target_reason: '' }, 'Agreed. It goes to the schedulers to approve.'));
  document.querySelectorAll('[data-swno]').forEach(b => b.onclick = () => swUpd(+b.dataset.swno, { status: 'declined', target_reason: ((document.querySelector(`[data-swwhy="${b.dataset.swno}"]`) || {}).value || '').trim() }, 'Declined. They’ll be told next time they sign in.'));
  document.querySelectorAll('[data-swwd]').forEach(b => b.onclick = () => swUpd(+b.dataset.swwd, { status: 'withdrawn' }, 'Withdrawn.'));
  document.querySelectorAll('[data-swok]').forEach(b => b.onclick = () => approveSwap(+b.dataset.swok));
  document.querySelectorAll('[data-swden]').forEach(b => b.onclick = () => swUpd(+b.dataset.swden, { status: 'denied', decided_by: me.id, decided_at: new Date().toISOString(), admin_reason: ((document.querySelector(`[data-swdwhy="${b.dataset.swden}"]`) || {}).value || '').trim() }, 'Denied. The requester will be told.'));
  const stRun = $('#stRun'); if (stRun) stRun.onclick = () => { const n = Math.max(5, Math.min(80, +$('#stN').value || 25)); stRun.disabled = true; $('#stMsg').textContent = 'Building… (about 10 seconds)';
    setTimeout(() => { try { showStress(S.month, runStress(S.month, n)); } catch (e) { toast('Stress test failed: ' + e.message); } stRun.disabled = false; $('#stMsg').textContent = ''; }, 50); };
  document.querySelectorAll('[data-qwd]').forEach(b => b.onclick = async () => { await dropRequest(+b.dataset.qwd); render(); });
  on('#qSend', async () => { const mk = $('#qMonth').value, days = parseDays($('#qDays').value, ndays(mk)); if (!days.length) return toast('Add the day numbers, e.g. 11-13.');
    const r = await addRequest({ month_key: mk, resident: CTX.profile.roster_name || MY_NAME, type: $('#qType').value, days, note: $('#qNote').value.trim(), status: 'pending', source: 'resident', created_by: me.id });
    if (r) { logEvent(mk, `Request sent (${r.type}, ${days.join(', ')})`); toast('Request sent. You’ll see the decision here.'); render(); } });
  on('#qClaude', async () => { const txt = ($('#qText').value || '').trim(); if (!txt) return; const mk = $('#qMonth').value, [y, m] = ym(mk), who = CTX.profile.roster_name || MY_NAME; const btn = $('#qClaude'); btn.disabled = true; btn.textContent = 'Reading…';
    const prompt = `Turn one resident's call-schedule request into JSON. Month: ${MONTHS_LONG[m - 1]} ${y} (day 1 is a ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][E.dow(y, m, 1)]}; ${ndays(mk)} days). Types: "off" = would like not to be on call (best effort), "want" = wants call, "block" = firmly unavailable (leave, away), "protected" = exam or event, must not be post-call. A weekend off means Fri, Sat and Sun. Return JSON only: {"type":"off|want|block|protected","days":[<ints>],"note":"<short>"}.\nRequest: ${txt}`;
    try { const { data: v, error } = await sb.functions.invoke('interpret-notes', { body: { prompt } }); if (error || (v && v.error)) throw new Error(await fnError(error, v)); const r = (v && v.rules && v.rules[0]) || v || {};
      if (r.type) $('#qType').value = r.type; if (Array.isArray(r.days)) $('#qDays').value = r.days.filter(d => d >= 1 && d <= ndays(mk)).join(', '); if (r.note || r.reason) $('#qNote').value = r.note || r.reason; toast(`Filled in for ${who}. Check it, then send.`); }
    catch (e) { toast('Claude couldn’t read that: ' + ((e && e.message) || 'error')); }
    btn.disabled = false; btn.textContent = 'Fill in with Claude'; });
  document.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => { const c = S.proposals.splice(+b.dataset.acc, 1)[0]; delete c.problem; await addRequest({ month_key: k, resident: c.name, type: c.type, days: c.days, note: c.reason || '', status: 'accepted', source: S.role === 'Program Director' ? 'pd' : 'claude', created_by: me.id, decided_by: me.id, decided_at: new Date().toISOString() }); askRebuild(k); logEvent(k, 'Accepted rule: ' + describe(c)); save(); render(); });
  document.querySelectorAll('[data-rej]').forEach(b => b.onclick = () => { S.proposals.splice(+b.dataset.rej, 1); render(); });
  document.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { const c = cons(k).find(x => x.id === +b.dataset.rm); if (!c) return; if (c.source === 'resident') await setRequest(c.id, { status: 'denied', reason: 'Removed by a scheduler', decided_by: me.id, decided_at: new Date().toISOString() }); else await dropRequest(c.id); logEvent(k, 'Removed rule: ' + describe(c)); save(); render(); });
  on('#applyNotes', () => { location.hash = 'schedule'; generate(true); });
  on('#addManual', async () => { const c = { type: $('#mType').value, name: $('#mName').value, days: parseDays($('#mDays').value, ndays(k)), reason: $('#mWhy').value.trim() }; if (!c.days.length) return toast('Add at least one day, like 16 or 11-13.'); await addRequest({ month_key: k, resident: c.name, type: c.type, days: c.days, note: c.reason, status: 'accepted', source: S.role === 'Program Director' ? 'pd' : 'admin', created_by: me.id, decided_by: me.id, decided_at: new Date().toISOString() }); logEvent(k, 'Added rule: ' + describe(c)); save(); render(); askRebuild(k); });
  document.querySelectorAll('[data-t]').forEach(i => i.onchange = () => { S.rules.targets[i.dataset.t][+i.dataset.i] = Math.max(0, +i.value || 0); save(); });
  const num = (id, kk) => { const el = $(id); if (el) el.onchange = () => { S.rules[kk] = +el.value; save(); }; };
  num('#rCap', 'fellowCap'); num('#rQ2', 'maxQ2Run'); num('#rHrs', 'callHours');
  const ss = $('#rSS'); if (ss) ss.onchange = () => { S.rules.sameServiceBlocked = ss.checked; save(); };
  document.querySelectorAll('[data-ntp]').forEach(i => i.onchange = () => { const n = i.dataset.ntp; S.rules.noTwoPerson = (S.rules.noTwoPerson || []).filter(x => x !== n); if (i.checked) S.rules.noTwoPerson.push(n); logEvent(k, `${n} ${i.checked ? 'not eligible' : 'eligible again'} for two-person call`); save(); });
  on('#rulesApply', () => { logEvent(k, 'Changed rule settings'); location.hash = 'schedule'; generate(true); });
  on('#saveVer', () => { saveVersion(st.status); logEvent(k, 'Saved a version'); save(); render(); toast('Version saved.'); });
  on('#toPD', () => { const ev = CUR.ev; const hard = ev.issues.filter(i => i.sev === 'hard').length; const est = Object.keys(CUR.est).length; if (hard) return toast(`Fix the ${hard} hard-rule break(s) first.`); if (est && !confirmInline()) return; st.status = 'PD review'; saveVersion('Sent to PD'); logEvent(k, 'Sent to the PD for approval' + (est ? ` with ${est} call(s) on unconfirmed dates` : '')); save(); render(); });
  on('#approveHold', () => { st.status = 'Approved'; saveVersion('Approved'); logEvent(k, 'PD approved; sent to schedulers to publish' + ($('#pdNote').value ? ': ' + $('#pdNote').value : '')); save(); render(); });
  on('#publish', () => { st.status = 'Published'; saveVersion('Published'); logEvent(k, 'Published'); save(); render(); toast('Published. Residents see it now.'); });
  on('#unapprove', () => { st.status = 'Scheduler review'; logEvent(k, 'Reopened after PD approval (needs PD review again)'); save(); render(); });
  on('#approve', () => { st.status = 'Published'; saveVersion('Approved'); logEvent(k, 'Approved and published' + ($('#pdNote').value ? ': ' + $('#pdNote').value : '')); save(); render(); });
  on('#sendBack', () => { st.status = 'Scheduler review'; logEvent(k, 'Sent back' + ($('#pdNote').value ? ': ' + $('#pdNote').value : '')); save(); render(); });
  on('#revise', () => { st.status = 'Scheduler review'; logEvent(k, 'Started a revised version'); save(); render(); });
  on('#copyTxt', async () => { try { await navigator.clipboard.writeText(scheduleText()); toast('Copied. Paste it into a text or email.'); } catch (e) { toast('Copy was blocked here.'); } });
  document.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => { const v = st.versions.find(v => v.n === +b.dataset.restore); if (v) { st.A = v.A.map(([U, M, I]) => ({ U, M, I })); logEvent(k, 'Restored v' + v.n); save(); render(); } });
}
let estConfirmArmed = false;
function confirmInline() { if (estConfirmArmed) { estConfirmArmed = false; return true; } estConfirmArmed = true; toast('Some calls depend on unconfirmed dates (⚠). Click Send again to send anyway.'); setTimeout(() => estConfirmArmed = false, 6000); return false; }
const rs = $('#roleSel'); if (rs && CTX.profile.can_preview) { rs.value = S.role; rs.onchange = e => { S.role = e.target.value; render(); }; }
function fillMonths() { const ks = S.isAdmin ? KEYS : KEYS.filter(k => S.M[k].A); $('#monthSel').innerHTML = (ks.length ? ks : [S.month]).map(k => `<option value="${k}" ${k === S.month ? 'selected' : ''}>${monthName(k)}</option>`).join(''); }
fillMonths();
$('#monthSel').onchange = e => { S.month = e.target.value; S.proposals = []; render(); };
window.addEventListener('hashchange', () => { $('#drawer').classList.remove('open'); render(); });
// Residents only ever see published schedules (current and past). Drafts never reach their browser.
async function loadPublished() {
  KEYS.forEach(k => { const st = S.M[k]; st.A = null; st.rnd = null; st.status = 'Draft'; });
  const [{ data: pub }, { data: stat }] = await Promise.all([sb.from('published').select('*'), sb.from('month_status').select('*')]);
  (stat || []).forEach(r => { if (S.M[r.key]) S.M[r.key].status = r.status; });
  (pub || []).forEach(r => { const st = S.M[r.month_key]; if (!st) return; st.A = r.schedule.map(([U, M, I]) => ({ U, M, I })); st.rnd = r.rnd; st.pubVersion = r.version; st.publishedAt = r.published_at; });
  const today = new Date(), curKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
  const have = KEYS.filter(k => S.M[k].A); S.month = have.includes(curKey) ? curKey : have.find(k => k > curKey) || have.at(-1) || S.month; fillMonths();
  return pub || [];
}
// "New schedule" and "your schedule changed" alerts, once per published version
function myBits(schedule, rnd, k) { const n = MY_NAME, out = new Set(); if (!n) return out;
  (schedule || []).forEach((a, i) => { if (a.includes(n)) out.add(`call ${MONTHS[ym(k)[1] - 1]} ${i + 1}`); });
  (rnd || []).forEach(x => Object.entries(x.blocks || {}).forEach(([b, v]) => { if (v.some(m => m.replace(' (cross-cover)', '') === n)) out.add(`${b} rounding ${MONTHS[ym(k)[1] - 1]} ${x.days.filter(d => !x.weekend || E.dow(...ym(k), d) !== 5).join('–')}`); }));
  return out; }
async function publishAlerts(pub) {
  if (S.isAdmin) return;
  const { data: seen } = await sb.from('seen_versions').select('*'); const sv = Object.fromEntries((seen || []).map(r => [r.month_key, r.version]));
  const msgs = [];
  for (const r of pub) { const k = r.month_key, was = sv[k]; if (was === r.version) continue;
    if (was == null) msgs.push(`📅 The ${monthName(k)} schedule is out.`);
    else { const { data: old } = await sb.from('published_history').select('schedule,rnd').eq('month_key', k).eq('version', was).maybeSingle();
      const before = myBits(old && old.schedule, old && old.rnd, k), after = myBits(r.schedule, r.rnd, k);
      const added = [...after].filter(x => !before.has(x)), removed = [...before].filter(x => !after.has(x));
      if (added.length || removed.length) msgs.push(`✏️ Your ${monthName(k)} schedule changed.${added.length ? ' Added: ' + added.join(', ') + '.' : ''}${removed.length ? ' Removed: ' + removed.join(', ') + '.' : ''}`);
      else msgs.push(`The ${monthName(k)} schedule changed since you last signed in.`); }
    await sb.from('seen_versions').upsert({ user_id: me.id, month_key: k, version: r.version, seen_at: new Date().toISOString() }); }
  msgs.push(...swapNotices()); markSwapsSeen();
  if (msgs.length) modal(`<h3 style="margin-top:0">Since you last signed in</h3><ul class="issues">${msgs.map(m => `<li class="ok">${esc(m)}</li>`).join('')}</ul><button class="btn primary" data-close>Got it</button>`);
}
if (!S.isAdmin) { KEYS.forEach(k => { S.M[k].A = null; }); }
render();
Promise.all([loadRequests(), loadNotes(), loadNames(), loadSwaps(), S.isAdmin ? Promise.resolve(null) : loadPublished()]).then(([, , , , pub]) => { render(); if (pub) publishAlerts(pub); });
connect();
window.__schedRender = render;
};
