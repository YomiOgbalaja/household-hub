/* Household Hub: a two-person bill, debt, payment and settle-up tracker.
   All data lives in this browser (localStorage) and moves in and out as Excel or JSON. */
'use strict';

const STORE_KEY = 'hfh:data:v1';
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

/* ---------------- constants ---------------- */
const CATEGORIES = ['Housing', 'Utilities', 'Schools & childcare', 'Cars & transport', 'Insurance', 'Household', 'Taxes', 'Personal', 'Other'];
const FREQ = { 'Monthly': 1, 'Quarterly': 3, 'Semi-annual': 6, 'Annual': 12, 'One-time': 0 };
const PRIORITIES = ['Critical', 'High', 'Normal'];
const BILL_STATUS = ['Current', 'Behind', 'Confirm', 'On hold', 'Ended'];
const DEBT_TYPES = ['Credit card', 'BNPL', 'Collection', 'Tax', 'Student loan', 'Family & friends', 'Past-due bill', 'Other loan'];
const DEBT_STATUS = ['Current', 'Payment plan', 'Behind', 'In collections', 'Settlement offer', 'On hold', 'Paid off'];
const INCLUDE = ['Yes', 'Check', 'No'];
const KINDS = ['Scheduled', 'Out-of-cycle', 'Extra principal', 'Catch-up / arrears', 'Settlement / lump sum', 'Refund / credit'];
const METHODS = ['Checking', 'Savings', 'Credit card', 'Zelle', 'Autopay', 'Cash', 'Check', 'Other'];
const ACTION_STATUS = ['Open', 'In progress', 'Waiting', 'Done'];
const CASH_CLASS = ['Income', 'Obligation', 'Discretionary', 'Transfer'];
const SPLITS = { owner: 'By owner', income: 'By income', even: '50/50' };
const DEFAULT_AGREEMENTS = [
  'Every payment is logged in the app the day it is made.',
  'Out-of-cycle or one-off payments at or above the approval amount need both of us to approve before they count.',
  'Settle up by the 5th: whoever the app shows owing makes a transfer and logs it.',
  'Money date on the first Sunday of each month: Home, Actions, then update debt balances from statements.',
  'A new debt, a new recurring bill or a change of owner is logged as a decision and approved by both of us.',
  'Critical bills first (housing, cars, insurance, IRS), then arrears, then debt payoff priority.',
];

/* ---------------- state ---------------- */
function blankState() {
  const now = new Date();
  return {
    version: 1,
    settings: { p1: 'Partner 1', p2: 'Partner 2', incomeP1: null, incomeP2: null, split: 'owner', defShare: 0.5,
      start: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`, threshold: 250, window: 14, me: '',
      emails: { p1: '', p2: '' }, pay: { p1: { freq: 'semimonthly', next: null, amount: null }, p2: { freq: 'semimonthly', next: null, amount: null } },
      leadDays: 4, ccPartner: false, appUrl: '' },
    bills: [], debts: [], payments: [], actions: [], decisions: [], cash: [], accounts: [],
    sources: [], statements: [], activity: [], sent: {},
    agreements: DEFAULT_AGREEMENTS.slice(),
    meta: { updated: null, exported: null },
  };
}
let state = load();
function load() {
  try { const raw = localStorage.getItem(STORE_KEY); if (raw) return normalize(JSON.parse(raw)); } catch (e) { /* storage unavailable */ }
  return blankState();
}
function normalize(s) {
  const b = blankState(), out = Object.assign(b, s);
  out.settings = Object.assign(blankState().settings, s.settings || {});
  out.settings.emails = Object.assign({ p1: '', p2: '' }, out.settings.emails || {});
  out.settings.pay = { p1: Object.assign({ freq: 'semimonthly', next: null, amount: null }, (out.settings.pay || {}).p1), p2: Object.assign({ freq: 'semimonthly', next: null, amount: null }, (out.settings.pay || {}).p2) };
  for (const k of ['bills', 'debts', 'payments', 'actions', 'decisions', 'cash', 'accounts', 'sources', 'statements', 'activity']) if (!Array.isArray(out[k])) out[k] = [];
  if (!out.sent || typeof out.sent !== 'object') out.sent = {};
  return out;
}
function save() {
  state.meta.updated = new Date().toISOString();
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { toast('Could not save on this device. Export a backup.'); }
}

/* ---------------- helpers ---------------- */
function pad(n) { return String(n).padStart(2, '0'); }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function num(v) { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; }
const fmt0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function money(n, cents) { n = num(n); return (cents && Math.round(n) !== n ? fmt2 : fmt0).format(n); }
function pct(n) { return `${Math.round(num(n) * 100)}%`; }
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function thisMonth() { return todayISO().slice(0, 7); }
function ym(iso) { return iso ? iso.slice(0, 7) : ''; }
function addMonths(m, n) { let [y, mo] = m.split('-').map(Number); mo += n; y += Math.floor((mo - 1) / 12); mo = ((mo - 1) % 12 + 12) % 12 + 1; return `${y}-${pad(mo)}`; }
function monthDiff(a, b) { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + bm - am; }
function daysIn(m) { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate(); }
function dayOf(m, d) { return `${m}-${pad(Math.min(Math.max(1, d || 1), daysIn(m)))}`; }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T12:00:00') - Date.parse(a + 'T12:00:00')) / 864e5); }
function monthName(m, long) { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit' }); }
function dateShort(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
function dateLong(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
function S() { return state.settings; }
function who(k) { return k === 'p1' ? S().p1 : k === 'p2' ? S().p2 : k === 'joint' ? 'Joint' : k === 'shared' ? 'Shared' : ''; }
function ownerPill(k) { return k ? `<span class="pill o-${k}">${esc(who(k))}</span>` : ''; }
function months() { return Array.from({ length: 12 }, (_, i) => addMonths(S().start, i)); }
function shareP1(o, share) { return o === 'p1' ? 1 : o === 'p2' ? 0 : (share ?? S().defShare); }
function incShareP1() { const a = num(S().incomeP1), b = num(S().incomeP2); return a + b > 0 ? a / (a + b) : 0.5; }

/* ---------------- engine ---------------- */
function needsBoth(p) { return p.itemKind !== 'transfer' && p.kind !== 'Scheduled' && num(p.amount) >= num(S().threshold); }
function payStatus(p) {
  const a = p.approvals || {};
  if (a.p1 === false || a.p2 === false) return 'Declined';
  if (!needsBoth(p)) return 'Counted';
  return a.p1 && a.p2 ? 'Counted' : 'Awaiting approval';
}
function counted(p) { return payStatus(p) === 'Counted' ? num(p.amount) : 0; }
function paidFor(id, m) { let t = 0; for (const p of state.payments) if (p.itemId === id && ym(p.date) === m) t += counted(p); return t; }
function paidSince(id, from) { let t = 0; for (const p of state.payments) if (p.itemId === id && p.date >= from) t += counted(p); return t; }

function billAnchor(b) { return b.firstDue || dayOf(S().start, b.dueDay); }
function billInterval(b) { return FREQ[b.freq] ?? 1; }
function billDue(b, m) {
  if (!b.name || b.status === 'Ended' || !num(b.amount)) return 0;
  const iv = billInterval(b), md = monthDiff(ym(billAnchor(b)), m);
  if (iv === 0) return md === 0 ? num(b.amount) : 0;
  return md >= 0 && md % iv === 0 ? num(b.amount) : 0;
}
function billMonthly(b) { if (!b.name || b.status === 'Ended') return 0; const iv = billInterval(b); return iv ? num(b.amount) / iv : 0; }
function debtFrom(d) { return d.asOf || `${S().start}-01`; }
function debtBalance(d) { return Math.max(0, num(d.balance) - paidSince(d.id, debtFrom(d))); }
function debtActive(d) { return d.name && num(d.payment) > 0 && d.status !== 'Paid off'; }
function debtDue(d, m) { if (!debtActive(d)) return 0; if (m < ym(debtFrom(d))) return 0; return num(d.payment); }
function payoffMonths(d) {
  const bal = debtBalance(d), pay = num(d.payment), r = num(d.apr) / 12;
  if (!pay || bal <= 0) return null;
  if (r === 0) return Math.ceil(bal / pay);
  if (r * bal >= pay) return Infinity;
  return Math.ceil(-Math.log(1 - r * bal / pay) / Math.log(1 + r));
}

function items() {
  const b = state.bills.map(x => ({ kind: 'bill', id: x.id, name: x.name, owner: x.owner, share: x.share, amount: num(x.amount), ref: x, due: m => billDue(x, m), day: x.firstDue ? +x.firstDue.slice(8) : x.dueDay }));
  const d = state.debts.map(x => ({ kind: 'debt', id: x.id, name: x.name, owner: x.owner, share: x.share, amount: num(x.payment), ref: x, due: m => debtDue(x, m), day: x.dueDay }));
  return b.concat(d);
}
function itemById(id) { return items().find(i => i.id === id); }
function nextDue(it) {
  const t = todayISO(), m0 = thisMonth();
  if (!it.day && it.kind === 'debt') return null;
  for (let k = 0; k < 25; k++) {
    const m = addMonths(m0, k);
    if (it.due(m) > 0) { const d = dayOf(m, it.day || 1); if (d >= t) return d; }
  }
  return null;
}
function monthStatus(it, m) {
  const due = it.due(m), paid = paidFor(it.id, m), cur = thisMonth();
  if (due > 0 && paid >= due - 0.005) return 'paid';
  if (paid > 0 && due === 0) return 'extra';
  if (paid > 0) return 'partial';
  if (due === 0) return 'none';
  if (m < cur) return 'missed';
  if (m > cur) return 'upcoming';
  return new Date().getDate() > (it.day || 1) ? 'missed' : 'due';
}
const STATUS_TEXT = { paid: 'Paid', extra: 'Paid ahead', partial: 'Partial', missed: 'Overdue', due: 'Due', upcoming: 'Upcoming', none: 'Not due' };
const STATUS_CLS = { paid: 's-good', extra: 's-acc', partial: 's-warn', missed: 's-bad', due: 's-due', upcoming: '', none: '' };
const DOT_CLS = { paid: 'good', extra: 'good', partial: 'warn', missed: 'bad', due: 'due' };

function settleRows() {
  const its = items(), cur = thisMonth();
  let run = 0;
  return months().map(m => {
    let C = 0, D = 0;
    for (const it of its) { const v = it.due(m); C += v; D += v * shareP1(it.owner, it.share); }
    const fair1 = S().split === 'owner' ? D : S().split === 'income' ? C * incShareP1() : C * 0.5;
    let paid1 = 0, paid2 = 0, t12 = 0, t21 = 0;
    for (const p of state.payments) {
      if (ym(p.date) !== m) continue;
      const v = counted(p);
      if (p.itemKind === 'transfer') { if (p.paidBy === 'p1') t12 += v; else if (p.paidBy === 'p2') t21 += v; continue; }
      if (p.paidBy === 'p1') paid1 += v; else if (p.paidBy === 'p2') paid2 += v; else { paid1 += v / 2; paid2 += v / 2; }
    }
    const paid = paid1 + paid2, ratio = C ? fair1 / C : 0.5;
    const over = m > cur ? 0 : paid1 + t12 - t21 - paid * ratio;
    run += over;
    return { m, C, fair1, fair2: C - fair1, paid1, paid2, paid, left: Math.max(0, C - paid), t12, t21, over, run, future: m > cur };
  });
}
function settleNow() {
  const rows = settleRows(), cur = thisMonth();
  const r = rows.filter(x => x.m <= cur).pop();
  return r ? r.run : 0;
}
function settleText(v) {
  if (Math.abs(v) < 1) return 'All square';
  return v > 0 ? `${S().p2} owes ${S().p1} ${money(v)}` : `${S().p1} owes ${S().p2} ${money(-v)}`;
}
function actionFlag(a) {
  if (a.status === 'Done') return 'Done';
  if (!a.deadline) return 'Set a date';
  const d = daysBetween(todayISO(), a.deadline);
  if (d < 0) return 'Overdue';
  if (d <= num(S().window)) return 'Due soon';
  return 'Scheduled';
}
const FLAG_CLS = { Done: 's-good', 'Set a date': 's-warn', Overdue: 's-bad', 'Due soon': 's-warn', Scheduled: '' };
function decisionOutcome(d) {
  if (d.p1 === false || d.p2 === false) return 'Declined';
  if (d.p1 && d.p2) return 'Approved';
  return 'Awaiting ' + [!d.p1 && S().p1, !d.p2 && S().p2].filter(Boolean).join(' and ');
}
function totals() {
  const its = items(), cm = thisMonth();
  const billsMo = state.bills.reduce((t, b) => t + billMonthly(b), 0);
  const debtMo = state.debts.reduce((t, d) => t + (debtActive(d) ? num(d.payment) : 0), 0);
  let p1 = 0, p2 = 0;
  for (const b of state.bills) { const v = billMonthly(b), s = shareP1(b.owner, b.share); p1 += v * s; p2 += v * (1 - s); }
  for (const d of state.debts) { const v = debtActive(d) ? num(d.payment) : 0, s = shareP1(d.owner, d.share); p1 += v * s; p2 += v * (1 - s); }
  const inc = state.debts.filter(d => d.include === 'Yes');
  const debt = inc.reduce((t, d) => t + debtBalance(d), 0);
  const family = inc.filter(d => d.type === 'Family & friends').reduce((t, d) => t + debtBalance(d), 0);
  const paidOff = inc.reduce((t, d) => t + paidSince(d.id, debtFrom(d)), 0);
  const interest = inc.reduce((t, d) => t + debtBalance(d) * num(d.apr) / 12, 0);
  let sched = 0, paid = 0, overdue = 0;
  for (const it of its) { const due = it.due(cm), pd = paidFor(it.id, cm); sched += due; paid += due ? Math.min(pd, due) : pd; if (monthStatus(it, cm) === 'missed') overdue++; }
  const arrears = state.bills.reduce((t, b) => t + num(b.pastDue), 0);
  const awaiting = state.payments.filter(p => payStatus(p) === 'Awaiting approval').length;
  const decAwait = state.decisions.filter(d => decisionOutcome(d).startsWith('Awaiting')).length;
  const flags = state.actions.map(actionFlag);
  const income = num(S().incomeP1) + num(S().incomeP2);
  const cashIn = state.cash.filter(c => c.dir === 'In' && ym(c.date) === cm).reduce((t, c) => t + num(c.amount), 0);
  return { billsMo, debtMo, oblig: billsMo + debtMo, p1, p2, debt, family, paidOff, interest, sched, paid, overdue, arrears, awaiting, decAwait,
    overdueActions: flags.filter(f => f === 'Overdue').length, soonActions: flags.filter(f => f === 'Due soon').length,
    openActions: flags.filter(f => f !== 'Done').length, checkCount: state.debts.filter(d => d.include === 'Check').length,
    behind: state.bills.filter(b => b.status === 'Behind').length, income: income || cashIn, incomeFromCash: !income && cashIn > 0 };
}

/* ---------------- UI plumbing ---------------- */
const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet');
let route = 'home', ui = { meK: null, planMonth: null, planMode: 'month', billFilter: 'all', billQ: '', debtSort: 'priority', debtFilter: 'all', payMonth: 'all', actTab: 'open', cashMonth: null };

function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); }
function go() {
  route = (location.hash.replace(/^#\//, '') || 'home').split('?')[0];
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === route || (a.dataset.nav === 'more' && ['pay', 'settle', 'bills', 'actions', 'decisions', 'cash', 'settings', 'more', 'debts', 'notify', 'statements', 'activity'].includes(route))));
  render();
}
function render() {
  const v = VIEWS[route] || VIEWS.home;
  $view.innerHTML = v();
  const titles = { me: 'My view', notify: 'Reminders', statements: 'Statements', activity: 'Activity', home: 'Home', plan: 'Plan', pay: 'Payments', settle: 'Settle up', bills: 'Bills', debts: 'Debts', actions: 'Actions', decisions: 'Decisions', cash: 'Cash flow', settings: 'Settings', more: 'More' };
  document.title = `${titles[route] || 'Home'} · Household Hub`;
}
function rerender() { save(); render(); }
window.addEventListener('hashchange', () => { go(); window.scrollTo(0, 0); });

/* ---------------- views ---------------- */
function header(title, sub, actions = '') {
  return `<div class="head"><div><h1>${esc(title)}</h1>${sub ? `<p class="muted small">${sub}</p>` : ''}</div><div class="row">${actions}</div></div>`;
}
function emptyStart() {
  return `<div class="card empty"><h2>Welcome to your Household Hub</h2>
    <p>Start by bringing in your Household Finance Hub workbook, or add your names, bills and debts by hand.</p>
    <div class="row" style="justify-content:center;margin-top:12px">
      <button class="btn primary" data-action="import">Import workbook or backup</button>
      <a class="btn" href="#/settings">Set names</a><button class="btn" data-action="new-bill">Add a bill</button></div></div>`;
}
const VIEWS = {};

VIEWS.home = () => {
  if (!state.bills.length && !state.debts.length) return header('Household Hub', dateLong(todayISO())) + emptyStart();
  const t = totals(), pos = settleNow(), cm = thisMonth();
  const stale = !state.meta.exported || daysBetween(state.meta.exported.slice(0, 10), todayISO()) > 7;
  const due = items().map(it => ({ it, d: nextDue(it) })).filter(x => x.d && daysBetween(todayISO(), x.d) <= num(S().window))
    .sort((a, b) => a.d.localeCompare(b.d)).slice(0, 10);
  const share = t.p1 + t.p2 ? t.p1 / (t.p1 + t.p2) : 0.5;
  const attention = [];
  if (t.overdue) attention.push(`<li class="tap" data-go="plan"><span class="dot bad"></span><div class="main"><div class="title">${t.overdue} item${t.overdue > 1 ? 's' : ''} overdue this month</div><div class="sub">Open the plan to log or chase them</div></div></li>`);
  if (t.awaiting) attention.push(`<li class="tap" data-go="pay"><span class="dot warn"></span><div class="main"><div class="title">${t.awaiting} payment${t.awaiting > 1 ? 's' : ''} waiting for approval</div><div class="sub">Out-of-cycle payments of ${money(S().threshold)} or more need both of you</div></div></li>`);
  if (t.overdueActions || t.soonActions) attention.push(`<li class="tap" data-go="actions"><span class="dot ${t.overdueActions ? 'bad' : 'warn'}"></span><div class="main"><div class="title">${t.overdueActions} action${t.overdueActions === 1 ? '' : 's'} overdue, ${t.soonActions} due soon</div><div class="sub">${t.openActions} open in total</div></div></li>`);
  if (t.decAwait) attention.push(`<li class="tap" data-go="decisions"><span class="dot warn"></span><div class="main"><div class="title">${t.decAwait} decision${t.decAwait > 1 ? 's' : ''} need a yes or no</div></div></li>`);
  if (t.arrears) attention.push(`<li class="tap" data-go="bills"><span class="dot bad"></span><div class="main"><div class="title">${money(t.arrears)} in past-due bills</div><div class="sub">${t.behind} bill${t.behind === 1 ? '' : 's'} marked Behind</div></div></li>`);
  if (t.checkCount) attention.push(`<li class="tap" data-go="debts"><span class="dot warn"></span><div class="main"><div class="title">${t.checkCount} debts to confirm</div><div class="sub">Marked Check: left out of totals until confirmed</div></div></li>`);
  return header('Household Hub', `${esc(S().p1)} and ${esc(S().p2)} · ${dateLong(todayISO())}`,
    `<button class="btn primary" data-action="new-payment">Log a payment</button>`) +
    (stale ? `<div class="notice warn" style="margin-bottom:12px"><div>Your data lives on this device only. <b>Export to Excel</b> regularly to keep a copy and share it.</div><button class="btn sm" data-action="export-xlsx">Export</button></div>` : '') +
    `<div class="grid g4">
      ${kpi('Monthly obligations', money(t.oblig), `Bills ${money(t.billsMo)} + debts ${money(t.debtMo)}`, '')}
      ${kpi('Debt today', money(t.debt), `Excl. family ${money(t.debt - t.family)}`, 't-bad')}
      ${kpi(`${monthName(cm, true)} paid`, t.sched ? pct(t.paid / t.sched) : '–', `${money(t.paid)} of ${money(t.sched)}`, 't-good', t.sched ? t.paid / t.sched : 0)}
      ${kpi('Settle up', settleText(pos), SPLITS[S().split] + ' split', 't-acc', null, true)}
    </div>
    <div class="cols" style="margin-top:16px">
      <div>
        <div class="card"><div class="spread"><h2>Due in the next ${num(S().window)} days</h2><a href="#/plan" class="small">Plan</a></div>
          ${due.length ? `<ul class="list">${due.map(({ it, d }) => {
            const st = monthStatus(it, ym(d)), left = Math.max(0, it.due(ym(d)) - paidFor(it.id, ym(d)));
            return `<li><span class="dot ${DOT_CLS[st] || ''}"></span><div class="main"><div class="title">${esc(it.name)}</div><div class="sub">${dateShort(d)} · ${daysBetween(todayISO(), d) === 0 ? 'today' : 'in ' + daysBetween(todayISO(), d) + ' days'}</div></div>
              <div class="end"><div class="amt">${money(left || it.amount, true)}</div>${ownerPill(it.owner)}</div>
              ${st === 'paid' ? '<span class="pill s-good">Paid</span>' : `<button class="btn sm" data-action="mark-paid" data-id="${it.id}" data-month="${ym(d)}">Paid</button>`}</li>`;
          }).join('')}</ul>` : '<p class="muted">Nothing due in the window.</p>'}
        </div>
        <div class="card"><h2>Scheduled versus paid</h2>${monthChart()}</div>
      </div>
      <div>
        <div class="card"><h2>Who carries what each month</h2>
          <div class="split"><i style="width:${share * 100}%;background:var(--p1)"></i><i style="width:${(1 - share) * 100}%;background:var(--p2)"></i></div>
          <div class="legend"><span><span class="sw" style="background:var(--p1)"></span>${esc(S().p1)} <b>${money(t.p1)}</b> (${pct(share)})</span><span><span class="sw" style="background:var(--p2)"></span>${esc(S().p2)} <b>${money(t.p2)}</b> (${pct(1 - share)})</span></div>
          <p class="small muted" style="margin:8px 0 0">Includes each person's part of Shared items.${t.income ? ` Income ${t.incomeFromCash ? 'logged this month' : 'per month'}: <b>${money(t.income)}</b>, leaving <b style="color:${t.income - t.oblig < 0 ? 'var(--bad)' : 'var(--good)'}">${money(t.income - t.oblig)}</b> after obligations.` : ''}</p>
        </div>
        ${attention.length ? `<div class="card"><h2>Needs attention</h2><ul class="list">${attention.join('')}</ul></div>` : ''}
        <div class="card"><div class="spread"><h2>Debt picture</h2><a href="#/debts" class="small">Debts</a></div>${debtByType()}
          <p class="small muted" style="margin:8px 0 0">Paid down since plan start ${money(t.paidOff)} · interest about ${money(t.interest)} a month</p></div>
      </div>
    </div>`;
};
function kpi(label, value, cap, tone, progress, text) {
  return `<div class="card kpi ${tone}"><div class="label">${esc(label)}</div><div class="value ${text ? 'text' : ''} num">${esc(value)}</div>
    ${progress != null ? `<div class="bar" style="margin:6px 0 2px"><i style="width:${Math.min(100, progress * 100)}%;background:var(--good)"></i></div>` : ''}<div class="cap">${esc(cap)}</div></div>`;
}
function monthChart() {
  const rows = settleRows(), max = Math.max(1, ...rows.map(r => Math.max(r.C, r.paid)));
  const W = 560, H = 170, pb = 22, bw = W / 12;
  const bars = rows.map((r, i) => {
    const x = i * bw, h1 = (r.C / max) * (H - pb - 8), h2 = (r.paid / max) * (H - pb - 8);
    return `<g><title>${monthName(r.m, true)}: scheduled ${money(r.C)}, paid ${money(r.paid)}</title>
      <rect x="${x + bw * .14}" y="${H - pb - h1}" width="${bw * .34}" height="${h1}" rx="3" fill="#c9d6e3"/>
      <rect x="${x + bw * .52}" y="${H - pb - h2}" width="${bw * .34}" height="${h2}" rx="3" fill="${r.m === thisMonth() ? '#2f6f73' : '#5f9ea0'}"/>
      <text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" ${r.m === thisMonth() ? 'style="font-weight:700;fill:#1f2a37"' : ''}>${monthName(r.m).split(' ')[0]}</text></g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Scheduled versus paid by month">${bars}</svg>
    <div class="legend"><span><span class="sw" style="background:#c9d6e3"></span>Scheduled</span><span><span class="sw" style="background:#2f6f73"></span>Paid</span></div>`;
}
function debtByType() {
  const inc = state.debts.filter(d => d.include === 'Yes');
  const rows = DEBT_TYPES.map(t => { const ds = inc.filter(d => d.type === t); return { t, n: ds.length, bal: ds.reduce((s, d) => s + debtBalance(d), 0), mo: ds.reduce((s, d) => s + (debtActive(d) ? num(d.payment) : 0), 0) }; }).filter(r => r.n);
  const max = Math.max(1, ...rows.map(r => r.bal));
  return `<ul class="list">${rows.map(r => `<li><div class="main"><div class="spread"><span class="title">${esc(r.t)} <span class="muted small">· ${r.n}</span></span><span class="amt">${money(r.bal)}</span></div>
    <div class="bar" style="margin-top:6px"><i style="width:${r.bal / max * 100}%;background:#e0a35a"></i></div><div class="sub">${money(r.mo)} a month</div></div></li>`).join('')}</ul>`;
}

VIEWS.plan = () => {
  const ms = months(), cm = thisMonth();
  if (!ui.planMonth) ui.planMonth = ms.includes(cm) ? cm : ms[0];
  const m = ui.planMonth, its = items().filter(i => i.name);
  const tog = `<div class="chips"><button class="chip ${ui.planMode === 'month' ? 'on' : ''}" data-action="plan-mode" data-v="month">Month</button><button class="chip ${ui.planMode === 'year' ? 'on' : ''}" data-action="plan-mode" data-v="year">Year grid</button></div>`;
  if (!its.length) return header('12-month plan', '') + emptyStart();
  if (ui.planMode === 'year') {
    const cell = (it, mm) => { const st = monthStatus(it, mm), paid = paidFor(it.id, mm), due = it.due(mm);
      if (st === 'none') return '<td class="c"></td>';
      const cls = { paid: 'paid', extra: 'extra', partial: 'partial', missed: 'missed', due: 'due', upcoming: 'upcoming' }[st];
      return `<td class="c"><span class="cell ${cls}" title="${STATUS_TEXT[st]}: paid ${money(paid)} of ${money(due)}">${money(paid || due)}</span></td>`; };
    const rowsFor = list => list.map(it => `<tr><td><span class="tap" data-action="edit-${it.kind}" data-id="${it.id}">${esc(it.name)}</span> ${ownerPill(it.owner)}</td>${ms.map(mm => cell(it, mm)).join('')}</tr>`).join('');
    const tot = ms.map(mm => its.reduce((t, it) => t + paidFor(it.id, mm), 0));
    const sch = ms.map(mm => its.reduce((t, it) => t + it.due(mm), 0));
    return header('12-month plan', `${monthName(ms[0], true)} to ${monthName(ms[11], true)}. Paid amounts are shown; grey is still to come.`, tog) +
      `<div class="card"><div class="tablewrap"><table><thead><tr><th>Item</th>${ms.map(mm => `<th${mm === cm ? ' style="color:var(--acc)"' : ''}>${monthName(mm)}</th>`).join('')}</tr></thead>
      <tbody><tr><td colspan="13" style="font-weight:700;color:var(--acc)">Bills</td></tr>${rowsFor(its.filter(i => i.kind === 'bill'))}
      <tr><td colspan="13" style="font-weight:700;color:var(--acc)">Debt payments</td></tr>${rowsFor(its.filter(i => i.kind === 'debt' && i.amount))}
      <tr class="total"><td>Scheduled</td>${sch.map(v => `<td>${money(v)}</td>`).join('')}</tr><tr class="total"><td>Paid</td>${tot.map(v => `<td>${money(v)}</td>`).join('')}</tr></tbody></table></div>
      <div class="legend"><span><span class="sw" style="background:var(--good-soft)"></span>Paid</span><span><span class="sw" style="background:var(--warn-soft)"></span>Partial</span><span><span class="sw" style="background:var(--bad-soft)"></span>Overdue</span><span><span class="sw" style="background:var(--due-soft)"></span>Due now</span><span><span class="sw" style="background:var(--soft)"></span>Upcoming</span></div></div>`;
  }
  const rows = its.map(it => ({ it, due: it.due(m), paid: paidFor(it.id, m), st: monthStatus(it, m) })).filter(r => r.due > 0 || r.paid > 0);
  const order = { missed: 0, due: 1, partial: 2, upcoming: 3, paid: 4, extra: 5 };
  rows.sort((a, b) => (order[a.st] - order[b.st]) || ((a.it.day || 0) - (b.it.day || 0)));
  const sched = rows.reduce((t, r) => t + r.due, 0), paid = rows.reduce((t, r) => t + (r.due ? Math.min(r.paid, r.due) : r.paid), 0);
  const extra = rows.reduce((t, r) => t + r.paid, 0) - paid;
  const li = r => `<li><span class="dot ${DOT_CLS[r.st] || ''}"></span><div class="main tap" data-action="edit-${r.it.kind}" data-id="${r.it.id}"><div class="title">${esc(r.it.name)}</div>
      <div class="sub">${r.it.day ? 'Due ' + dateShort(dayOf(m, r.it.day)) + ' · ' : ''}${esc(who(r.it.owner))}${r.paid && r.paid < r.due ? ' · paid ' + money(r.paid, true) : ''}</div></div>
      <div class="end"><div class="amt">${money(r.due || r.paid, true)}</div><span class="pill ${STATUS_CLS[r.st]}">${STATUS_TEXT[r.st]}</span></div>
      ${r.st === 'paid' || r.st === 'extra' ? '' : payButtons(r.it, m)}</li>`;
  return header('12-month plan', 'Tap Paid to log a payment. Everything else updates from your payments.', tog) +
    `<div class="chips" style="margin-bottom:12px">${ms.map(mm => `<button class="chip ${mm === m ? 'on' : ''} ${mm === cm ? 'now' : ''}" data-action="plan-month" data-v="${mm}">${monthName(mm)}</button>`).join('')}</div>
    <div class="grid g4" style="margin-bottom:12px">${kpi('Scheduled', money(sched), monthName(m, true), '')}${kpi('Paid', money(paid), `${sched ? pct(paid / sched) : '–'} done${extra > 0.5 ? ` · plus ${money(extra)} extra` : ''}`, 't-good', sched ? paid / sched : 0)}
    ${kpi('Still to pay', money(Math.max(0, sched - paid)), `${rows.filter(r => r.st === 'missed').length} overdue`, 't-bad')}${kpi('Items', String(rows.length), `${rows.filter(r => r.st === 'paid').length} paid`, '')}</div>
    <div class="cols"><div class="card"><h2>Bills</h2><ul class="list">${rows.filter(r => r.it.kind === 'bill').map(li).join('') || '<li class="muted">None this month</li>'}</ul></div>
    <div class="card"><h2>Debt payments</h2><ul class="list">${rows.filter(r => r.it.kind === 'debt').map(li).join('') || '<li class="muted">None this month</li>'}</ul></div></div>`;
};

VIEWS.pay = () => {
  const ms = months();
  let list = state.payments.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (ui.payMonth !== 'all') list = list.filter(p => ym(p.date) === ui.payMonth);
  const total = list.reduce((t, p) => t + counted(p), 0);
  return header('Payments', 'Every payment, including out-of-cycle, catch-up and transfers between you.', `<button class="btn primary" data-action="new-payment">Log a payment</button>`) +
    `<div class="chips" style="margin-bottom:12px"><button class="chip ${ui.payMonth === 'all' ? 'on' : ''}" data-action="pay-month" data-v="all">All</button>${ms.map(m => `<button class="chip ${ui.payMonth === m ? 'on' : ''}" data-action="pay-month" data-v="${m}">${monthName(m)}</button>`).join('')}</div>
    <div class="card"><div class="spread"><h2>${list.length} payment${list.length === 1 ? '' : 's'}</h2><span class="amt num">${money(total, true)} counted</span></div>
    ${list.length ? `<ul class="list">${list.map(payLi).join('')}</ul>` : '<p class="muted">No payments yet. Use Log a payment or the Paid buttons on the plan.</p>'}</div>`;
};
function payLi(p) {
  const st = payStatus(p), it = p.itemKind === 'transfer' ? null : itemById(p.itemId);
  const name = p.itemKind === 'transfer' ? `Transfer ${who(p.paidBy)} to ${who(p.paidBy === 'p1' ? 'p2' : 'p1')}` : (it ? it.name : p.itemName || 'Unlinked item');
  const a = p.approvals || {};
  const approve = st === 'Awaiting approval' ? `<div class="row" style="margin-top:6px">${['p1', 'p2'].map(k => a[k] ? `<span class="pill s-good">${esc(who(k))} approved</span>` :
    `<button class="btn sm" data-action="approve-pay" data-id="${p.id}" data-who="${k}">Approve as ${esc(who(k))}</button><button class="btn sm ghost danger" data-action="decline-pay" data-id="${p.id}" data-who="${k}">Decline</button>`).join('')}</div>` : '';
  return `<li><div class="main tap" data-action="edit-payment" data-id="${p.id}"><div class="title">${esc(name)}</div><div class="sub">${dateShort(p.date)} · ${esc(p.kind || 'Scheduled')}${p.method ? ' · ' + esc(p.method) : ''}${p.notes ? ' · ' + esc(p.notes) : ''}</div>${approve}</div>
    <div class="end"><div class="amt">${money(p.amount, true)}</div>${ownerPill(p.paidBy)}${st !== 'Counted' ? `<div><span class="pill ${st === 'Declined' ? 's-bad' : 's-warn'}">${st}</span></div>` : ''}</div></li>`;
}

VIEWS.settle = () => {
  const rows = settleRows(), pos = settleNow(), cm = thisMonth();
  const tot = k => rows.reduce((t, r) => t + r[k], 0);
  return header('Settle up', `Fair share uses the <b>${SPLITS[S().split]}</b> split. Change it in Settings.`) +
    `<div class="card"><div class="label tiny muted" style="font-weight:700;text-transform:uppercase;letter-spacing:.04em">Position to date</div>
      <div class="statement" style="margin:4px 0 8px;color:${Math.abs(pos) < 1 ? 'var(--good)' : 'var(--ink)'}">${esc(settleText(pos))}</div>
      <p class="small muted" style="margin:0 0 10px">Compares what each of you paid with your fair share of everything that got paid. Joint payments count half each.</p>
      <div class="row">${Math.abs(pos) >= 1 ? `<button class="btn primary" data-action="settle-transfer" data-amt="${Math.abs(pos).toFixed(2)}" data-from="${pos > 0 ? 'p2' : 'p1'}">Record the transfer</button>` : ''}
      <div class="chips">${Object.entries(SPLITS).map(([k, v]) => `<button class="chip ${S().split === k ? 'on' : ''}" data-action="set-split" data-v="${k}">${v}</button>`).join('')}</div></div></div>
    <div class="card"><h2>Month by month</h2><div class="tablewrap"><table><thead><tr><th>Month</th><th>Scheduled</th><th>${esc(S().p1)} share</th><th>${esc(S().p2)} share</th><th>${esc(S().p1)} paid</th><th>${esc(S().p2)} paid</th><th>Transfers</th><th>${esc(S().p1)} +/−</th><th>Running</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.m === cm ? 'now' : ''}"><td>${monthName(r.m)}</td><td>${money(r.C)}</td><td style="color:var(--p1)">${money(r.fair1)}</td><td style="color:var(--p2)">${money(r.fair2)}</td>
        <td>${money(r.paid1)}</td><td>${money(r.paid2)}</td><td>${r.t12 || r.t21 ? money(r.t12 - r.t21) : '–'}</td>
        <td style="color:${r.over < -0.5 ? 'var(--bad)' : r.over > 0.5 ? 'var(--good)' : 'inherit'}">${r.future ? '' : money(r.over)}</td><td>${r.future ? '' : money(r.run)}</td></tr>`).join('')}
      <tr class="total"><td>12 months</td><td>${money(tot('C'))}</td><td>${money(tot('fair1'))}</td><td>${money(tot('fair2'))}</td><td>${money(tot('paid1'))}</td><td>${money(tot('paid2'))}</td><td>${money(tot('t12') - tot('t21'))}</td><td>${money(tot('over'))}</td><td></td></tr>
    </tbody></table></div><p class="small muted">Plus (+) means ${esc(S().p1)} paid more than their share that month.</p></div>`;
};

VIEWS.bills = () => {
  let list = state.bills.slice();
  if (ui.billFilter !== 'all') list = list.filter(b => b.owner === ui.billFilter);
  if (ui.billQ) { const q = ui.billQ.toLowerCase(); list = list.filter(b => [b.name, b.category, b.payee, b.notes].join(' ').toLowerCase().includes(q)); }
  const cm = thisMonth(), mo = list.reduce((t, b) => t + billMonthly(b), 0), past = list.reduce((t, b) => t + num(b.pastDue), 0);
  const byCat = CATEGORIES.map(c => [c, list.filter(b => b.category === c)]).filter(x => x[1].length);
  const other = list.filter(b => !CATEGORIES.includes(b.category)); if (other.length) byCat.push(['Uncategorised', other]);
  return header('Bills', `${state.bills.length} bills · ${money(mo)} a month${past ? ` · <span style="color:var(--bad)">${money(past)} past due</span>` : ''}`, `<button class="btn primary" data-action="new-bill">Add a bill</button>`) +
    `<div class="row" style="margin-bottom:12px"><div class="chips">${['all', 'p1', 'p2', 'shared'].map(k => `<button class="chip ${ui.billFilter === k ? 'on' : ''}" data-action="bill-filter" data-v="${k}">${k === 'all' ? 'All' : esc(who(k))}</button>`).join('')}</div>
     <input class="search" style="flex:1;min-width:180px" type="search" placeholder="Search bills" value="${esc(ui.billQ)}" data-input="billQ"></div>
    ${byCat.map(([c, bs]) => `<div class="card"><div class="spread"><h2>${esc(c)}</h2><span class="muted small num">${money(bs.reduce((t, b) => t + billMonthly(b), 0))}/mo</span></div><ul class="list">${bs.map(b => {
      const it = items().find(i => i.id === b.id), st = monthStatus(it, cm), nd = nextDue(it);
      return `<li class="tap" data-action="edit-bill" data-id="${b.id}"><span class="dot ${DOT_CLS[st] || ''}"></span><div class="main"><div class="title">${esc(b.name)}</div>
        <div class="sub">${esc(b.freq || 'Monthly')}${nd ? ' · next ' + dateShort(nd) : ''}${b.payee ? ' · ' + esc(b.payee) : ''}</div>
        <div class="row" style="margin-top:4px">${ownerPill(b.owner)}${b.status && b.status !== 'Current' ? `<span class="pill ${b.status === 'Behind' ? 's-bad' : 's-warn'}">${esc(b.status)}</span>` : ''}${num(b.pastDue) ? `<span class="pill s-bad">${money(b.pastDue)} past due</span>` : ''}${b.priority === 'Critical' ? '<span class="pill s-bad">Critical</span>' : ''}</div></div>
        <div class="end"><div class="amt">${money(b.amount, true)}</div><span class="pill ${STATUS_CLS[st]}">${STATUS_TEXT[st]}</span></div></li>`;
    }).join('')}</ul></div>`).join('') || '<div class="card empty">No bills match.</div>'}`;
};

VIEWS.debts = () => {
  let list = state.debts.slice();
  if (ui.debtFilter !== 'all') list = list.filter(d => ui.debtFilter === 'check' ? d.include === 'Check' : d.type === ui.debtFilter);
  const inc = state.debts.filter(d => d.include === 'Yes');
  const rank = inc.filter(d => debtBalance(d) > 0 && d.status !== 'Paid off').sort((a, b) => num(b.apr) - num(a.apr) || debtBalance(a) - debtBalance(b));
  const pr = id => { const i = rank.findIndex(d => d.id === id); return i < 0 ? 999 : i + 1; };
  const sorters = { priority: (a, b) => pr(a.id) - pr(b.id), balance: (a, b) => debtBalance(b) - debtBalance(a), rate: (a, b) => num(b.apr) - num(a.apr), name: (a, b) => a.name.localeCompare(b.name) };
  list.sort(sorters[ui.debtSort]);
  const t = totals();
  const types = DEBT_TYPES.filter(x => state.debts.some(d => d.type === x));
  return header('Debts', 'Update the balance and its date after each statement; payments logged after that date come off automatically.', `<button class="btn primary" data-action="new-debt">Add a debt</button>`) +
    `<div class="grid g4" style="margin-bottom:12px">${kpi('Balance today', money(t.debt), `${inc.length} counted · ${t.checkCount} to confirm`, 't-bad')}${kpi('Monthly payments', money(t.debtMo), 'Active plans', '')}
     ${kpi('Interest a month', money(t.interest), 'At plan rates', '')}${kpi('Paid down', money(t.paidOff), 'Since balance dates', 't-good')}</div>
    <div class="row" style="margin-bottom:12px"><div class="chips">${[['all', 'All'], ['check', 'To confirm']].concat(types.map(x => [x, x])).map(([k, v]) => `<button class="chip ${ui.debtFilter === k ? 'on' : ''}" data-action="debt-filter" data-v="${esc(k)}">${esc(v)}</button>`).join('')}</div>
    <select class="search" style="width:auto" data-input="debtSort">${[['priority', 'Payoff priority'], ['balance', 'Largest balance'], ['rate', 'Highest rate'], ['name', 'Name']].map(([k, v]) => `<option value="${k}" ${ui.debtSort === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="card"><ul class="list">${list.map(d => {
      const bal = debtBalance(d), paid = num(d.balance) ? Math.min(1, (num(d.balance) - bal) / num(d.balance)) : 0, n = payoffMonths(d), p = pr(d.id);
      const stCls = ['Behind', 'In collections'].includes(d.status) ? 's-bad' : ['Settlement offer', 'On hold'].includes(d.status) ? 's-warn' : d.status === 'Paid off' ? 's-good' : '';
      return `<li class="tap" data-action="edit-debt" data-id="${d.id}"><div class="main"><div class="spread"><span class="title">${esc(d.name)}</span><span class="amt">${money(bal, true)}</span></div>
        <div class="sub">${esc(d.type || '')}${d.collector && d.collector !== d.institution ? ' · ' + esc(d.collector) : ''}${num(d.payment) ? ' · ' + money(d.payment) + '/mo' : ''}${d.apr != null && d.apr !== '' ? ' · ' + (num(d.apr) * 100).toFixed(2).replace(/\.00$/, '') + '%' : ''}${n ? ' · ' + (n === Infinity ? 'payment below interest' : 'paid off ' + monthName(addMonths(thisMonth(), n), true)) : ''}</div>
        <div class="bar" style="margin:6px 0"><i style="width:${paid * 100}%;background:var(--good)"></i></div>
        <div class="row">${ownerPill(d.owner)}${d.status ? `<span class="pill ${stCls}">${esc(d.status)}</span>` : ''}${d.include === 'Check' ? '<span class="pill s-warn">Confirm: not counted</span>' : d.include === 'No' ? '<span class="pill">Not counted</span>' : ''}${p <= 3 ? `<span class="pill s-acc">Priority ${p}</span>` : ''}${d.terms ? `<span class="pill">${esc(d.terms)}</span>` : ''}</div></div></li>`;
    }).join('') || '<li class="muted">No debts here.</li>'}</ul></div>`;
};

VIEWS.actions = () => {
  const order = { Overdue: 0, 'Due soon': 1, 'Set a date': 2, Scheduled: 3, Done: 4 }, pri = { Critical: 0, High: 1, Normal: 2 };
  let list = state.actions.slice().sort((a, b) => order[actionFlag(a)] - order[actionFlag(b)] || pri[a.priority] - pri[b.priority] || (a.deadline || '9').localeCompare(b.deadline || '9'));
  list = list.filter(a => ui.actTab === 'done' ? a.status === 'Done' : a.status !== 'Done');
  return header('Actions', 'Deadlines, arrears and open questions. Tick when done.', `<button class="btn primary" data-action="new-action">Add an action</button>`) +
    `<div class="chips" style="margin-bottom:12px"><button class="chip ${ui.actTab === 'open' ? 'on' : ''}" data-action="act-tab" data-v="open">Open (${state.actions.filter(a => a.status !== 'Done').length})</button><button class="chip ${ui.actTab === 'done' ? 'on' : ''}" data-action="act-tab" data-v="done">Done (${state.actions.filter(a => a.status === 'Done').length})</button></div>
    <div class="card"><ul class="list">${list.map(a => {
      const f = actionFlag(a), d = a.deadline ? daysBetween(todayISO(), a.deadline) : null;
      return `<li class="${a.status === 'Done' ? 'done' : ''}"><button class="check ${a.status === 'Done' ? 'on' : ''}" data-action="toggle-action" data-id="${a.id}" aria-label="Mark done">${a.status === 'Done' ? '✓' : ''}</button>
        <div class="main tap" data-action="edit-action" data-id="${a.id}"><div class="title">${esc(a.title)}</div><div class="sub">${esc(a.detail || '')}</div>
        <div class="row" style="margin-top:4px">${ownerPill(a.owner)}<span class="pill ${FLAG_CLS[f]}">${f}${d != null && a.status !== 'Done' ? ` · ${d < 0 ? -d + ' days late' : d === 0 ? 'today' : d + ' days'}` : ''}</span>${a.priority === 'Critical' ? '<span class="pill s-bad">Critical</span>' : a.priority === 'High' ? '<span class="pill s-warn">High</span>' : ''}${a.deadline ? `<span class="pill">${dateShort(a.deadline)}</span>` : ''}</div></div>
        ${num(a.amount) ? `<div class="end amt">${money(a.amount, true)}</div>` : ''}</li>`;
    }).join('') || '<li class="muted">Nothing here.</li>'}</ul></div>`;
};

VIEWS.decisions = () => {
  const list = state.decisions.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return header('Decisions', 'Your agreements, and anything that needs a yes from both of you.', `<button class="btn primary" data-action="new-decision">Add a decision</button>`) +
    `<div class="card"><div class="spread"><h2>Our agreements</h2><button class="btn sm" data-action="edit-agreements">Edit</button></div><ol class="agree">${state.agreements.map(a => `<li>${esc(a)}</li>`).join('')}</ol></div>
    <div class="card"><h2>Decision log</h2><ul class="list">${list.map(d => {
      const o = decisionOutcome(d);
      return `<li><div class="main tap" data-action="edit-decision" data-id="${d.id}"><div class="title">${esc(d.request)}</div><div class="sub">${dateShort(d.date)}${d.by ? ' · raised by ' + esc(who(d.by)) : ''}${d.notes ? ' · ' + esc(d.notes) : ''}</div>
        <div class="row" style="margin-top:6px">${['p1', 'p2'].map(k => d[k] === true ? `<span class="pill s-good">${esc(who(k))}: yes</span>` : d[k] === false ? `<span class="pill s-bad">${esc(who(k))}: no</span>` :
          `<button class="btn sm" data-action="vote" data-id="${d.id}" data-who="${k}" data-v="yes">${esc(who(k))}: yes</button><button class="btn sm ghost danger" data-action="vote" data-id="${d.id}" data-who="${k}" data-v="no">No</button>`).join('')}</div></div>
        <div class="end">${num(d.amount) ? `<div class="amt">${money(d.amount)}</div>` : ''}<span class="pill ${o === 'Approved' ? 's-good' : o === 'Declined' ? 's-bad' : 's-warn'}">${esc(o)}</span></div></li>`;
    }).join('') || '<li class="muted">No decisions yet.</li>'}</ul></div>`;
};

VIEWS.cash = () => {
  const m = ui.cashMonth || thisMonth(), ms = Array.from(new Set(state.cash.map(c => ym(c.date)).concat([thisMonth()]))).filter(Boolean).sort().reverse();
  const list = state.cash.filter(c => ym(c.date) === m).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const inn = list.filter(c => c.dir === 'In').reduce((t, c) => t + num(c.amount), 0);
  const out = list.filter(c => c.dir === 'Out').reduce((t, c) => t + num(c.amount), 0);
  const disc = list.filter(c => c.dir === 'Out' && c.cls === 'Discretionary').reduce((t, c) => t + num(c.amount), 0);
  const billsPaid = items().reduce((t, it) => t + paidFor(it.id, m), 0);
  const bal = state.accounts.reduce((t, a) => t + num(a.balance), 0);
  return header('Cash flow', 'Money in, everyday spending, and account balances. Bill and debt payments come from Payments.', `<button class="btn primary" data-action="new-cash">Add money in or out</button>`) +
    `<div class="chips" style="margin-bottom:12px">${ms.map(x => `<button class="chip ${x === m ? 'on' : ''}" data-action="cash-month" data-v="${x}">${monthName(x)}</button>`).join('')}</div>
    <div class="grid g4" style="margin-bottom:12px">${kpi('Money in', money(inn), monthName(m, true), 't-good')}${kpi('Everyday spending', money(out), `${money(disc)} discretionary`, '')}
     ${kpi('Bills and debts paid', money(billsPaid), 'From Payments', '')}${kpi('Left over', money(inn - out - billsPaid), 'In minus everything out', inn - out - billsPaid < 0 ? 't-bad' : 't-good')}</div>
    <div class="cols"><div class="card"><h2>${monthName(m, true)}</h2><ul class="list">${list.map(c => `<li class="tap" data-action="edit-cash" data-id="${c.id}"><span class="dot ${c.dir === 'In' ? 'good' : c.cls === 'Discretionary' ? 'warn' : ''}"></span>
      <div class="main"><div class="title">${esc(c.desc)}</div><div class="sub">${dateShort(c.date)} · ${esc(c.cls || '')}${c.account ? ' · ' + esc(c.account) : ''}${c.notes ? ' · ' + esc(c.notes) : ''}</div></div>
      <div class="end"><div class="amt" style="color:${c.dir === 'In' ? 'var(--good)' : 'inherit'}">${c.dir === 'In' ? '+' : '−'}${money(c.amount, true)}</div>${ownerPill(c.person)}</div></li>`).join('') || '<li class="muted">Nothing logged this month.</li>'}</ul></div>
    <div class="card"><div class="spread"><h2>Accounts</h2><button class="btn sm" data-action="new-account">Add</button></div><ul class="list">${state.accounts.map(a => `<li class="tap" data-action="edit-account" data-id="${a.id}"><div class="main"><div class="title">${esc(a.name)}</div><div class="sub">${a.asOf ? 'as of ' + dateShort(a.asOf) : ''}</div></div><div class="end"><div class="amt">${money(a.balance, true)}</div>${ownerPill(a.owner)}</div></li>`).join('') || '<li class="muted">No accounts yet.</li>'}
      ${state.accounts.length ? `<li><div class="main title">Total</div><div class="amt">${money(bal, true)}</div></li>` : ''}</ul></div></div>`;
};

VIEWS.more = () => header('More', '') + `<div class="more-grid">
  <a href="#/pay">Payments<span>Log, approve, review</span></a><a href="#/settle">Settle up<span>${esc(settleText(settleNow()))}</span></a>
  <a href="#/bills">Bills<span>${state.bills.length} bills</span></a><a href="#/actions">Actions<span>${totals().openActions} open</span></a>
  <a href="#/decisions">Decisions<span>Agreements and approvals</span></a><a href="#/cash">Cash flow<span>Money in and out</span></a>
  <a href="#/settings">Settings &amp; data<span>Names, split, export</span></a><a href="#" data-action="export-xlsx">Export to Excel<span>Download a full workbook</span></a></div>`;

VIEWS.settings = () => {
  const s = S();
  return header('Settings & data', 'Saved on this device as you type.') +
    `<div class="cols"><div class="card"><h2>Household</h2><div class="fields">
      ${sField('p1', 'Partner 1 name', 'text', s.p1)}${sField('p2', 'Partner 2 name', 'text', s.p2)}
      ${sField('incomeP1', `${esc(s.p1)} monthly take-home`, 'number', s.incomeP1)}${sField('incomeP2', `${esc(s.p2)} monthly take-home`, 'number', s.incomeP2)}
      <div class="field"><label>How shared costs split</label><select data-setting="split">${Object.entries(SPLITS).map(([k, v]) => `<option value="${k}" ${s.split === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      ${sField('defShare', `${esc(s.p1)} part of a Shared item (%)`, 'number', Math.round(num(s.defShare) * 100))}
      ${sField('start', 'Plan starts', 'month', s.start)}${sField('threshold', 'Both approve at or above ($)', 'number', s.threshold)}
      ${sField('window', 'Due-soon window (days)', 'number', s.window)}
      <div class="field"><label>This device belongs to</label><select data-setting="me"><option value="">Not set</option><option value="p1" ${s.me === 'p1' ? 'selected' : ''}>${esc(s.p1)}</option><option value="p2" ${s.me === 'p2' ? 'selected' : ''}>${esc(s.p2)}</option></select></div>
    </div><p class="small muted">By owner: each person carries what they own plus their part of Shared items. By income: the whole month is split by take-home pay. 50/50: split evenly.</p></div>
    <div><div class="card"><h2>Export</h2><p class="small muted" style="margin-top:0">A full workbook with every list plus the plan, settle-up and summary. Opens in Excel, Numbers or Google Sheets.</p>
      <div class="row"><button class="btn primary" data-action="export-xlsx">Export to Excel</button><button class="btn" data-action="export-json">Backup file (.json)</button></div>
      <p class="small muted">${state.meta.exported ? 'Last exported ' + dateLong(state.meta.exported.slice(0, 10)) : 'Not exported yet.'}</p></div>
    <div class="card"><h2>Import</h2><p class="small muted" style="margin-top:0">Bring in a backup file, an Excel export from this app, or the Household Finance Hub workbook. Import replaces what is on this device.</p>
      <button class="btn" data-action="import">Choose a file</button></div>
    <div class="card"><h2>Privacy</h2><p class="small muted" style="margin:0">Everything stays in this browser. Nothing is sent anywhere. To share with your partner, export and send the file, or import theirs.</p>
      <button class="btn danger" style="margin-top:10px" data-action="reset">Erase data on this device</button></div></div></div>`;
};
function sField(k, label, type, v) {
  return `<div class="field"><label for="s-${k}">${label}</label><input id="s-${k}" type="${type}" ${type === 'number' ? 'inputmode="decimal" step="any"' : ''} data-setting="${k}" value="${esc(v ?? '')}"></div>`;
}

/* ---------------- forms ---------------- */
const owners = () => [['p1', S().p1], ['p2', S().p2], ['shared', 'Shared']];
const payers = () => [['p1', S().p1], ['p2', S().p2], ['joint', 'Joint']];
const L = a => a.map(x => [x, x]);
const FORMS = {
  bill: { coll: 'bills', title: 'Bill', fields: () => [
    ['name', 'Bill', 'text', { req: 1, full: 1 }], ['amount', 'Amount', 'money', { req: 1 }], ['freq', 'How often', 'select', { opts: L(Object.keys(FREQ)), def: 'Monthly' }],
    ['owner', 'Owner', 'select', { opts: owners(), def: 'shared' }], ['share', `${S().p1} part if Shared (%)`, 'percent', { hint: 'Blank uses the Settings default' }],
    ['dueDay', 'Due day of month', 'int', {}], ['firstDue', 'First due date', 'date', { hint: 'For annual, semi-annual and one-time bills' }],
    ['category', 'Category', 'select', { opts: L(CATEGORIES), def: 'Other' }], ['payee', 'Payee', 'text', {}],
    ['priority', 'Priority', 'select', { opts: L(PRIORITIES), def: 'Normal' }], ['status', 'Status', 'select', { opts: L(BILL_STATUS), def: 'Current' }],
    ['pastDue', 'Past-due balance', 'money', {}], ['payFrom', 'Pays from', 'select', { opts: [['', '—']].concat(L(METHODS)) }],
    ['autopay', 'Autopay', 'select', { opts: [['', '—'], ['Yes', 'Yes'], ['No', 'No']] }],
    ['portal', 'Payment portal link', 'url', { full: 1, hint: "The biller's own payment page, opened by the Pay button" }],
    ['source', 'Usually paid with', 'select', { opts: sourceOpts() }], ['accountRef', 'Account reference', 'text', { hint: 'Last 4 digits or a nickname only' }],
    ['notes', 'Notes', 'textarea', { full: 1 }]] },
  debt: { coll: 'debts', title: 'Debt', fields: () => [
    ['name', 'Debt', 'text', { req: 1, full: 1 }], ['balance', 'Balance', 'money', { req: 1 }], ['asOf', 'Balance as of', 'date', { def: todayISO() }],
    ['payment', 'Monthly payment', 'money', {}], ['dueDay', 'Due day of month', 'int', {}], ['apr', 'Plan rate (APR %)', 'percent', { hint: '0 for a 0% plan' }],
    ['type', 'Type', 'select', { opts: L(DEBT_TYPES), def: 'Credit card' }], ['owner', 'Owner', 'select', { opts: owners(), def: 'p1' }],
    ['share', `${S().p1} part if Shared (%)`, 'percent', {}], ['institution', 'Institution', 'text', {}], ['collector', 'Managed by / collector', 'text', {}],
    ['status', 'Status', 'select', { opts: L(DEBT_STATUS), def: 'Current' }], ['include', 'Count in totals', 'select', { opts: L(INCLUDE), def: 'Yes' }],
    ['terms', 'Plan / terms', 'text', { full: 1 }],
    ['portal', 'Payment portal link', 'url', { full: 1, hint: "The lender or collector's own payment page" }],
    ['source', 'Usually paid with', 'select', { opts: sourceOpts() }], ['accountRef', 'Account reference', 'text', { hint: 'Last 4 digits or a nickname only' }],
    ['notes', 'Notes', 'textarea', { full: 1 }]] },
  payment: { coll: 'payments', title: 'Payment', fields: () => [
    ['itemId', 'What was paid', 'item', { req: 1, full: 1 }], ['amount', 'Amount', 'money', { req: 1 }], ['date', 'Date paid', 'date', { req: 1, def: todayISO() }],
    ['paidBy', 'Paid by', 'select', { opts: payers(), def: S().me || 'p1' }], ['kind', 'Kind', 'select', { opts: L(KINDS), def: 'Scheduled' }],
    ['method', 'Paid from', 'select', { opts: [['', '—']].concat(L(METHODS)) }], ['conf', 'Confirmation #', 'text', {}], ['notes', 'Notes', 'textarea', { full: 1 }]] },
  action: { coll: 'actions', title: 'Action', fields: () => [
    ['title', 'Action', 'text', { req: 1, full: 1 }], ['detail', 'Detail', 'textarea', { full: 1 }], ['owner', 'Owner', 'select', { opts: owners(), def: 'shared' }],
    ['deadline', 'Deadline', 'date', {}], ['amount', 'Amount', 'money', {}], ['priority', 'Priority', 'select', { opts: L(PRIORITIES), def: 'Normal' }],
    ['status', 'Status', 'select', { opts: L(ACTION_STATUS), def: 'Open' }]] },
  decision: { coll: 'decisions', title: 'Decision', fields: () => [
    ['request', 'Request or decision', 'text', { req: 1, full: 1 }], ['date', 'Date', 'date', { def: todayISO() }], ['by', 'Raised by', 'select', { opts: payers(), def: S().me || 'p1' }],
    ['amount', 'Amount', 'money', {}], ['link', 'Linked item', 'item', {}], ['notes', 'Notes', 'textarea', { full: 1 }]] },
  cash: { coll: 'cash', title: 'Money in or out', fields: () => [
    ['desc', 'Description', 'text', { req: 1, full: 1 }], ['amount', 'Amount', 'money', { req: 1 }], ['dir', 'Direction', 'select', { opts: [['Out', 'Out'], ['In', 'In']], def: 'Out' }],
    ['date', 'Date', 'date', { def: todayISO() }], ['cls', 'Class', 'select', { opts: L(CASH_CLASS), def: 'Discretionary' }], ['person', 'Person', 'select', { opts: payers(), def: S().me || 'joint' }],
    ['account', 'Account', 'text', {}], ['notes', 'Notes', 'textarea', { full: 1 }]] },
  account: { coll: 'accounts', title: 'Account', fields: () => [
    ['name', 'Account', 'text', { req: 1, full: 1 }], ['balance', 'Balance', 'money', { req: 1 }], ['asOf', 'As of', 'date', { def: todayISO() }], ['owner', 'Owner', 'select', { opts: payers(), def: 'joint' }]] },
};
function itemOptions(sel) {
  const g = (label, arr) => `<optgroup label="${label}">${arr.map(i => `<option value="${i.id}" ${sel === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</optgroup>`;
  const its = items().filter(i => i.name).sort((a, b) => a.name.localeCompare(b.name));
  return `<option value="">Choose…</option><option value="transfer" ${sel === 'transfer' ? 'selected' : ''}>Transfer between you (settle up)</option>${g('Bills', its.filter(i => i.kind === 'bill'))}${g('Debts', its.filter(i => i.kind === 'debt'))}`;
}
function openForm(type, id, prefill = {}) {
  const F = FORMS[type], rec = id ? state[F.coll].find(r => r.id === id) : null, v = Object.assign({}, rec || {}, prefill);
  if (type === 'payment' && v.itemKind === 'transfer') v.itemId = 'transfer';
  const fields = F.fields().map(([k, label, t, o]) => {
    let val = v[k] ?? (rec ? '' : o.def ?? '');
    if (t === 'percent' && val !== '' && val != null) val = +(num(val) * 100).toFixed(4);
    let input;
    if (t === 'select') input = `<select name="${k}">${o.opts.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(val) === String(ov) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`;
    else if (t === 'item') input = `<select name="${k}" ${o.req ? 'required' : ''}>${itemOptions(val)}</select>`;
    else if (t === 'textarea') input = `<textarea name="${k}">${esc(val)}</textarea>`;
    else input = `<input name="${k}" type="${t === 'money' || t === 'int' || t === 'percent' ? 'number' : t}" ${t === 'money' || t === 'percent' ? 'step="any" inputmode="decimal"' : t === 'int' ? 'step="1" min="1" max="31" inputmode="numeric"' : ''} value="${esc(val)}" ${o.req ? 'required' : ''}>`;
    return `<div class="field ${o.full ? 'full' : ''}"><label>${esc(label)}</label>${input}${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ''}</div>`;
  }).join('');
  $sheet.innerHTML = `<form method="dialog" data-form="${type}" data-id="${id || ''}"><div class="sheet-head"><h2>${rec ? 'Edit' : 'New'} ${esc(F.title.toLowerCase())}</h2></div>
    <div class="sheet-body"><div class="fields">${fields}</div>${type === 'payment' ? `<p class="small muted" id="pay-rule"></p>` : ''}</div>
    <div class="sheet-foot">${rec ? `<button type="button" class="btn danger grow" data-action="delete" data-type="${type}" data-id="${id}">Delete</button>` : ''}
    <button type="button" class="btn" data-action="close">Cancel</button><button type="submit" class="btn primary">Save</button></div></form>`;
  $sheet.showModal();
  if (type === 'payment') { const f = $sheet.querySelector('form'); const upd = () => payRule(f); f.addEventListener('input', upd); f.addEventListener('change', e => { if (e.target.name === 'itemId') fillPayment(f); upd(); }); upd(); }
}
function fillPayment(f) {
  const id = f.itemId.value, it = itemById(id);
  if (!it) return;
  const m = ym(f.date.value || todayISO());
  const left = Math.max(0, it.due(m) - paidFor(it.id, m));
  if (!f.amount.value) f.amount.value = (left || it.amount || '').toString();
  if (it.owner === 'p1' || it.owner === 'p2') f.paidBy.value = it.owner;
}
function payRule(f) {
  const el = document.getElementById('pay-rule'); if (!el) return;
  const p = { itemKind: f.itemId.value === 'transfer' ? 'transfer' : 'x', kind: f.kind.value, amount: f.amount.value };
  el.textContent = needsBoth(p) ? `Needs both of you to approve before it counts (not Scheduled and ${money(S().threshold)} or more).` : f.itemId.value === 'transfer' ? `A transfer from ${who(f.paidBy.value)} to the other partner. It counts toward settle-up.` : 'Counts straight away.';
}
function submitForm(form) {
  const type = form.dataset.form, F = FORMS[type], id = form.dataset.id;
  const err = validateForm(type, form);
  if (err) return toast(err);
  const rec = id ? state[F.coll].find(r => r.id === id) : { id: uid() };
  for (const [k, , t] of F.fields()) {
    const el = form.elements[k]; if (!el) continue;
    let v = el.value.trim();
    if (t === 'money') v = v === '' ? null : num(v);
    else if (t === 'int') v = v === '' ? null : Math.round(num(v));
    else if (t === 'percent') v = v === '' ? null : num(v) / 100;
    else if (v === '') v = null;
    rec[k] = v;
  }
  if (type === 'payment') {
    if (rec.itemId === 'transfer') { rec.itemKind = 'transfer'; rec.itemId = null; } else { const it = itemById(rec.itemId); rec.itemKind = it ? it.kind : 'bill'; rec.itemName = it ? it.name : rec.itemName; }
    rec.approvals = rec.approvals || {};
    if (needsBoth(rec) && S().me && rec.approvals[S().me] == null) rec.approvals[S().me] = true;
  }
  if (!id) state[F.coll].push(rec);
  afterSave(type, rec, !id);
  $sheet.close(); rerender(); toast(`${F.title} saved`);
}

/* ---------------- events ---------------- */
document.addEventListener('click', e => {
  const goEl = e.target.closest('[data-go]'); if (goEl) { location.hash = '#/' + goEl.dataset.go; return; }
  const a = e.target.closest('[data-action]'); if (!a) return;
  const act = a.dataset.action, id = a.dataset.id;
  if (a.tagName === 'A') e.preventDefault();
  const find = (coll) => state[coll].find(r => r.id === id);
  switch (act) {
    case 'new-payment': return openForm('payment', null);
    case 'new-bill': return openForm('bill', null);
    case 'new-debt': return openForm('debt', null);
    case 'new-action': return openForm('action', null);
    case 'new-decision': return openForm('decision', null);
    case 'new-cash': return openForm('cash', null);
    case 'new-account': return openForm('account', null);
    case 'edit-bill': return openForm('bill', id);
    case 'edit-debt': return openForm('debt', id);
    case 'edit-payment': return openForm('payment', id);
    case 'edit-action': return openForm('action', id);
    case 'edit-decision': return openForm('decision', id);
    case 'edit-cash': return openForm('cash', id);
    case 'edit-account': return openForm('account', id);
    case 'close': return $sheet.close();
    case 'delete': {
      const F = FORMS[a.dataset.type];
      if (!confirm(`Delete this ${F.title.toLowerCase()}? This cannot be undone.`)) return;
      const gone = state[F.coll].find(r => r.id === id); state[F.coll] = state[F.coll].filter(r => r.id !== id); logAct(`Deleted ${F.title.toLowerCase()}`, recLabel(a.dataset.type, gone)); $sheet.close(); rerender(); return toast('Deleted');
    }
    case 'mark-paid': {
      const it = itemById(id), m = a.dataset.month || thisMonth();
      const left = Math.max(0, it.due(m) - paidFor(id, m));
      const date = m === thisMonth() ? todayISO() : dayOf(m, it.day || 1);
      const by = it.owner === 'shared' ? (S().me || 'joint') : it.owner;
      return openForm('payment', null, { itemId: id, amount: left || it.amount, date, paidBy: by, kind: 'Scheduled' });
    }
    case 'settle-transfer': return openForm('payment', null, { itemKind: 'transfer', amount: num(a.dataset.amt), paidBy: a.dataset.from, kind: 'Scheduled', notes: 'Settle up' });
    case 'approve-pay': case 'decline-pay': { const p = find('payments'); p.approvals = p.approvals || {}; p.approvals[a.dataset.who] = act === 'approve-pay'; logAct(`${who(a.dataset.who)} ${act === 'approve-pay' ? 'approved' : 'declined'} a payment`, recLabel('payment', p)); rerender(); return toast(act === 'approve-pay' ? 'Approved' : 'Declined'); }
    case 'vote': { const d = find('decisions'); d[a.dataset.who] = a.dataset.v === 'yes'; logAct(`${who(a.dataset.who)} voted ${a.dataset.v}`, d.request); if (decisionOutcome(d) === 'Approved' || decisionOutcome(d) === 'Declined') d.decided = todayISO(); return rerender(); }
    case 'toggle-action': { const x = find('actions'); x.status = x.status === 'Done' ? 'Open' : 'Done'; logAct(x.status === 'Done' ? 'Completed action' : 'Reopened action', x.title); rerender(); return toast(x.status === 'Done' ? 'Nice. Marked done.' : 'Reopened'); }
    case 'plan-month': ui.planMonth = a.dataset.v; return render();
    case 'plan-mode': ui.planMode = a.dataset.v; return render();
    case 'pay-month': ui.payMonth = a.dataset.v; return render();
    case 'bill-filter': ui.billFilter = a.dataset.v; return render();
    case 'debt-filter': ui.debtFilter = a.dataset.v; return render();
    case 'act-tab': ui.actTab = a.dataset.v; return render();
    case 'cash-month': ui.cashMonth = a.dataset.v; return render();
    case 'set-split': S().split = a.dataset.v; logAct('Changed split', SPLITS[a.dataset.v]); return rerender();
    case 'edit-agreements': return editAgreements();
    case 'export-xlsx': return exportXlsx().catch(err => toast('Export failed: ' + err.message));
    case 'export-json': return exportJson();
    case 'import': return document.getElementById('file').click();
    case 'reset': if (confirm('Erase all data on this device? Export first if you want a copy. This cannot be undone.')) { state = blankState(); rerender(); toast('Erased'); } return;
  }
});
document.addEventListener('submit', e => { const f = e.target.closest('form[data-form]'); if (f) { e.preventDefault(); submitForm(f); } });
document.addEventListener('input', e => {
  const k = e.target.dataset.input;
  if (k === 'billQ') { ui.billQ = e.target.value; const pos = e.target.selectionStart; render(); const s = $view.querySelector('[data-input="billQ"]'); s.focus(); s.setSelectionRange(pos, pos); }
});
document.addEventListener('change', e => {
  const k = e.target.dataset.input; if (k === 'debtSort') { ui.debtSort = e.target.value; render(); }
  const s = e.target.dataset.setting;
  if (s) {
    let v = e.target.value;
    if (['incomeP1', 'incomeP2', 'threshold', 'window'].includes(s)) v = v === '' ? null : num(v);
    if (s === 'defShare') v = num(v) / 100;
    if ((s === 'p1' || s === 'p2') && !v.trim()) v = s === 'p1' ? 'Partner 1' : 'Partner 2';
    if (s === 'start' && !/^\d{4}-\d{2}$/.test(v)) return;
    S()[s] = v; ui.planMonth = null; save(); toast('Saved');
    if (['p1', 'p2', 'split'].includes(s)) render();
  }
});
$sheet.addEventListener('click', e => { if (e.target === $sheet) $sheet.close(); });
function editAgreements() {
  $sheet.innerHTML = `<form method="dialog" id="agf"><div class="sheet-head"><h2>Our agreements</h2></div><div class="sheet-body"><div class="field full"><label>One per line</label><textarea name="t" style="min-height:220px">${esc(state.agreements.join('\n'))}</textarea></div></div>
    <div class="sheet-foot"><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary">Save</button></div></form>`;
  $sheet.showModal();
  $sheet.querySelector('#agf').addEventListener('submit', ev => { ev.preventDefault(); state.agreements = ev.target.t.value.split('\n').map(x => x.trim()).filter(Boolean); $sheet.close(); rerender(); });
}

/* ---------------- import / export ---------------- */
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = XLSX_URL; s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('Could not load the Excel library. Check your connection.')); document.head.appendChild(s); });
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
function exportJson() {
  download(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), `household-hub-backup-${todayISO()}.json`);
  state.meta.exported = new Date().toISOString(); save(); render(); toast('Backup downloaded');
}
const isoToSerial = iso => iso ? Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5 + 25569) : null;
const serialToIso = n => { const d = new Date(Math.round((n - 25569) * 864e5)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
async function exportXlsx() {
  const X = await loadXlsx();
  const wb = X.utils.book_new();
  const D = iso => iso ? { t: 'n', v: isoToSerial(iso), z: 'yyyy-mm-dd' } : null;
  const $ = (v, z = '$#,##0.00') => v == null || v === '' ? null : { t: 'n', v: num(v), z };
  const P = v => v == null || v === '' ? null : { t: 'n', v: num(v), z: '0.00%' };
  const add = (name, head, rows, widths) => {
    const ws = X.utils.aoa_to_sheet([head].concat(rows));
    ws['!cols'] = (widths || head.map(h => Math.max(10, String(h).length + 2))).map(w => ({ wch: w }));
    ws['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: head.length - 1 } }) };
    X.utils.book_append_sheet(wb, ws, name);
  };
  const t = totals(), cm = thisMonth();
  add('Summary', ['Measure', 'Value'], [
    ['Household', `${S().p1} and ${S().p2}`], ['As of', D(todayISO())], ['Monthly obligations', $(t.oblig)], ['  Bills (monthly equivalent)', $(t.billsMo)], ['  Debt payments', $(t.debtMo)],
    [`${S().p1} carries per month`, $(t.p1)], [`${S().p2} carries per month`, $(t.p2)], ['Debt today (counted)', $(t.debt)], ['Debt excluding family', $(t.debt - t.family)],
    ['Debts to confirm', t.checkCount], ['Past-due bills', $(t.arrears)], [`Scheduled ${monthName(cm, true)}`, $(t.sched)], [`Paid ${monthName(cm, true)}`, $(t.paid)],
    ['Settle up', settleText(settleNow())], ['Split method', SPLITS[S().split]], ['Payments awaiting approval', t.awaiting], ['Open actions', t.openActions],
  ], [34, 30]);
  add('Bills', ['Bill', 'Category', 'Payee', 'Owner', 'Partner 1 share', 'Amount', 'Frequency', 'Due day', 'First due date', 'Autopay', 'Pays from', 'Priority', 'Status', 'Past-due balance', 'Notes', 'Monthly equivalent', 'Next due', 'This month'],
    state.bills.map(b => { const it = itemById(b.id); return [b.name, b.category, b.payee, who(b.owner), P(b.share), $(b.amount), b.freq, b.dueDay, D(b.firstDue), b.autopay, b.payFrom, b.priority, b.status, $(b.pastDue), b.notes, $(billMonthly(b)), D(nextDue(it)), STATUS_TEXT[monthStatus(it, cm)]]; }),
    [30, 18, 18, 10, 9, 12, 12, 8, 12, 8, 12, 9, 10, 12, 44, 12, 12, 11]);
  add('Debts', ['Debt', 'Type', 'Institution', 'Managed by', 'Owner', 'Partner 1 share', 'Balance', 'Balance as of', 'Plan APR', 'Monthly payment', 'Due day', 'Plan / terms', 'Status', 'Count in totals', 'Notes', 'Paid since', 'Balance today', 'Payoff months'],
    state.debts.map(d => { const n = payoffMonths(d); return [d.name, d.type, d.institution, d.collector, who(d.owner), P(d.share), $(d.balance), D(d.asOf), P(d.apr), $(d.payment), d.dueDay, d.terms, d.status, d.include, d.notes, $(paidSince(d.id, debtFrom(d))), $(debtBalance(d)), n === Infinity ? 'Never' : n]; }),
    [32, 13, 18, 22, 10, 9, 12, 12, 9, 12, 8, 24, 14, 9, 44, 12, 12, 10]);
  add('Payments', ['Date', 'Item', 'Type', 'Paid by', 'Amount', 'Kind', 'Paid from', 'Confirmation', 'Notes', `${S().p1} approval`, `${S().p2} approval`, 'Status', 'Counted'],
    state.payments.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(p => { const it = itemById(p.itemId); const ap = v => v === true ? 'Yes' : v === false ? 'No' : '';
      return [D(p.date), p.itemKind === 'transfer' ? 'Transfer between partners' : (it ? it.name : p.itemName), p.itemKind, who(p.paidBy), $(p.amount), p.kind, p.method, p.conf, p.notes, ap((p.approvals || {}).p1), ap((p.approvals || {}).p2), payStatus(p), $(counted(p))]; }),
    [12, 32, 9, 10, 12, 20, 12, 14, 40, 12, 12, 16, 12]);
  const ms = months(), its = items().filter(i => i.name);
  add('Plan', ['Item', 'Type', 'Owner'].concat(ms.flatMap(m => [`${monthName(m)} due`, `${monthName(m)} paid`])),
    its.map(it => [it.name, it.kind, who(it.owner)].concat(ms.flatMap(m => [$(it.due(m), '$#,##0'), $(paidFor(it.id, m), '$#,##0')]))),
    [32, 7, 10].concat(ms.flatMap(() => [10, 10])));
  add('Settle Up', ['Month', 'Scheduled', `${S().p1} fair share`, `${S().p2} fair share`, `${S().p1} paid`, `${S().p2} paid`, 'Still to pay', 'Transfer to P2', 'Transfer to P1', `${S().p1} over/under`, 'Running'],
    settleRows().map(r => [monthName(r.m, true), $(r.C), $(r.fair1), $(r.fair2), $(r.paid1), $(r.paid2), $(r.left), $(r.t12), $(r.t21), r.future ? null : $(r.over), r.future ? null : $(r.run)]),
    [14, 12, 14, 14, 12, 12, 12, 12, 12, 14, 12]);
  add('Actions', ['Action', 'Detail', 'Owner', 'Deadline', 'Amount', 'Priority', 'Status', 'Flag'],
    state.actions.map(a => [a.title, a.detail, who(a.owner), D(a.deadline), $(a.amount), a.priority, a.status, actionFlag(a)]), [36, 56, 10, 12, 12, 10, 12, 12]);
  add('Decisions', ['Date', 'Request', 'Raised by', 'Amount', 'Linked item', `${S().p1} says`, `${S().p2} says`, 'Outcome', 'Decided on', 'Notes'],
    state.decisions.map(d => [D(d.date), d.request, who(d.by), $(d.amount), (itemById(d.link) || {}).name || '', d.p1 === true ? 'Yes' : d.p1 === false ? 'No' : '', d.p2 === true ? 'Yes' : d.p2 === false ? 'No' : '', decisionOutcome(d), D(d.decided), d.notes]),
    [12, 44, 10, 12, 24, 10, 10, 20, 12, 36]);
  add('Cash Flow', ['Date', 'Description', 'Direction', 'Class', 'Person', 'Amount', 'Account', 'Notes'],
    state.cash.map(c => [D(c.date), c.desc, c.dir, c.cls, who(c.person), $(c.amount), c.account, c.notes]), [12, 34, 9, 13, 10, 12, 16, 40]);
  add('Accounts', ['Account', 'Owner', 'Balance', 'As of'], state.accounts.map(a => [a.name, who(a.owner), $(a.balance), D(a.asOf)]), [24, 10, 12, 12]);
  add('Settings', ['Setting', 'Value'], [['Partner 1', S().p1], ['Partner 2', S().p2], ['Partner 1 take-home', $(S().incomeP1)], ['Partner 2 take-home', $(S().incomeP2)],
    ['Split', S().split], ['Partner 1 default share', P(S().defShare)], ['Plan start', S().start], ['Approval threshold', $(S().threshold)], ['Due-soon window', S().window]].concat(state.agreements.map((a, i) => [`Agreement ${i + 1}`, a])), [26, 60]);
  exportExtra(add, D, $);
  X.writeFile(wb, `Household Hub ${todayISO()}.xlsx`, { compression: true });
  state.meta.exported = new Date().toISOString(); save(); render(); toast('Excel workbook downloaded');
}

document.getElementById('file').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    let next;
    if (/\.json$/i.test(f.name)) next = normalize(JSON.parse(await f.text()));
    else next = importWorkbook((await loadXlsx()).read(await f.arrayBuffer(), { type: 'array' }));
    if (state.bills.length + state.debts.length + state.payments.length && !confirm(`Replace the data on this device with "${f.name}"?`)) return;
    state = next; ui.planMonth = null; logAct('Imported data', f.name); rerender();
    toast(`Imported ${state.bills.length} bills, ${state.debts.length} debts, ${state.payments.length} payments`);
  } catch (err) { console.error(err); toast('Could not read that file: ' + err.message); }
});

function importWorkbook(wb) {
  const X = window.XLSX, out = blankState();
  const sh = n => wb.Sheets[n] || wb.Sheets[Object.keys(wb.Sheets).find(k => k.trim().toLowerCase() === n.toLowerCase())];
  const cell = (ws, ref) => { const c = ws && ws[ref]; return c ? c.v : undefined; };
  const str = v => v == null ? null : String(v).trim() || null;
  const dateV = v => v == null || v === '' ? null : typeof v === 'number' ? serialToIso(v) : /^\d{4}-\d{2}-\d{2}/.test(v) ? String(v).slice(0, 10) : (isNaN(Date.parse(v)) ? null : new Date(v).toISOString().slice(0, 10));
  const numV = v => v == null || v === '' ? null : num(v);
  const isHub = sh('Bills') && String(cell(sh('Bills'), 'B5') || '').trim() === 'Bill';
  const isApp = sh('Bills') && String(cell(sh('Bills'), 'A1') || '').trim() === 'Bill';
  if (!isHub && !isApp) throw new Error('No Bills tab in the expected layout');
  let p1, p2;
  if (isHub) { const s = sh('Settings'); p1 = str(cell(s, 'C6')) || 'Partner 1'; p2 = str(cell(s, 'C7')) || 'Partner 2'; }
  else { const s = X.utils.sheet_to_json(sh('Settings'), { header: 1 }); const g = k => (s.find(r => r[0] === k) || [])[1]; p1 = g('Partner 1') || 'Partner 1'; p2 = g('Partner 2') || 'Partner 2'; }
  const ownerKey = v => { const s = String(v ?? '').trim().toLowerCase(); return s === p1.toLowerCase() ? 'p1' : s === p2.toLowerCase() ? 'p2' : s === 'joint' ? 'joint' : s === 'shared' ? 'shared' : s ? 'shared' : null; };
  const st = out.settings; st.p1 = p1; st.p2 = p2;
  const rows = (ws, r0, r1, c0, c1) => { const res = []; for (let r = r0; r <= r1; r++) { const row = []; for (let c = c0; c <= c1; c++) row.push(cell(ws, X.utils.encode_cell({ r: r - 1, c }))); res.push(row); } return res; };
  if (isHub) {
    const s = sh('Settings');
    st.incomeP1 = numV(cell(s, 'C8')); st.incomeP2 = numV(cell(s, 'C9'));
    st.split = ({ 'By owner': 'owner', 'By income': 'income', '50/50': 'even' })[cell(s, 'C10')] || 'owner';
    st.defShare = numV(cell(s, 'C11')) ?? 0.5; st.start = (dateV(cell(s, 'C12')) || `${st.start}-01`).slice(0, 7);
    st.threshold = numV(cell(s, 'C13')) ?? 250; st.window = numV(cell(s, 'C14')) ?? 14;
    const transferName = str(cell(s, 'C15')) || 'Settlement transfer';
    for (const r of rows(sh('Bills'), 6, 60, 1, 15)) if (str(r[0])) out.bills.push({ id: uid(), name: str(r[0]), category: str(r[1]), payee: str(r[2]), owner: ownerKey(r[3]) || 'shared', share: numV(r[4]), amount: numV(r[5]), freq: str(r[6]) || 'Monthly', dueDay: numV(r[7]), firstDue: dateV(r[8]), autopay: str(r[9]), payFrom: str(r[10]), priority: str(r[11]) || 'Normal', status: str(r[12]) || 'Current', pastDue: numV(r[13]), notes: str(r[14]) });
    for (const r of rows(sh('Debts'), 6, 70, 1, 15)) if (str(r[0]) && !String(r[0]).startsWith('Total')) out.debts.push({ id: uid(), name: str(r[0]), type: str(r[1]), institution: str(r[2]), collector: str(r[3]), owner: ownerKey(r[4]) || 'p1', share: numV(r[5]), balance: numV(r[6]), asOf: dateV(r[7]), apr: numV(r[8]), payment: numV(r[9]), dueDay: numV(r[10]), terms: str(r[11]), status: str(r[12]) || 'Current', include: str(r[13]) || 'Yes', notes: str(r[14]) });
    const byName = n => out.bills.find(b => b.name === n) || out.debts.find(d => d.name === n);
    for (const r of rows(sh('Ledger'), 6, 1000, 1, 9)) {
      if (!r[1] || !r[3] || String(r[8] || '').startsWith('Example row')) continue;
      const transfer = String(r[1]).trim() === transferName, it = byName(String(r[1]).trim()), appr = str(r[7]);
      out.payments.push({ id: uid(), date: dateV(r[0]) || todayISO(), itemId: it ? it.id : null, itemName: str(r[1]), itemKind: transfer ? 'transfer' : out.bills.includes(it) ? 'bill' : 'debt', paidBy: ownerKey(r[2]) || 'joint', amount: numV(r[3]), kind: str(r[4]) || 'Scheduled', method: str(r[5]), conf: str(r[6]),
        approvals: appr === 'Approved' ? { p1: true, p2: true } : appr === 'Disputed' ? { p1: false } : {}, notes: str(r[8]) });
    }
    for (const r of rows(sh('Actions'), 6, 100, 2, 8)) if (str(r[0])) out.actions.push({ id: uid(), title: str(r[0]), detail: str(r[1]), owner: ownerKey(r[2]) || 'shared', deadline: dateV(r[3]), amount: numV(r[4]), priority: str(r[5]) || 'Normal', status: str(r[6]) || 'Open' });
    for (const r of rows(sh('Decisions'), 15, 200, 1, 10)) if (str(r[1])) { const link = byName(String(r[4] || '').trim()); out.decisions.push({ id: uid(), date: dateV(r[0]), request: str(r[1]), by: ownerKey(r[2]), amount: numV(r[3]), link: link ? link.id : null, p1: r[5] === 'Yes' ? true : r[5] === 'No' ? false : null, p2: r[6] === 'Yes' ? true : r[6] === 'No' ? false : null, decided: dateV(r[8]), notes: str(r[9]) }); }
    const cf = sh('Cash Flow');
    if (cf) {
      for (const r of rows(cf, 6, 1000, 1, 8)) if (str(r[1]) && r[5] != null) out.cash.push({ id: uid(), date: dateV(r[0]), desc: str(r[1]), dir: str(r[2]) || 'Out', cls: str(r[3]), person: ownerKey(r[4]) || 'joint', amount: numV(r[5]), account: str(r[6]), notes: str(r[7]) });
      for (const r of rows(cf, 6, 60, 11, 14)) if (str(r[0])) out.accounts.push({ id: uid(), name: str(r[0]), owner: ownerKey(r[1]) || 'joint', balance: numV(r[2]), asOf: dateV(r[3]) });
    }
    return out;
  }
  // this app's own Excel export
  const J = n => sh(n) ? X.utils.sheet_to_json(sh(n), { defval: null }) : [];
  const s = X.utils.sheet_to_json(sh('Settings'), { header: 1 }); const g = k => (s.find(r => r[0] === k) || [])[1];
  st.incomeP1 = numV(g('Partner 1 take-home')); st.incomeP2 = numV(g('Partner 2 take-home')); st.split = g('Split') || 'owner'; st.defShare = numV(g('Partner 1 default share')) ?? 0.5;
  st.start = String(g('Plan start') || st.start); st.threshold = numV(g('Approval threshold')) ?? 250; st.window = numV(g('Due-soon window')) ?? 14;
  const ag = s.filter(r => String(r[0] || '').startsWith('Agreement')).map(r => r[1]); if (ag.length) out.agreements = ag;
  out.bills = J('Bills').filter(r => r.Bill).map(r => ({ id: uid(), name: str(r.Bill), category: str(r.Category), payee: str(r.Payee), owner: ownerKey(r.Owner), share: numV(r['Partner 1 share']), amount: numV(r.Amount), freq: str(r.Frequency) || 'Monthly', dueDay: numV(r['Due day']), firstDue: dateV(r['First due date']), autopay: str(r.Autopay), payFrom: str(r['Pays from']), priority: str(r.Priority), status: str(r.Status), pastDue: numV(r['Past-due balance']), notes: str(r.Notes) }));
  out.debts = J('Debts').filter(r => r.Debt).map(r => ({ id: uid(), name: str(r.Debt), type: str(r.Type), institution: str(r.Institution), collector: str(r['Managed by']), owner: ownerKey(r.Owner), share: numV(r['Partner 1 share']), balance: numV(r.Balance), asOf: dateV(r['Balance as of']), apr: numV(r['Plan APR']), payment: numV(r['Monthly payment']), dueDay: numV(r['Due day']), terms: str(r['Plan / terms']), status: str(r.Status), include: str(r['Count in totals']) || 'Yes', notes: str(r.Notes) }));
  const byName = n => out.bills.find(b => b.name === n) || out.debts.find(d => d.name === n);
  const yn = v => v === 'Yes' ? true : v === 'No' ? false : null;
  out.payments = J('Payments').filter(r => r.Amount != null).map(r => { const it = byName(r.Item); const a1 = yn(r[`${p1} approval`]), a2 = yn(r[`${p2} approval`]);
    return { id: uid(), date: dateV(r.Date), itemId: it ? it.id : null, itemName: str(r.Item), itemKind: r.Type === 'transfer' ? 'transfer' : str(r.Type) || 'bill', paidBy: ownerKey(r['Paid by']) || 'joint', amount: numV(r.Amount), kind: str(r.Kind) || 'Scheduled', method: str(r['Paid from']), conf: str(r.Confirmation), notes: str(r.Notes), approvals: Object.assign({}, a1 != null && { p1: a1 }, a2 != null && { p2: a2 }) }; });
  out.actions = J('Actions').filter(r => r.Action).map(r => ({ id: uid(), title: str(r.Action), detail: str(r.Detail), owner: ownerKey(r.Owner), deadline: dateV(r.Deadline), amount: numV(r.Amount), priority: str(r.Priority) || 'Normal', status: str(r.Status) || 'Open' }));
  out.decisions = J('Decisions').filter(r => r.Request).map(r => { const l = byName(r['Linked item']); return { id: uid(), date: dateV(r.Date), request: str(r.Request), by: ownerKey(r['Raised by']), amount: numV(r.Amount), link: l ? l.id : null, p1: yn(r[`${p1} says`]), p2: yn(r[`${p2} says`]), decided: dateV(r['Decided on']), notes: str(r.Notes) }; });
  out.cash = J('Cash Flow').filter(r => r.Description).map(r => ({ id: uid(), date: dateV(r.Date), desc: str(r.Description), dir: str(r.Direction) || 'Out', cls: str(r.Class), person: ownerKey(r.Person) || 'joint', amount: numV(r.Amount), account: str(r.Account), notes: str(r.Notes) }));
  out.accounts = J('Accounts').filter(r => r.Account).map(r => ({ id: uid(), name: str(r.Account), owner: ownerKey(r.Owner) || 'joint', balance: numV(r.Balance), asOf: dateV(r['As of']) }));
  importExtra(J, g, out, { str, numV, dateV, ownerKey, byName });
  return normalize(out);
}

/* ---------------- boot ---------------- */
window.hub = { get state() { return state; }, importWorkbook, loadXlsx, set(s) { state = normalize(s); rerender(); }, totals, settleRows };
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
// boot happens at the end of more.js
