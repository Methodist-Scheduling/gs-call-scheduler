// Builds engine inputs from the history/roster data file (shared by backtest + app).
(function (root) {
  const HOLIDAYS = { '2026-07': [3], '2026-09': [7], '2026-11': [26, 27, 28, 29], '2026-12': [23, 24, 25, 26, 27, 30, 31], '2027-01': [1, 2, 3] };
  const LEAVE = {}; // leave dates live in the database (settings.people); this is only used by the offline backtest
  const key = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
  function ndays(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function leaveDays(name, y, m) {
    const L = LEAVE[name]; if (!L) return [];
    const out = []; for (let d = 1; d <= ndays(y, m); d++) { const s = key(y, m) + '-' + String(d).padStart(2, '0'); if (s >= L.from && s <= L.to) out.push(d); }
    return out;
  }
  function parseVacTxt(t, y, m) { // "7-13", "Sep 28-Oct 4", "Oct 31-Nov 6"
    if (!t) return [];
    const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    let mm = t.match(/^(\d+)-(\d+)$/); if (mm) { const o = []; for (let d = +mm[1]; d <= +mm[2]; d++) o.push(d); return o; }
    mm = t.match(/^(\w+) (\d+)-(\w+) (\d+)$/);
    if (mm) { const o = []; if (MON[mm[1]] === m) for (let d = +mm[2]; d <= ndays(y, m); d++) o.push(d); if (MON[mm[3]] === m) for (let d = 1; d <= +mm[4]; d++) o.push(d); return o; }
    return [];
  }
  const slotOf = pgy => pgy === 1 ? 'I' : (pgy === 2 || pgy === 3) ? 'M' : 'U';
  function actualAssign(data, k) {
    return data.history[k].map(x => { const a = { M: null }; x.call.forEach(n => { const s = slotOf(data.pgy[n]); if (s === 'U' && a.U) a.M = n; else a[s] = n; }); return a; });
  }
  function ytdBefore(data, k, PGY) {
    const ytd = {}; const E = root.CallEngine;
    Object.keys(data.history).filter(h => h < k).forEach(h => {
      const [y, m] = h.split('-').map(Number);
      data.history[h].forEach(x => { const w = E.dow(y, m, x.d); const two = x.call.length === 2; x.call.forEach(n => { const s = ytd[n] = ytd[n] || { wk: 0, two: 0, calls: 0, hol: 0 }; s.calls++; if (w === 5 || w === 6 || w === 0) s.wk++; if (two) s.two++; if ((HOLIDAYS[h] || []).includes(x.d)) s.hol++; }); });
    });
    return ytd;
  }
  function priorCalls(data, y, m) {
    const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y; const k = key(py, pm); const n = ndays(py, pm);
    const out = {}; (data.history[k] || []).forEach(x => { if (x.d > n - 7) x.call.forEach(nm => (out[nm] = out[nm] || []).push(x.d - n)); });
    return out;
  }
  // mode 'backtest': vacations from the month's daily lines, PGY-5/fellow + holiday calls locked to what actually happened
  // mode 'draft': vacations from the yearly schedule, nothing locked except holidays
  function buildInput(data, y, m, mode, extra = {}) {
    const k = key(y, m); const rot = data.rotations[k];
    const hist = data.history[k];
    const people = Object.entries(rot).map(([name, r]) => {
      let vac = [];
      if (mode === 'backtest' && hist) hist.forEach(x => { if (x.vac.includes(name)) vac.push(x.d); });
      else vac = parseVacTxt(r.vac_txt, y, m);
      const lv = leaveDays(name, y, m);
      return { name, pgy: data.pgy[name], rotation: lv.length >= ndays(y, m) ? 'Leave' : r.rotation, vacDays: vac, leaveDays: lv.length < ndays(y, m) ? lv : [] };
    }).filter(p => p.pgy !== undefined);
    const ytd = ytdBefore(data, k);
    people.forEach(p => p.ytd = ytd[p.name] || { wk: 0, two: 0, calls: 0, hol: 0 });
    const input = { year: y, month: m, people, prior: priorCalls(data, y, m), holidays: HOLIDAYS[k] || [], locks: [], requests: [], protected: [], colorectalDays: [], twoPersonOK: [] };
    if (mode === 'backtest') {
      const A = actualAssign(data, k);
      A.forEach((a, i) => { const d = i + 1; ['I', 'M', 'U'].forEach(s => { const n = a[s]; if (!n) return; const pg = data.pgy[n]; if (pg === 5 || pg === 'F' || input.holidays.includes(d)) input.locks.push({ day: d, slot: s, name: n }); }); if (!a.M && (input.holidays.includes(d) || [5].includes(data.pgy[a.U]))) { input.locks.push({ day: d, slot: 'M', name: null }); input.twoPersonOK.push(d); } });
      A.forEach((a, i) => { if (!a.M && new Date(Date.UTC(y, m - 1, i + 1)).getUTCDay() === 0) input.twoPersonOK.push(i + 1); });
      hist.forEach(x => x.notes.forEach(n => { if (/ATLS/.test(n)) input.protected.push({ day: x.d, names: people.filter(p => p.pgy === 1).map(p => p.name), label: 'ATLS' }); if (/Mock ABSITE/.test(n)) input.protected.push({ day: x.d, names: people.filter(p => n.includes(p.name) || (data.nicknameOf && data.nicknameOf[p.name] && n.includes(data.nicknameOf[p.name]))).map(p => p.name), label: 'Mock ABSITE' }); if (/BOARDS/i.test(n)) input.protected.push({ day: x.d, names: people.filter(p => p.pgy === 'F').map(p => p.name), label: 'Boards' }); }));
    }
    return Object.assign(input, extra);
  }
  root.BuildInput = { buildInput, actualAssign, HOLIDAYS, key, ndays, slotOf };
  if (typeof module !== 'undefined') module.exports = root.BuildInput;
})(typeof window !== 'undefined' ? window : globalThis);
