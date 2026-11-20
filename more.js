/* Household Hub, part 2: pay schedules, per-paycheck responsibility lists, email and calendar
   reminders, month-end confirmations, personal dashboards, payment portals, statements and the
   activity log. Shares the global scope of app.js. */
'use strict';

const PAY_FREQ = { semimonthly: 'Twice a month (15th and last day)', biweekly: 'Every 2 weeks', weekly: 'Every week', monthly: 'Once a month' };
const CHECKS_PER_MONTH = { weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2, monthly: 1 };
const SOURCE_TYPES = ['Debit card', 'Checking', 'Savings', 'Credit card', 'Other'];
const LONG_DIGITS = /\d[\d\s-]{7,}\d/;

/* ---------- small date helpers ---------- */
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function isoOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(iso, n) { const d = parseISO(iso); d.setDate(d.getDate() + n); return isoOf(d); }
function weekendBack(iso) { const d = parseISO(iso), w = d.getDay(); if (w === 6) d.setDate(d.getDate() - 1); if (w === 0) d.setDate(d.getDate() - 2); return isoOf(d); }
function other(k) { return k === 'p1' ? 'p2' : 'p1'; }
function myShare(it, k) { const s = shareP1(it.owner, it.share); return k === 'p1' ? s : 1 - s; }

/* ---------- hooks used by app.js ---------- */
function sourceOpts() { return [['', '—']].concat(state.sources.map(s => [s.id, srcLabel(s)])); }
function srcLabel(s) { return s ? `${s.name}${s.last4 ? ' ••' + s.last4 : ''}` : ''; }
function recLabel(type, r) {
  if (!r) return '';
  if (type === 'payment') return `${r.itemKind === 'transfer' ? 'Transfer' : ((itemById(r.itemId) || {}).name || r.itemName || 'Payment')} ${money(r.amount, true)}`;
  if (type === 'statement') return `${(itemById(r.itemId) || {}).name || 'Statement'} ${money(r.balance, true)}`;
  return r.name || r.title || r.request || r.desc || '';
}
function logAct(what, detail) {
  state.activity.unshift({ at: new Date().toISOString(), who: S().me || '', what, detail: detail || '' });
  if (state.activity.length > 500) state.activity.length = 500;
}
function validateForm(type, form) {
  const v = n => (form.elements[n] ? form.elements[n].value.trim() : '');
  if (type === 'bill' || type === 'debt') {
    if (LONG_DIGITS.test(v('accountRef'))) return 'For safety, keep only the last 4 digits or a nickname, never a full number.';
    if (v('portal') && !/^https:\/\//i.test(v('portal'))) return 'Payment links must start with https://';
  }
  if (type === 'source' && v('last4') && !/^\d{4}$/.test(v('last4'))) return 'Last 4 must be exactly 4 digits. Never enter a full card or account number.';
  if (type === 'statement') { if (!v('itemId') || v('itemId') === 'transfer') return 'Choose the account the statement is for'; if (v('link') && !/^https:\/\//i.test(v('link'))) return 'Statement links must start with https://'; }
  for (const n of ['notes', 'detail', 'desc', 'name']) if (LONG_DIGITS.test(v(n)) && /card|acct|account|routing|swift|iban|number/i.test(v(n))) return 'That looks like a full card or account number. Keep only the last 4 digits.';
  return null;
}
function afterSave(type, rec, isNew) {
  logAct(`${isNew ? 'Added' : 'Updated'} ${FORMS[type].title.toLowerCase()}`, recLabel(type, rec));
  if (type === 'statement' && rec.update !== 'No') {
    const d = state.debts.find(x => x.id === rec.itemId);
    if (d && rec.balance != null && (!d.asOf || rec.date >= d.asOf)) { d.balance = rec.balance; d.asOf = rec.date; logAct('Debt balance updated from statement', `${d.name} ${money(rec.balance, true)}`); }
  }
}

/* ---------- forms ---------- */
FORMS.source = { coll: 'sources', title: 'Payment method', fields: () => [
  ['name', 'Name', 'text', { req: 1, full: 1, hint: 'For example BofA checking or Chase debit' }], ['type', 'Type', 'select', { opts: L(SOURCE_TYPES), def: 'Debit card' }],
  ['last4', 'Last 4 digits', 'text', { hint: 'Only the last 4. Never the full number.' }], ['bank', 'Bank', 'text', {}],
  ['owner', 'Belongs to', 'select', { opts: payers(), def: 'joint' }]] };
FORMS.statement = { coll: 'statements', title: 'Statement', fields: () => [
  ['itemId', 'Account', 'item', { req: 1, full: 1 }], ['date', 'Statement date', 'date', { req: 1, def: todayISO() }], ['balance', 'Statement balance', 'money', { req: 1 }],
  ['minDue', 'Minimum due', 'money', {}], ['dueDate', 'Payment due by', 'date', {}],
  ['update', 'Update the debt balance', 'select', { opts: [['Yes', 'Yes, use this as the new balance'], ['No', 'No']], def: 'Yes' }],
  ['link', 'Link to the statement', 'url', { full: 1, hint: "A link to the PDF in your own Drive or the bank's site" }], ['notes', 'Notes', 'textarea', { full: 1 }]] };

/* ---------- pay schedules ---------- */
function paydays(k, from, to) {
  const p = S().pay[k]; if (!p) return [];
  const out = [];
  if (p.freq === 'weekly' || p.freq === 'biweekly') {
    if (!p.next) return [];
    const step = p.freq === 'weekly' ? 7 : 14; let d = p.next;
    while (d > from) d = addDays(d, -step);
    while (d < from) d = addDays(d, step);
    while (d <= to) { out.push(d); d = addDays(d, step); }
  } else if (p.freq === 'monthly') {
    if (!p.next) return [];
    const day = +p.next.slice(8);
    for (let i = -1; i < 40; i++) { const d = weekendBack(dayOf(addMonths(ym(from), i), day)); if (d > to) break; if (d >= from) out.push(d); }
  } else {
    for (let i = -1; i < 40; i++) {
      const mm = addMonths(ym(from), i);
      for (const d0 of [`${mm}-15`, dayOf(mm, 31)]) { const d = weekendBack(d0); if (d > to) return out; if (d >= from) out.push(d); }
    }
  }
  return out;
}
function periodEnd(k, payday) { const n = paydays(k, addDays(payday, 1), addDays(payday, 70))[0]; return n ? addDays(n, -1) : addDays(payday, 13); }
function periodItems(k, start, end) {
  const res = [];
  for (const it of items()) {
    const sh = myShare(it, k); if (sh <= 0 || !it.name) continue;
    for (let m = ym(start); m <= ym(end); m = addMonths(m, 1)) {
      const due = it.due(m); if (!due) continue;
      const d = dayOf(m, it.day || 1); if (d < start || d > end) continue;
      const paid = paidFor(it.id, m);
      res.push({ it, date: d, m, full: due, share: sh, mine: due * sh, left: Math.max(0, due - paid) * sh, paid, status: monthStatus(it, m) });
    }
  }
  return res.sort((a, b) => a.date.localeCompare(b.date) || a.it.name.localeCompare(b.it.name));
}
function overdueBefore(k, start) {
  const cm = thisMonth(), res = [];
  for (const it of items()) {
    const sh = myShare(it, k); if (sh <= 0 || !it.name) continue;
    if (monthStatus(it, cm) === 'missed' && dayOf(cm, it.day || 1) < start) res.push({ it, date: dayOf(cm, it.day || 1), left: Math.max(0, it.due(cm) - paidFor(it.id, cm)) * sh, share: sh });
  }
  const arrears = state.bills.filter(b => !b.pending && num(b.pastDue) > 0 && myShare(itemById(b.id), k) > 0).map(b => ({ name: b.name, amt: num(b.pastDue) * myShare(itemById(b.id), k) }));
  return { list: res, arrears };
}
function carryOf(k) { const t = totals(); return k === 'p1' ? t.p1 : t.p2; }
function settleFor(k) {
  const pos = settleNow(), v = k === 'p1' ? pos : -pos;
  if (Math.abs(v) < 1) return 'You are all square';
  return v > 0 ? `${S()[other(k)]} owes you ${money(v)}` : `You owe ${S()[other(k)]} ${money(-v)}`;
}

/* ---------- emails ---------- */
function appLink() { return S().appUrl || (location.protocol.startsWith('http') ? location.origin + location.pathname : ''); }
function line(r) { return `• ${dateShort(r.date)}: ${r.it.name}, ${money(r.left || r.mine, true)}${r.share < 1 ? ` (your ${pct(r.share)} of ${money(r.full, true)})` : ''}${r.it.ref.portal ? `\n    Pay: ${r.it.ref.portal}` : ''}`; }
function paycheckEmail(k, payday) {
  const name = S()[k], end = periodEnd(k, payday), list = periodItems(k, payday, end);
  const open = list.filter(r => !['paid', 'extra'].includes(r.status)), done = list.filter(r => ['paid', 'extra'].includes(r.status));
  const total = open.reduce((t, r) => t + r.left, 0), od = overdueBefore(k, payday), odTotal = od.list.reduce((t, r) => t + r.left, 0);
  const take = num(S().pay[k].amount);
  const L_ = [];
  L_.push(`Hi ${name},`, '', `Payday: ${dateLong(payday)}. These are the bills that fall to you before your next payday (${dateLong(addDays(end, 1))}).`, '');
  if (open.length) { L_.push(`To pay from this paycheck (${open.length}):`); open.forEach(r => L_.push(line(r))); L_.push('', `Total from this paycheck: ${money(total, true)}`); }
  else L_.push('Nothing left to pay in this window.');
  if (take) L_.push(`Take-home this paycheck: ${money(take, true)}. Left after these bills: ${money(take - total, true)}.`);
  if (od.list.length) { L_.push('', `Overdue from earlier this month (${money(odTotal, true)}):`); od.list.forEach(r => L_.push(`• ${r.it.name}, ${money(r.left, true)}`)); }
  if (od.arrears.length) { L_.push('', 'Past-due balances to catch up:'); od.arrears.forEach(a => L_.push(`• ${a.name}, ${money(a.amt, true)}`)); }
  if (done.length) { L_.push('', `Already paid in this window: ${done.map(r => r.it.name).join(', ')}.`); }
  L_.push('', `Each month you carry ${money(carryOf(k))}, including your part of shared bills. Settle up: ${settleFor(k)}.`);
  if (appLink()) L_.push(`Log each payment in Household Hub: ${appLink()}`);
  L_.push('', 'Household Hub');
  return { to: [S().emails[k]].filter(Boolean), cc: S().ccPartner ? [S().emails[other(k)]].filter(Boolean) : [], subject: `Your bills for the ${dateShort(payday)} paycheck: ${money(total)} (${name})`, body: L_.join('\n'), total };
}
function monthEndEmail(m) {
  const its = items().filter(i => i.name), rows = its.map(it => ({ it, due: it.due(m), paid: paidFor(it.id, m) })).filter(r => r.due || r.paid);
  const pays = state.payments.filter(p => ym(p.date) === m).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const counted_ = pays.filter(p => payStatus(p) === 'Counted'), waiting = pays.filter(p => payStatus(p) === 'Awaiting approval');
  const unpaid = rows.filter(r => r.due && r.paid < r.due - 0.005);
  const sched = rows.reduce((t, r) => t + r.due, 0), paid = rows.reduce((t, r) => t + (r.due ? Math.min(r.paid, r.due) : r.paid), 0);
  const sr = settleRows().find(r => r.m === m);
  const name = p => p.itemKind === 'transfer' ? `Transfer ${who(p.paidBy)} to ${who(other(p.paidBy))}` : ((itemById(p.itemId) || {}).name || p.itemName);
  const L_ = [`Hi ${S().p1} and ${S().p2},`, '', `Here is how ${monthName(m, true)} closed.`, '',
    `Scheduled ${money(sched)} · Paid ${money(paid)} (${sched ? pct(paid / sched) : '0%'}) · Still unpaid ${money(Math.max(0, sched - paid))}`, ''];
  L_.push(`Payments confirmed (${counted_.length}):`);
  counted_.forEach(p => L_.push(`• ${dateShort(p.date)}: ${name(p)}, ${money(p.amount, true)}, paid by ${who(p.paidBy)}${p.conf ? `, confirmation ${p.conf}` : ''}`));
  if (!counted_.length) L_.push('• None logged');
  const misc = state.misc.filter(x => ym(x.date) === m && x.status === 'Paid' && miscStatus(x) === 'Counted');
  if (misc.length) { L_.push('', `Miscellaneous costs (${misc.length}, ${money(misc.reduce((t, x) => t + num(x.amount), 0), true)}):`); misc.forEach(x => L_.push(`• ${dateShort(x.date)}: ${x.desc}, ${money(x.amount, true)}, paid by ${who(x.paidBy)}, carried by ${who(x.owner)}`)); }
  const unsigned = state.changes.filter(c => c.status === 'Pending');
  if (unsigned.length) { L_.push('', `Changes waiting for both signatures (${unsigned.length}). The current terms stay binding until you both sign:`); unsigned.forEach(c => L_.push(`• ${changeTitle(c)}`)); }
  if (unpaid.length) { L_.push('', `Still unpaid (${unpaid.length}):`); unpaid.forEach(r => L_.push(`• ${r.it.name}, ${money(r.due - r.paid, true)} (${who(r.it.owner)})`)); }
  if (waiting.length) { L_.push('', `Waiting for both approvals (${waiting.length}):`); waiting.forEach(p => L_.push(`• ${name(p)}, ${money(p.amount, true)}`)); }
  if (sr) L_.push('', `Fair shares this month: ${S().p1} ${money(sr.fair1)}, ${S().p2} ${money(sr.fair2)}. Paid: ${S().p1} ${money(sr.paid1)}, ${S().p2} ${money(sr.paid2)}.`);
  L_.push(`Settle up to date: ${settleText(settleNow())}.`, `Debt today: ${money(totals().debt)}.`);
  const od = state.actions.filter(a => actionFlag(a) === 'Overdue');
  if (od.length) { L_.push('', `Overdue actions (${od.length}):`); od.forEach(a => L_.push(`• ${a.title}`)); }
  if (appLink()) L_.push('', `Open Household Hub: ${appLink()}`);
  L_.push('', 'Household Hub');
  return { to: [S().emails.p1, S().emails.p2].filter(Boolean), cc: [], subject: `${monthName(m, true)} payment confirmation: ${money(paid)} of ${money(sched)} paid`, body: L_.join('\n') };
}
function schedule(daysAhead = 62) {
  const t = todayISO(), lead = num(S().leadDays) || 4, from = addDays(t, -10), out = [];
  for (const k of ['p1', 'p2']) for (const pd of paydays(k, addDays(from, lead), addDays(t, daysAhead + lead))) {
    out.push({ key: `pay:${k}:${pd}`, type: 'pay', k, payday: pd, send: addDays(pd, -lead) });
  }
  for (let i = -1; i < 3; i++) { const m = addMonths(thisMonth(), i), send = dayOf(m, 31); if (send >= from && send <= addDays(t, daysAhead)) out.push({ key: `month:${m}`, type: 'month', m, send }); }
  return out.sort((a, b) => a.send.localeCompare(b.send) || a.key.localeCompare(b.key));
}
function compose(s) { return s.type === 'pay' ? paycheckEmail(s.k, s.payday) : monthEndEmail(s.m); }
function sendState(s) {
  const t = todayISO();
  if (state.sent[s.key]) return 'Sent';
  if (s.send > t) return 'Scheduled';
  const lastDay = s.type === 'pay' ? s.payday : addDays(s.send, 5);
  return t > lastDay ? 'Missed' : 'Ready to send';
}
function schedTitle(s) { return s.type === 'pay' ? `${S()[s.k]}'s bills for the ${dateShort(s.payday)} paycheck` : `${monthName(s.m, true)} payment confirmation to both`; }
function mailto(e) {
  const q = [`subject=${encodeURIComponent(e.subject)}`, `body=${encodeURIComponent(e.body.replace(/\n/g, '\r\n'))}`];
  if (e.cc.length) q.unshift(`cc=${e.cc.join(',')}`);
  return `mailto:${e.to.join(',')}?${q.join('&')}`;
}
function openEmail(key) {
  const s = schedule(400).find(x => x.key === key) || parseKey(key); const e = compose(s), st = sendState(s);
  $sheet.innerHTML = `<div><div class="sheet-head"><h2>${esc(schedTitle(s))}</h2><p class="small muted" style="margin:4px 0 0">Send on ${dateLong(s.send)} · ${st}</p></div>
    <div class="sheet-body"><div class="small"><b>To:</b> ${esc(e.to.join(', ') || 'add email addresses in Settings')}${e.cc.length ? `<br><b>Cc:</b> ${esc(e.cc.join(', '))}` : ''}<br><b>Subject:</b> ${esc(e.subject)}</div>
    <div class="mail" style="margin-top:10px">${esc(e.body)}</div>
    <p class="small muted">Sending opens your own email app with this message ready. Automatic sending is switched on when the app is hosted with an email connector.</p></div>
    <div class="sheet-foot"><button class="btn grow" data-action="toggle-sent" data-key="${esc(s.key)}">${st === 'Sent' ? 'Mark not sent' : 'Mark as sent'}</button>
    <button class="btn" data-action="copy-email" data-key="${esc(s.key)}">Copy</button>${navigator.share ? `<button class="btn" data-action="share-email" data-key="${esc(s.key)}">Share</button>` : ''}
    <a class="btn primary" href="${esc(mailto(e))}" data-mail="${esc(s.key)}">Send by email</a></div></div>`;
  if (!$sheet.open) $sheet.showModal();
}
function parseKey(key) { const [type, a, b] = key.split(':'); return type === 'pay' ? { key, type, k: a, payday: b, send: addDays(b, -(num(S().leadDays) || 4)) } : { key, type, m: a, send: dayOf(a, 31) }; }

/* ---------- calendar (.ics) ---------- */
function icsEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function fold(l) { const out = []; while (l.length > 73) { out.push(l.slice(0, 73)); l = ' ' + l.slice(73); } out.push(l); return out.join('\r\n'); }
function icsFor(k) {
  const t = todayISO(), lead = num(S().leadDays) || 4, ev = [], stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const add = (date, summary, desc, uidKey, alarm) => {
    ev.push(['BEGIN:VEVENT', `UID:${uidKey}@household-hub`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(date, 1).replace(/-/g, '')}`,
      `SUMMARY:${icsEsc(summary)}`, `DESCRIPTION:${icsEsc(desc)}`].concat(alarm ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(summary)}`, 'TRIGGER:PT9H', 'END:VALARM'] : []).concat(['END:VEVENT']).map(fold).join('\r\n'));
  };
  for (const pd of paydays(k, t, addDays(t, 366))) {
    const send = addDays(pd, -lead), e = paycheckEmail(k, pd);
    add(send, `Household Hub: bills for the ${dateShort(pd)} paycheck`, `${e.body}\n\nAmounts as of ${dateLong(t)}. Open the app for the latest list.`, `pay-${k}-${pd}`, true);
  }
  for (let i = 0; i < 12; i++) { const m = addMonths(thisMonth(), i); add(dayOf(m, 31), `Household Hub: ${monthName(m, true)} payment confirmation`, 'Review the month in Household Hub and send the confirmation to both of you.', `month-${m}`, true); }
  for (const it of items()) {
    if (myShare(it, k) <= 0 || !it.name) continue;
    for (let i = 0; i < 3; i++) { const m = addMonths(thisMonth(), i), due = it.due(m); if (!due) continue; const d = dayOf(m, it.day || 1); if (d < t) continue;
      add(d, `Due: ${it.name} ${money(due * myShare(it, k), true)}`, `${it.name} is due. Your part: ${money(due * myShare(it, k), true)}.${it.ref.portal ? ' Pay: ' + it.ref.portal : ''}`, `due-${it.id}-${m}`, false); }
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Household Hub//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:Household Hub (${S()[k]})`].concat(ev).concat(['END:VCALENDAR']).join('\r\n');
}

/* ---------- views ---------- */
function payButtons(it, m) {
  const r = it.ref || {};
  return `<div class="row" style="flex:none;gap:6px;flex-wrap:nowrap">${r.portal ? `<a class="btn sm primary" href="${esc(r.portal)}" target="_blank" rel="noopener" data-action="portal" data-id="${it.id}" data-month="${m}">Pay</a>` : ''}<button class="btn sm" data-action="mark-paid" data-id="${it.id}" data-month="${m}">${r.portal ? 'Log' : 'Paid'}</button></div>`;
}
function personChips(active) {
  return `<div class="chips" style="margin-bottom:12px"><a class="chip ${active === 'home' ? 'on' : ''}" href="#/home">Household</a>${['p1', 'p2'].map(k => `<button class="chip ${active === k ? 'on' : ''}" data-action="me" data-v="${k}">${esc(S()[k])}</button>`).join('')}</div>`;
}
function readyNotice() {
  const ready = schedule().filter(s => sendState(s) === 'Ready to send');
  if (!ready.length) return '';
  return `<div class="notice" style="margin-bottom:12px"><div style="flex:1">${ready.length === 1 ? esc(schedTitle(ready[0])) + ' is ready to send.' : ready.length + ' reminders are ready to send.'}</div><button class="btn sm" data-action="open-email" data-key="${esc(ready[0].key)}">Preview</button></div>`;
}
const baseHome = VIEWS.home;
VIEWS.home = () => {
  const html = baseHome(); const i = html.indexOf('</div></div>') + 12;
  return state.bills.length || state.debts.length ? html.slice(0, i) + personChips('home') + readyNotice() + html.slice(i) : html;
};

VIEWS.me = () => {
  const k = ui.meK || S().me || 'p1', name = S()[k], p = S().pay[k], t = todayISO();
  if (!state.bills.length && !state.debts.length) return header('My view', '') + emptyStart();
  const carry = carryOf(k), cpm = CHECKS_PER_MONTH[p.freq] || 2;
  const pds = paydays(k, addDays(t, -31), addDays(t, 75));
  const cur = pds.filter(d => d <= t).pop(), fut = pds.filter(d => d > t);
  const periods = [cur, fut[0]].filter(Boolean);
  const cm = thisMonth();
  let mineDue = 0, minePaid = 0;
  for (const it of items()) { const sh = myShare(it, k); if (sh <= 0) continue; const due = it.due(cm); mineDue += due * sh; minePaid += Math.min(paidFor(it.id, cm), due || Infinity) * sh; }
  const take = num(p.amount);
  const nextSend = schedule().find(s => s.type === 'pay' && s.k === k && ['Scheduled', 'Ready to send'].includes(sendState(s)));
  const carryList = items().filter(it => it.name && myShare(it, k) > 0).map(it => ({ it, mo: (it.kind === 'bill' ? billMonthly(it.ref) : (debtActive(it.ref) ? num(it.ref.payment) : 0)) * myShare(it, k) })).filter(x => x.mo > 0).sort((a, b) => b.mo - a.mo);
  const myDebts = state.debts.filter(d => d.name && !d.pending && myShare(itemById(d.id), k) > 0 && d.include !== 'No');
  const periodCard = (start, idx) => {
    const end = periodEnd(k, start), list = periodItems(k, start, end), left = list.reduce((s, r) => s + r.left, 0);
    return `<div class="card"><div class="spread"><h2>${idx === 0 && start <= t ? 'This paycheck' : 'Next paycheck'} · ${dateShort(start)}</h2><span class="muted small">to ${dateShort(end)}</span></div>
      <p class="small muted" style="margin:-4px 0 6px">${money(left, true)} still to pay${take ? ` of ${money(take)} take-home, leaving ${money(take - left)}` : ''}</p>
      <ul class="list">${list.map(r => `<li><span class="dot ${DOT_CLS[r.status] || ''}"></span><div class="main"><div class="title">${esc(r.it.name)}</div>
        <div class="sub">${dateShort(r.date)}${r.share < 1 ? ` · your ${pct(r.share)} of ${money(r.full, true)}` : ''}</div></div>
        <div class="end"><div class="amt">${money(r.left || r.mine, true)}</div><span class="pill ${STATUS_CLS[r.status]}">${STATUS_TEXT[r.status]}</span></div>
        ${['paid', 'extra'].includes(r.status) ? '' : payButtons(r.it, r.m)}</li>`).join('') || '<li class="muted">Nothing falls in this window.</li>'}</ul></div>`;
  };
  return header(`${name}'s view`, `What ${esc(name)} carries, paycheck by paycheck.`, `<button class="btn" data-action="ics" data-v="${k}">Add to calendar</button>`) + personChips(k) +
    `<div class="grid g4">${kpi('Carries per month', money(carry), 'Includes part of Shared items', k === 'p1' ? 't-p1' : 't-p2')}
      ${kpi('Per paycheck', money(carry / cpm), `${PAY_FREQ[p.freq] || ''}`, '')}
      ${kpi(`${monthName(cm, true)} paid`, mineDue ? pct(minePaid / mineDue) : '–', `${money(minePaid)} of ${money(mineDue)}`, 't-good', mineDue ? minePaid / mineDue : 0)}
      ${kpi('Settle up', settleFor(k), SPLITS[S().split] + ' split', 't-acc', null, true)}</div>
    <div class="cols" style="margin-top:16px"><div>${periods.map(periodCard).join('') || `<div class="card"><p class="muted">Set ${esc(name)}'s pay schedule in Settings to see per-paycheck lists.</p></div>`}</div>
    <div><div class="card"><h2>Reminders</h2><p class="small muted" style="margin-top:0">${S().emails[k] ? `Bill list goes to <b>${esc(S().emails[k])}</b> ${num(S().leadDays) || 4} days before each payday, plus a month-end confirmation to both of you.` : `Add ${esc(name)}'s email in Settings to send paycheck lists.`}</p>
      ${nextSend ? `<div class="spread"><span class="small">Next: <b>${dateLong(nextSend.send)}</b> (${sendState(nextSend)})</span><button class="btn sm" data-action="open-email" data-key="${esc(nextSend.key)}">Preview</button></div>` : ''}</div>
      <div class="card"><h2>Everything ${esc(name)} carries</h2><ul class="list">${carryList.map(x => `<li class="tap" data-action="edit-${x.it.kind}" data-id="${x.it.id}"><div class="main"><div class="title">${esc(x.it.name)}</div><div class="sub">${x.it.kind === 'bill' ? esc(x.it.ref.category || '') : 'Debt payment'}${myShare(x.it, k) < 1 ? ` · ${pct(myShare(x.it, k))} share` : ''}${x.it.ref.source ? ' · ' + esc(srcLabel(state.sources.find(s => s.id === x.it.ref.source))) : ''}</div></div><div class="end amt">${money(x.mo)}/mo</div></li>`).join('')}
        <li><div class="main title">Total</div><div class="amt">${money(carry)}/mo</div></li></ul></div>
      <div class="card"><h2>${esc(name)}'s debts</h2><ul class="list">${myDebts.sort((a, b) => debtBalance(b) - debtBalance(a)).slice(0, 12).map(d => `<li class="tap" data-action="edit-debt" data-id="${d.id}"><div class="main"><div class="title">${esc(d.name)}</div><div class="sub">${num(d.payment) ? money(d.payment) + '/mo' : 'No payment set'}${d.include === 'Check' ? ' · to confirm' : ''}</div></div><div class="end amt">${money(debtBalance(d))}</div></li>`).join('') || '<li class="muted">None</li>'}</ul>
        ${myDebts.length > 12 ? `<a class="small" href="#/debts">All ${myDebts.length} debts</a>` : ''}</div></div></div>`;
};

VIEWS.notify = () => {
  const list = schedule(62), ok = S().emails.p1 || S().emails.p2;
  return header('Reminders', `Each person's bill list ${num(S().leadDays) || 4} days before every payday, and a month-end payment confirmation to both.`) +
    (ok ? '' : `<div class="notice warn" style="margin-bottom:12px"><div>Add both email addresses and pay schedules in Settings first.</div><a class="btn sm" href="#/settings">Settings</a></div>`) +
    `<div class="cols"><div class="card"><h2>Next 60 days</h2><ul class="list">${list.map(s => { const st = sendState(s);
      return `<li class="tap" data-action="open-email" data-key="${esc(s.key)}"><span class="dot ${st === 'Sent' ? 'good' : st === 'Ready to send' ? 'due' : ''}"></span><div class="main"><div class="title">${esc(schedTitle(s))}</div>
        <div class="sub">Send ${dateLong(s.send)} · to ${esc(s.type === 'pay' ? (S().emails[s.k] || S()[s.k]) : 'both')}</div></div>
        <div class="end">${s.type === 'pay' ? `<div class="amt">${money(paycheckEmail(s.k, s.payday).total)}</div>` : ''}<span class="pill ${st === 'Sent' ? 's-good' : st === 'Ready to send' ? 's-due' : st === 'Missed' ? 's-warn' : ''}">${st}${st === 'Sent' ? ' ' + dateShort(state.sent[s.key].slice(0, 10)) : ''}</span></div></li>`; }).join('') || '<li class="muted">Nothing scheduled. Set pay schedules in Settings.</li>'}</ul></div>
    <div><div class="card"><h2>Calendar reminders</h2><p class="small muted" style="margin-top:0">Download a calendar file for each person. It adds a 9am reminder on every send day, the month-end review, and that person's due dates for the next 3 months. Works with iPhone, Google and Outlook calendars.</p>
      <div class="row">${['p1', 'p2'].map(k => `<button class="btn" data-action="ics" data-v="${k}">${esc(S()[k])}'s calendar</button>`).join('')}</div></div>
    <div class="card"><h2>Automatic sending</h2><p class="small muted" style="margin:0">Today each email opens in your email app ready to send, so nothing goes out without you. When the app is hosted, an email connector can send these same messages on schedule.</p></div></div></div>`;
};

VIEWS.statements = () => {
  const debts = state.debts.filter(d => d.name && d.include !== 'No' && debtBalance(d) > 0);
  const last = id => state.statements.filter(s => s.itemId === id).sort((a, b) => b.date.localeCompare(a.date))[0];
  const rows = debts.map(d => ({ d, s: last(d.id) })).sort((a, b) => (a.s ? a.s.date : '0').localeCompare(b.s ? b.s.date : '0'));
  const recent = state.statements.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  return header('Statements', 'Log each statement. The newest one updates the debt balance, so the payoff numbers stay true.', `<button class="btn primary" data-action="new-statement">Add a statement</button>`) +
    `<div class="cols"><div class="card"><h2>By account</h2><ul class="list">${rows.map(({ d, s }) => { const age = s ? daysBetween(s.date, todayISO()) : null;
      return `<li class="tap" data-action="new-statement" data-id="${d.id}"><span class="dot ${!s || age > 35 ? 'warn' : 'good'}"></span><div class="main"><div class="title">${esc(d.name)}</div><div class="sub">${s ? `Last statement ${dateShort(s.date)}${s.minDue ? ' · minimum ' + money(s.minDue, true) : ''}${s.dueDate ? ' · due ' + dateShort(s.dueDate) : ''}` : 'No statement logged yet'}</div></div>
        <div class="end"><div class="amt">${money(debtBalance(d))}</div>${!s || age > 35 ? '<span class="pill s-warn">Update</span>' : ''}</div></li>`; }).join('')}</ul></div>
    <div class="card"><h2>Recent statements</h2><ul class="list">${recent.map(s => `<li class="tap" data-action="edit-statement" data-sid="${s.id}"><div class="main"><div class="title">${esc((itemById(s.itemId) || {}).name || 'Account')}</div><div class="sub">${dateShort(s.date)}${s.link ? ' · has link' : ''}${s.notes ? ' · ' + esc(s.notes) : ''}</div></div><div class="end amt">${money(s.balance, true)}</div>${s.link ? `<a class="btn sm" href="${esc(s.link)}" target="_blank" rel="noopener">Open</a>` : ''}</li>`).join('') || '<li class="muted">None yet.</li>'}</ul></div></div>`;
};

VIEWS.activity = () => header('Activity', 'Every change, approval and import on this device, newest first.') +
  `<div class="card"><ul class="list">${state.activity.slice(0, 200).map(a => `<li><div class="main"><div class="title">${esc(a.what)}</div><div class="sub">${esc(a.detail)}</div></div><div class="end small muted">${new Date(a.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${a.who ? '<br>' + esc(who(a.who)) : ''}</div></li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul></div>`;

VIEWS.more = () => header('More', '') + `<div class="more-grid">
  <a href="#/me">My view<span>Per-paycheck lists</span></a><a href="#/pay">Payments<span>Log, approve, review</span></a>
  <a href="#/misc">Misc costs<span>One-off and manual entries</span></a><a href="#/agree">Agreement<span>${state.changes.filter(c => c.status === 'Pending').length || 'No'} change${state.changes.filter(c => c.status === 'Pending').length === 1 ? '' : 's'} to sign</span></a>
  <a href="#/settle">Settle up<span>${esc(settleText(settleNow()))}</span></a><a href="#/notify">Reminders<span>Emails and calendar</span></a>
  <a href="#/debts">Debts<span>${money(totals().debt)}</span></a><a href="#/statements">Statements<span>Keep balances true</span></a>
  <a href="#/bills">Bills<span>${state.bills.length} bills</span></a><a href="#/actions">Actions<span>${totals().openActions} open</span></a>
  <a href="#/decisions">Decisions<span>Agreements and approvals</span></a><a href="#/cash">Cash flow<span>Money in and out</span></a>
  <a href="#/activity">Activity<span>Who changed what</span></a><a href="#/settings">Settings &amp; data<span>Names, pay, export</span></a></div>`;

const baseSettings = VIEWS.settings;
VIEWS.settings = () => {
  const s = S();
  const payCard = k => `<div class="fields" style="margin-bottom:14px"><div class="field full"><label>${esc(s[k])}</label></div>
    <div class="field"><label>Email</label><input type="email" autocomplete="off" data-email="${k}" value="${esc(s.emails[k])}" placeholder="name@example.com"></div>
    <div class="field"><label>Paid</label><select data-pay="${k}.freq">${Object.entries(PAY_FREQ).map(([v, l]) => `<option value="${v}" ${s.pay[k].freq === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>A recent or next payday</label><input type="date" data-pay="${k}.next" value="${esc(s.pay[k].next || '')}"><span class="hint">Needed for weekly, every 2 weeks and monthly</span></div>
    <div class="field"><label>Take-home per paycheck</label><input type="number" step="any" inputmode="decimal" data-pay="${k}.amount" value="${esc(s.pay[k].amount ?? '')}"></div></div>`;
  return baseSettings() + `<div class="cols" style="margin-top:16px"><div class="card"><h2>Paychecks and email</h2>${payCard('p1')}${payCard('p2')}
      <div class="fields"><div class="field"><label>Send lists this many days before payday</label><input type="number" min="0" max="14" data-setting2="leadDays" value="${esc(s.leadDays)}"></div>
      <div class="field"><label>Copy the partner on paycheck lists</label><select data-setting2="ccPartner"><option value="">No</option><option value="1" ${s.ccPartner ? 'selected' : ''}>Yes</option></select></div>
      <div class="field full"><label>App link used in emails</label><input type="url" data-setting2="appUrl" value="${esc(s.appUrl)}" placeholder="Filled in once the app is hosted"></div></div></div>
    <div class="card"><div class="spread"><h2>Payment methods</h2><button class="btn sm" data-action="new-source">Add</button></div>
      <p class="small muted" style="margin-top:0">Name each card or account you pay from, with the last 4 digits only. Full card numbers, account numbers and bank codes stay with your bank.</p>
      <ul class="list">${state.sources.map(x => `<li class="tap" data-action="edit-source" data-sid="${x.id}"><div class="main"><div class="title">${esc(srcLabel(x))}</div><div class="sub">${esc(x.type || '')}${x.bank ? ' · ' + esc(x.bank) : ''}</div></div>${ownerPill(x.owner)}</li>`).join('') || '<li class="muted">None yet.</li>'}</ul>
      <p class="small muted">Bank connections that read statements and balances automatically (for example through Plaid) are set up as a connector when the app is hosted.</p></div></div>`;
};

/* ---------- export / import extras ---------- */
function exportExtra(add, D, $) {
  add('Pay & Email', ['Person', 'Email', 'Paid', 'Recent or next payday', 'Take-home per paycheck', 'Carries per month'],
    ['p1', 'p2'].map(k => [S()[k], S().emails[k], S().pay[k].freq, D(S().pay[k].next), $(S().pay[k].amount), $(carryOf(k))]).concat([['Lead days', S().leadDays], ['Copy partner', S().ccPartner ? 'Yes' : 'No'], ['App link', S().appUrl]]), [14, 30, 14, 16, 16, 16]);
  add('Payment Methods', ['Name', 'Type', 'Last 4', 'Bank', 'Belongs to'], state.sources.map(x => [x.name, x.type, x.last4, x.bank, who(x.owner)]), [24, 12, 8, 20, 12]);
  add('Statements', ['Account', 'Statement date', 'Balance', 'Minimum due', 'Due by', 'Updated balance', 'Link', 'Notes'],
    state.statements.map(x => [(itemById(x.itemId) || {}).name || '', D(x.date), $(x.balance), $(x.minDue), D(x.dueDate), x.update || 'Yes', x.link, x.notes]), [30, 12, 12, 12, 12, 10, 30, 30]);
  add('Reminders', ['Send on', 'Reminder', 'To', 'Status'], schedule(62).map(s => [D(s.send), schedTitle(s), s.type === 'pay' ? S().emails[s.k] : [S().emails.p1, S().emails.p2].filter(Boolean).join(', '), sendState(s)]), [12, 44, 36, 14]);
  add('Activity', ['When', 'Who', 'What', 'Detail'], state.activity.map(a => [a.at.replace('T', ' ').slice(0, 16), who(a.who), a.what, a.detail]), [18, 10, 30, 40]);
  const b = state.bills.concat(state.debts);
  add('Misc Costs', ['Date', 'Cost', 'Category', 'Carried by', 'Partner 1 share', 'Amount', 'Status', 'Paid by', 'Paid from', `${S().p1} approval`, `${S().p2} approval`, 'Counts', 'Notes'],
    state.misc.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(x => { const ap = v => v === true ? 'Yes' : v === false ? 'No' : '';
      return [D(x.date), x.desc, x.category, who(x.owner), x.share == null ? null : { t: 'n', v: num(x.share), z: '0%' }, $(x.amount), x.status, x.status === 'Paid' ? who(x.paidBy) : '', x.method, ap((x.approvals || {}).p1), ap((x.approvals || {}).p2), miscStatus(x), x.notes]; }),
    [12, 30, 16, 10, 9, 12, 9, 10, 12, 10, 10, 16, 36]);
  add('Agreement', ['Proposed', 'Change', 'Detail', 'Status', `${S().p1} signed`, `${S().p2} signed`, 'Took effect'],
    state.changes.slice().reverse().map(c => [c.at.replace('T', ' ').slice(0, 16), changeTitle(c), changeLines(c).map(l => `${l.label}: ${l.from} to ${l.to}`).join('; '), c.status,
      c.sig.p1 && c.sig.p1.at ? `${c.sig.p1.name} ${c.sig.p1.at.replace('T', ' ').slice(0, 16)}` : c.sig.p1 && c.sig.p1.declined ? 'Declined' : '',
      c.sig.p2 && c.sig.p2.at ? `${c.sig.p2.name} ${c.sig.p2.at.replace('T', ' ').slice(0, 16)}` : c.sig.p2 && c.sig.p2.declined ? 'Declined' : '', c.closedAt ? c.closedAt.replace('T', ' ').slice(0, 16) : '']),
    [17, 40, 60, 11, 26, 26, 17]);
  add('Portals', ['Item', 'Payment portal', 'Usually paid with', 'Account reference'], b.filter(x => x.portal || x.source || x.accountRef).map(x => [x.name, x.portal, srcLabel(state.sources.find(s => s.id === x.source)), x.accountRef]), [30, 40, 24, 16]);
}
function importExtra(J, g, out, h) {
  const pe = J('Pay & Email');
  for (const k of ['p1', 'p2']) { const r = pe.find(x => x.Person === out.settings[k]); if (r) { out.settings.emails[k] = h.str(r.Email) || ''; out.settings.pay[k] = { freq: h.str(r.Paid) || 'semimonthly', next: h.dateV(r['Recent or next payday']), amount: h.numV(r['Take-home per paycheck']) }; } }
  const opt = n => (pe.find(x => x.Person === n) || {}).Email;
  if (opt('Lead days') != null) out.settings.leadDays = h.numV(opt('Lead days')); out.settings.ccPartner = opt('Copy partner') === 'Yes'; out.settings.appUrl = h.str(opt('App link')) || '';
  out.sources = J('Payment Methods').filter(r => r.Name).map(r => ({ id: uid(), name: h.str(r.Name), type: h.str(r.Type), last4: r['Last 4'] == null ? null : String(r['Last 4']).padStart(4, '0'), bank: h.str(r.Bank), owner: h.ownerKey(r['Belongs to']) || 'joint' }));
  for (const r of J('Portals')) { const it = h.byName(r.Item); if (!it) continue; it.portal = h.str(r['Payment portal']); it.accountRef = h.str(r['Account reference']); const src = out.sources.find(s => srcLabel(s) === r['Usually paid with']); it.source = src ? src.id : null; }
  out.statements = J('Statements').filter(r => r.Account).map(r => { const it = h.byName(r.Account); return { id: uid(), itemId: it ? it.id : null, date: h.dateV(r['Statement date']), balance: h.numV(r.Balance), minDue: h.numV(r['Minimum due']), dueDate: h.dateV(r['Due by']), update: h.str(r['Updated balance']) || 'Yes', link: h.str(r.Link), notes: h.str(r.Notes) }; });
  out.misc = J('Misc Costs').filter(r => r.Cost).map(r => { const yn = v => v === 'Yes' ? true : v === 'No' ? false : null, a1 = yn(r[`${out.settings.p1} approval`]), a2 = yn(r[`${out.settings.p2} approval`]);
    return { id: uid(), date: h.dateV(r.Date), desc: h.str(r.Cost), category: h.str(r.Category) || 'Other', owner: h.ownerKey(r['Carried by']) || 'shared', share: h.numV(r['Partner 1 share']), amount: h.numV(r.Amount), status: h.str(r.Status) || 'Paid', paidBy: h.ownerKey(r['Paid by']) || 'joint', method: h.str(r['Paid from']), notes: h.str(r.Notes), approvals: Object.assign({}, a1 != null && { p1: a1 }, a2 != null && { p2: a2 }) }; });
  out.activity = J('Activity').filter(r => r.What).map(r => ({ at: new Date(String(r.When).replace(' ', 'T')).toISOString(), who: h.ownerKey(r.Who) || '', what: h.str(r.What), detail: h.str(r.Detail) || '' }));
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const mail = e.target.closest('[data-mail]');
  if (mail) { state.sent[mail.dataset.mail] = new Date().toISOString(); logAct('Opened reminder email', schedTitle(parseKey(mail.dataset.mail))); save(); setTimeout(() => { $sheet.close(); render(); }, 300); return; }
  const a = e.target.closest('[data-action]'); if (!a) return;
  const act = a.dataset.action;
  switch (act) {
    case 'me': ui.meK = a.dataset.v; if (route !== 'me') location.hash = '#/me'; else render(); return;
    case 'open-email': return openEmail(a.dataset.key);
    case 'toggle-sent': { const k = a.dataset.key; if (state.sent[k]) delete state.sent[k]; else state.sent[k] = new Date().toISOString(); logAct(state.sent[k] ? 'Marked reminder sent' : 'Marked reminder not sent', schedTitle(parseKey(k))); save(); render(); return openEmail(k); }
    case 'copy-email': { const m = compose(parseKey(a.dataset.key)); navigator.clipboard.writeText(`To: ${m.to.join(', ')}\nSubject: ${m.subject}\n\n${m.body}`).then(() => toast('Copied'), () => toast('Copy is blocked here')); return; }
    case 'share-email': { const m = compose(parseKey(a.dataset.key)); navigator.share({ title: m.subject, text: m.body }).then(() => { state.sent[a.dataset.key] = new Date().toISOString(); save(); render(); }).catch(() => {}); return; }
    case 'ics': { const k = a.dataset.v; download(new Blob([icsFor(k)], { type: 'text/calendar' }), `household-hub-${S()[k].toLowerCase().replace(/\W+/g, '-')}.ics`); logAct('Downloaded calendar', S()[k]); save(); return toast('Calendar file downloaded. Open it to add the reminders.'); }
    case 'portal': {
      const it = itemById(a.dataset.id), m = a.dataset.month || thisMonth(), src = state.sources.find(s => s.id === it.ref.source);
      const left = Math.max(0, it.due(m) - paidFor(it.id, m));
      const method = src ? ({ 'Debit card': 'Checking', Checking: 'Checking', Savings: 'Savings', 'Credit card': 'Credit card' })[src.type] || 'Other' : null;
      return openForm('payment', null, { itemId: it.id, amount: left || it.amount, date: m === thisMonth() ? todayISO() : dayOf(m, it.day || 1), paidBy: it.owner === 'shared' ? (S().me || 'joint') : it.owner, kind: 'Scheduled', method, notes: src ? `Paid online with ${srcLabel(src)}` : 'Paid online' });
    }
    case 'new-source': return openForm('source', null);
    case 'edit-source': return openForm('source', a.dataset.sid);
    case 'new-statement': { const d = a.dataset.id ? state.debts.find(x => x.id === a.dataset.id) : null; return openForm('statement', null, d ? { itemId: d.id, balance: debtBalance(d) } : {}); }
    case 'edit-statement': return openForm('statement', a.dataset.sid);
  }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.email) { const v = el.value.trim(); if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return toast('That email does not look right'); S().emails[el.dataset.email] = v; logAct('Changed email', `${S()[el.dataset.email]}: ${v}`); save(); return toast('Saved'); }
  if (el.dataset.pay) { const [k, f] = el.dataset.pay.split('.'); S().pay[k][f] = f === 'amount' ? (el.value === '' ? null : num(el.value)) : (el.value || null); logAct('Changed pay schedule', S()[k]); save(); return toast('Saved'); }
  if (el.dataset.setting2) { const f = el.dataset.setting2; S()[f] = f === 'leadDays' ? Math.max(0, Math.round(num(el.value))) : f === 'ccPartner' ? !!el.value : el.value.trim(); save(); return toast('Saved'); }
});

/* ---------- boot ---------- */
Object.assign(window.hub, { paydays, paycheckEmail, monthEndEmail, schedule, icsFor });
// boot happens at the end of agree.js
