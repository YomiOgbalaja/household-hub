/* Household Hub, part 3: miscellaneous costs (manual entries) and the binding responsibility agreement.
   Who carries what is binding. Adding or removing a bill or debt, changing its owner, share, amount, frequency
   or due day, changing the split, the approval amount or the written agreements: each becomes a proposal that
   only takes effect once both partners sign it. Until then the current terms stay in force. Shares the global
   scope of app.js and more.js. */
'use strict';

const MISC_CATS = ['Groceries', 'Household supplies', 'Repairs & maintenance', 'Medical', 'Kids & school extras', 'Gifts & celebrations', 'Travel', 'Car costs', 'Eating out', 'Fees & fines', 'Other'];
const RESP = { bill: ['amount', 'freq', 'owner', 'share', 'dueDay', 'firstDue', 'status'], debt: ['payment', 'owner', 'share', 'dueDay', 'status'] };
const END_WORD = { bill: 'Ended', debt: 'Paid off' };
const GOVERNED = ['split', 'defShare', 'threshold'];

/* ---------- misc form ---------- */
FORMS.misc = { coll: 'misc', title: 'Miscellaneous cost', fields: () => [
  ['desc', 'What was it', 'text', { req: 1, full: 1, hint: 'For example plumber call-out, school trip, pharmacy' }], ['amount', 'Amount', 'money', { req: 1 }],
  ['date', 'Date', 'date', { req: 1, def: todayISO() }], ['category', 'Category', 'select', { opts: L(MISC_CATS), def: 'Other' }],
  ['owner', 'Who carries it', 'select', { opts: owners(), def: 'shared' }], ['share', `${S().p1} part if Shared (%)`, 'percent', { hint: 'Blank uses the Settings default' }],
  ['status', 'Status', 'select', { opts: [['Paid', 'Paid'], ['To pay', 'To pay (planned)']], def: 'Paid' }],
  ['paidBy', 'Paid by', 'select', { opts: payers(), def: S().me || 'joint' }],
  ['method', 'Paid from', 'select', { opts: [['', '—']].concat(L(METHODS)) }], ['notes', 'Notes', 'textarea', { full: 1 }]] };

function miscRule(f) {
  const el = document.getElementById('pay-rule'); if (!el) return;
  const x = { amount: f.amount.value, owner: f.owner.value, status: f.status.value, paidBy: f.paidBy.value };
  const carry = x.owner === 'shared' ? 'split between you' : `carried by ${who(x.owner)}`;
  el.textContent = miscNeedsBoth(x) ? `Needs both of you to approve before it counts (${carry}, ${money(S().threshold)} or more).` : `Counts straight away, ${carry}.`;
}

/* ---------- small helpers ---------- */
const nowISO = () => new Date().toISOString();
const localDay = iso => isoOf(new Date(iso));
function same(a, b) {
  const blank = v => v == null || v === '';
  if (blank(a) && blank(b)) return true;
  if (typeof a === 'number' || typeof b === 'number') return Math.abs(num(a) - num(b)) < 1e-9 && !blank(a) && !blank(b);
  return String(a ?? '') === String(b ?? '');
}
function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k] ?? null; return r; }
function findRec(c) { return c.target === 'bill' ? state.bills.find(x => x.id === c.targetId) : c.target === 'debt' ? state.debts.find(x => x.id === c.targetId) : null; }
function openChange(id, action) { return state.changes.find(c => c.status === 'Pending' && c.targetId === id && (!action || c.action === action)); }
function pendingChanges() { return state.changes.filter(c => c.status === 'Pending'); }
function proposedFor(id) { const c = openChange(id, 'edit'); return c ? c.after : {}; }
function isGoverned(k) { return GOVERNED.includes(k) || (S().split === 'income' && (k === 'incomeP1' || k === 'incomeP2')); }

function addChange(c) {
  Object.assign(c, { id: uid(), at: nowISO(), by: S().me || '', sig: { p1: null, p2: null }, status: 'Pending' });
  state.changes.push(c); logAct('Proposed a change', changeTitle(c));
  return c;
}
function closeChange(c, status) {
  c.status = status; c.closedAt = nowISO();
  if (c.action === 'add' && status !== 'Signed') { const coll = c.target === 'bill' ? 'bills' : 'debts'; state[coll] = state[coll].filter(x => x.id !== c.targetId); }
  logAct(status === 'Withdrawn' ? 'Withdrew a proposal' : status === 'Declined' ? 'Declined a change' : 'Change took effect', changeTitle(c));
}
function dropChangesFor(id) { for (const c of state.changes) if (c.status === 'Pending' && c.targetId === id) { c.status = 'Withdrawn'; c.closedAt = nowISO(); } }

/* ---------- describing a change ---------- */
const FIELD = {
  amount: ['Amount', v => money(v, true)], payment: ['Monthly payment', v => money(v, true)], freq: ['How often', v => v || 'Monthly'],
  owner: ['Carried by', v => who(v) || '—'], share: ['Split of a Shared item', v => v == null || v === '' ? `Default (${S().p1} ${pct(S().defShare)})` : `${S().p1} ${pct(v)} · ${S().p2} ${pct(1 - num(v))}`],
  dueDay: ['Due day', v => v ? `Day ${v}` : '—'], firstDue: ['First due', v => v ? dateShort(v) : '—'], status: ['Status', v => v || 'Current'],
  split: ['How shared costs split', v => SPLITS[v] || v], defShare: ['Default part of a Shared item', v => `${S().p1} ${pct(v)} · ${S().p2} ${pct(1 - num(v))}`],
  threshold: ['Both approve at or above', v => money(v)], incomeP1: [`${'Partner 1'} take-home`, v => money(v)], incomeP2: [`${'Partner 2'} take-home`, v => money(v)],
};
function fieldLabel(k) { if (k === 'incomeP1') return `${S().p1} take-home`; if (k === 'incomeP2') return `${S().p2} take-home`; return (FIELD[k] || [k])[0]; }
function fieldVal(k, v) { return (FIELD[k] || [k, x => x == null ? '—' : String(x)])[1](v); }
function changeTitle(c) {
  const kind = c.target === 'bill' ? 'bill' : 'debt';
  if (c.target === 'settings') return 'Change how costs are shared';
  if (c.target === 'agreements') return 'Update our written agreements';
  if (c.action === 'add') return `Add the ${kind} ${c.label}`;
  if (c.action === 'delete') return `Remove the ${kind} ${c.label}`;
  return `Change ${c.label}`;
}
function changeLines(c) {
  if (c.target === 'agreements') {
    const a = c.before.list || [], b = c.after.list || [];
    return a.filter(x => !b.includes(x)).map(x => ({ label: 'Remove', from: x, to: '—' })).concat(b.filter(x => !a.includes(x)).map(x => ({ label: 'Add', from: '—', to: x })));
  }
  if (c.action === 'delete') return [{ label: 'Removed', from: `${c.label}, ${who(c.before.owner)}`, to: 'No longer tracked' }];
  if (c.action === 'add') return Object.keys(c.after).filter(k => c.after[k] != null && c.after[k] !== '').map(k => ({ label: fieldLabel(k), from: '—', to: fieldVal(k, c.after[k]) }));
  return Object.keys(c.after).map(k => ({ label: fieldLabel(k), from: fieldVal(k, c.before[k]), to: fieldVal(k, c.after[k]) }));
}
function monthlySplit(target, o) {
  if (!o) return [0, 0];
  const mo = target === 'bill' ? (o.status === 'Ended' ? 0 : num(o.amount) / (FREQ[o.freq || 'Monthly'] || 0 || Infinity)) : (o.status === 'Paid off' ? 0 : num(o.payment));
  const s = shareP1(o.owner, o.share);
  return [mo * s, mo * (1 - s)];
}
function changeImpact(c) {
  if (c.target !== 'bill' && c.target !== 'debt') return null;
  const rec = findRec(c) || {};
  const before = c.action === 'add' ? null : Object.assign({}, rec, c.action === 'edit' ? c.before : {});
  const after = c.action === 'delete' ? null : Object.assign({}, rec, c.after);
  const [a1, a2] = monthlySplit(c.target, before), [b1, b2] = monthlySplit(c.target, after);
  const d1 = b1 - a1, d2 = b2 - a2;
  if (Math.abs(d1) < 0.5 && Math.abs(d2) < 0.5) return 'No change to what either of you carries each month.';
  const f = (n, d) => `${n} ${d >= 0 ? '+' : '−'}${money(Math.abs(d))}/mo`;
  return `Each month: ${f(S().p1, d1)}, ${f(S().p2, d2)}.`;
}
function sigState(c, k) { const s = c.sig[k]; return !s ? 'none' : s.declined ? 'declined' : 'signed'; }
function waitingOn(c) { return ['p1', 'p2'].filter(k => sigState(c, k) === 'none').map(k => S()[k]); }

/* ---------- the gate: what applies now and what waits for signatures ---------- */
function gateSave(type, rec, vals, isNew) {
  if (type === 'misc') {
    const before = isNew ? {} : pick(rec, ['amount', 'owner', 'share', 'paidBy', 'status']);
    Object.assign(rec, vals);
    if (!isNew && ['amount', 'owner', 'share', 'paidBy', 'status'].some(k => !same(before[k], rec[k]))) rec.approvals = {};
    rec.approvals = rec.approvals || {};
    if (miscNeedsBoth(rec) && S().me && rec.approvals[S().me] == null) rec.approvals[S().me] = true;
    return miscStatus(rec) === 'Awaiting approval' ? 'Saved. It counts once both of you approve.' : '';
  }
  if (type === 'payment' && !isNew && (!same(rec.amount, vals.amount) || rec.paidBy !== vals.paidBy || rec.kind !== vals.kind)) rec.approvals = {};
  if (type !== 'bill' && type !== 'debt') { Object.assign(rec, vals); return ''; }
  const keys = RESP[type];
  if (isNew) {
    Object.assign(rec, vals); rec.pending = true;
    addChange({ target: type, targetId: rec.id, action: 'add', label: rec.name, before: {}, after: pick(rec, keys) });
    return 'Saved as a proposal. It becomes binding when both of you sign.';
  }
  if (rec.pending) {
    Object.assign(rec, vals);
    const c = openChange(rec.id, 'add');
    if (c) { c.after = pick(rec, keys); c.label = rec.name; c.sig = { p1: null, p2: null }; c.at = nowISO(); }
    return 'Proposal updated. Signatures start again.';
  }
  const diff = {};
  for (const k of keys) if (k in vals && !same(vals[k], rec[k])) diff[k] = vals[k];
  if ('status' in diff && diff.status !== END_WORD[type] && rec.status !== END_WORD[type]) delete diff.status;
  for (const k of Object.keys(vals)) if (!(k in diff)) rec[k] = vals[k];
  const open = openChange(rec.id, 'edit');
  if (!Object.keys(diff).length) { if (open) closeChange(open, 'Withdrawn'); return ''; }
  const before = {}; for (const k in diff) before[k] = rec[k] ?? null;
  if (open) Object.assign(open, { before, after: diff, label: rec.name, sig: { p1: null, p2: null }, at: nowISO() });
  else addChange({ target: type, targetId: rec.id, action: 'edit', label: rec.name, before, after: diff });
  return 'Saved. The change of responsibility takes effect when both of you sign.';
}
function gateDelete(type, rec) {
  if ((type !== 'bill' && type !== 'debt') || !rec || rec.pending) return false;
  if (openChange(rec.id, 'delete')) { $sheet.close(); toast('Removal is already waiting for signatures'); return true; }
  ask(`Propose removing ${rec.name}?`, 'It stays binding, and keeps counting, until both of you sign the removal.', 'Propose removal', () => {
    addChange({ target: type, targetId: rec.id, action: 'delete', label: rec.name, before: pick(rec, ['owner']), after: {} });
    rerender(); toast('Removal proposed. Both of you need to sign.');
  });
  return true;
}
function proposeSettings(obj) {
  const open = state.changes.find(c => c.status === 'Pending' && c.target === 'settings');
  const after = Object.assign({}, open ? open.after : {}, obj), before = Object.assign({}, open ? open.before : {});
  for (const k of Object.keys(obj)) if (!(k in before)) before[k] = S()[k] ?? null;
  for (const k of Object.keys(after)) if (same(after[k], S()[k])) { delete after[k]; delete before[k]; }
  if (!Object.keys(after).length) { if (open) closeChange(open, 'Withdrawn'); rerender(); return toast('No change to propose'); }
  if (open) Object.assign(open, { before, after, sig: { p1: null, p2: null }, at: nowISO() });
  else addChange({ target: 'settings', targetId: 'settings', action: 'edit', label: 'Settings', before, after });
  rerender(); toast('Proposed. It takes effect when both of you sign.');
}
function proposeAgreements(list) {
  if (list.join('\n') === state.agreements.join('\n')) return toast('No change to propose');
  const open = state.changes.find(c => c.status === 'Pending' && c.target === 'agreements');
  if (open) Object.assign(open, { after: { list }, sig: { p1: null, p2: null }, at: nowISO() });
  else addChange({ target: 'agreements', targetId: 'agreements', action: 'edit', label: 'Agreements', before: { list: state.agreements.slice() }, after: { list } });
  rerender(); toast('Proposed. The new wording applies when both of you sign.');
}
function applyChange(c) {
  const rec = findRec(c);
  if (c.target === 'settings') Object.assign(S(), c.after);
  else if (c.target === 'agreements') state.agreements = c.after.list.slice();
  else if (c.action === 'add' && rec) delete rec.pending;
  else if (c.action === 'edit' && rec) Object.assign(rec, c.after);
  else if (c.action === 'delete' && rec) { const coll = c.target === 'bill' ? 'bills' : 'debts'; state[coll] = state[coll].filter(x => x.id !== rec.id); }
  state.agreeVersion = (state.agreeVersion || 1) + 1;
  ui.planMonth = null;
  closeChange(c, 'Signed');
}

/* ---------- signing ---------- */
function openSign(id, k) {
  const c = state.changes.find(x => x.id === id); if (!c || c.status !== 'Pending') return;
  const lines = changeLines(c), imp = changeImpact(c), name = S()[k];
  const elsewhere = S().me && S().me !== k;
  $sheet.innerHTML = `<form data-sign="${c.id}" data-who="${k}"><div class="sheet-head"><h2>${esc(name)}: sign this change</h2><p class="small muted" style="margin:4px 0 0">${esc(changeTitle(c))}</p></div>
    <div class="sheet-body">${diffTable(lines)}${imp ? `<p class="small" style="margin:10px 0 0"><b>${esc(imp)}</b></p>` : ''}
    <div class="notice" style="margin:14px 0"><div class="small">By signing I agree this change replaces the current terms. Until both of us sign, the current terms stay binding.</div></div>
    ${elsewhere ? `<div class="notice warn" style="margin-bottom:12px"><div class="small">This device belongs to ${esc(S()[S().me])}. ${esc(name)} should sign on their own device. A signature here is recorded as made on ${esc(S()[S().me])}'s device.</div></div>` : ''}
    <div class="field full"><label for="sig-name">Type your name to sign: <b>${esc(name)}</b></label><input id="sig-name" name="sig" autocomplete="off" required placeholder="${esc(name)}"></div></div>
    <div class="sheet-foot"><button type="button" class="btn danger ghost grow" data-action="decline-change" data-id="${c.id}" data-who="${k}">Decline</button>
    <button type="button" class="btn" data-action="close">Cancel</button><button type="submit" class="btn primary">Sign</button></div></form>`;
  if (!$sheet.open) $sheet.showModal();
  setTimeout(() => { const i = $sheet.querySelector('#sig-name'); if (i) i.focus(); }, 50);
}
function diffTable(lines) {
  if (!lines.length) return '<p class="muted small">Nothing to show.</p>';
  return `<div class="tablewrap"><table class="diff"><thead><tr><th>What</th><th>Now (binding)</th><th>Proposed</th></tr></thead><tbody>${lines.map(l => `<tr><td>${esc(l.label)}</td><td class="from">${esc(l.from)}</td><td class="to">${esc(l.to)}</td></tr>`).join('')}</tbody></table></div>`;
}
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-sign]'); if (!f) return;
  e.preventDefault();
  const c = state.changes.find(x => x.id === f.dataset.sign), k = f.dataset.who, typed = f.sig.value.trim();
  if (!c || c.status !== 'Pending') return $sheet.close();
  if (typed.toLowerCase() !== String(S()[k]).trim().toLowerCase()) return toast(`Type ${S()[k]} exactly as it appears to sign`);
  c.sig[k] = { name: typed, at: nowISO(), device: S().me || '' };
  logAct(`${S()[k]} signed`, changeTitle(c));
  const done = sigState(c, 'p1') === 'signed' && sigState(c, 'p2') === 'signed';
  if (done) applyChange(c);
  $sheet.close(); rerender();
  toast(done ? 'Signed by both of you. The change is now binding.' : `Signed. Waiting for ${waitingOn(c).join(' and ')}.`);
});

/* ---------- views ---------- */
function govPill(id) {
  const c = openChange(id); if (!c) return '';
  const t = c.action === 'add' ? 'New: needs both signatures' : c.action === 'delete' ? 'Removal awaiting signatures' : 'Change awaiting signatures';
  return `<span class="pill s-warn" data-go="agree">${t}</span>`;
}
function formNote(type, rec) {
  if (type !== 'bill' && type !== 'debt') return '';
  if (!rec) return `<div class="notice" style="margin-bottom:12px"><div class="small">A new ${type} is a proposal. It joins the plan and the split once both of you sign it.</div></div>`;
  const c = openChange(rec.id);
  if (c) return `<div class="notice warn" style="margin-bottom:12px"><div class="small"><b>${esc(changeTitle(c))}</b> is waiting for ${esc(waitingOn(c).join(' and ') || 'signatures')}. ${c.action === 'edit' ? 'The form shows the proposed values. Saving again updates the proposal and the signatures start over.' : ''}</div><a class="btn sm" href="#/agree">Review</a></div>`;
  return `<p class="small muted" style="margin:0 0 10px">Changes to who carries it, the split, the amount, how often or the due day take effect once both of you sign. Everything else saves straight away.</p>`;
}
function changeCard(c) {
  const imp = changeImpact(c), by = c.by ? ` by ${esc(S()[c.by])}` : '';
  const sigs = ['p1', 'p2'].map(k => { const st = sigState(c, k), s = c.sig[k];
    if (st === 'signed') return `<span class="sig on"><b>${esc(s.name)}</b> signed ${new Date(s.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>`;
    if (st === 'declined') return `<span class="pill s-bad">${esc(S()[k])} declined</span>`;
    return c.status === 'Pending' ? `<button class="btn sm primary" data-action="sign-change" data-id="${c.id}" data-who="${k}">Sign as ${esc(S()[k])}</button>` : `<span class="pill">${esc(S()[k])} did not sign</span>`; }).join('');
  const pillCls = { Pending: 's-warn', Signed: 's-good', Declined: 's-bad', Withdrawn: '' }[c.status];
  return `<div class="change"><div class="spread"><div><div class="title">${esc(changeTitle(c))}</div><div class="sub small muted">Proposed${by} ${dateShort(localDay(c.at))}${c.closedAt && c.status !== 'Pending' ? ` · ${c.status.toLowerCase()} ${dateShort(localDay(c.closedAt))}` : ''}</div></div><span class="pill ${pillCls}">${c.status === 'Pending' ? 'Awaiting ' + esc(waitingOn(c).join(' and ')) : c.status}</span></div>
    ${diffTable(changeLines(c))}${imp ? `<p class="small" style="margin:8px 0 0">${esc(imp)}</p>` : ''}
    <div class="row" style="margin-top:10px">${sigs}${c.status === 'Pending' ? `<button class="btn sm ghost" data-action="withdraw-change" data-id="${c.id}">Withdraw</button>` : ''}</div></div>`;
}
VIEWS.agree = () => {
  const pend = pendingChanges().slice().reverse(), hist = state.changes.filter(c => c.status !== 'Pending').slice().reverse().slice(0, 40), t = totals();
  const live = items().filter(i => i.kind !== 'misc' && i.name);
  const mo = it => it.kind === 'bill' ? billMonthly(it.ref) : (debtActive(it.ref) ? num(it.ref.payment) : 0);
  const rows = live.map(it => ({ it, mo: mo(it), s: shareP1(it.owner, it.share) })).filter(r => r.mo > 0).sort((a, b) => (a.it.owner || '').localeCompare(b.it.owner || '') || b.mo - a.mo);
  const lastSigned = state.changes.filter(c => c.status === 'Signed').map(c => c.closedAt).sort().pop();
  return header('Responsibility agreement', 'Who carries what is binding. Any change waits for both signatures, and until then the current terms stand.') +
    `<div class="grid g4" style="margin-bottom:12px">${kpi(`${S().p1} carries`, money(t.p1), 'Per month, binding', 't-p1')}${kpi(`${S().p2} carries`, money(t.p2), 'Per month, binding', 't-p2')}
      ${kpi('Changes to sign', String(pend.length), pend.length ? 'Current terms still apply' : 'Nothing waiting', pend.length ? 't-bad' : 't-good')}${kpi('Version', String(state.agreeVersion || 1), lastSigned ? 'Last signed ' + dateShort(localDay(lastSigned)) : 'Baseline from your workbook', '')}</div>
    <div class="cols"><div>
      <div class="card"><h2>Waiting for signatures</h2>${pend.map(changeCard).join('') || '<p class="muted">Nothing to sign. Edit a bill, debt, the split or the agreements and the change appears here.</p>'}</div>
      <div class="card"><div class="spread"><h2>Our agreements</h2><button class="btn sm" data-action="edit-agreements">Propose an edit</button></div><ol class="agree">${state.agreements.map(a => `<li>${esc(a)}</li>`).join('')}</ol></div>
      <div class="card"><h2>History</h2>${hist.map(changeCard).join('') || '<p class="muted">No signed changes yet.</p>'}</div></div>
    <div><div class="card"><h2>Current terms</h2><p class="small muted" style="margin-top:0">${SPLITS[S().split]} split · both approve at or above ${money(S().threshold)} · Shared default ${esc(S().p1)} ${pct(S().defShare)}</p>
      <div class="tablewrap"><table><thead><tr><th>Item</th><th>Carried by</th><th>${esc(S().p1)}</th><th>${esc(S().p2)}</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><span class="tap" data-action="edit-${r.it.kind}" data-id="${r.it.id}">${esc(r.it.name)}</span></td><td>${ownerPill(r.it.owner)}</td><td>${r.s ? money(r.mo * r.s) : ''}</td><td>${r.s < 1 ? money(r.mo * (1 - r.s)) : ''}</td></tr>`).join('')}
      <tr class="total"><td>Per month</td><td></td><td>${money(t.p1)}</td><td>${money(t.p2)}</td></tr></tbody></table></div></div></div></div>`;
};

VIEWS.misc = () => {
  const cm = thisMonth(), m = ui.miscMonth || cm;
  const ms = Array.from(new Set(state.misc.map(x => ym(x.date)).concat([cm]))).filter(Boolean).sort().reverse();
  const list = state.misc.filter(x => ym(x.date) === m).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const counts = list.filter(x => miscStatus(x) === 'Counted');
  const total = counts.reduce((t, x) => t + num(x.amount), 0);
  let c1 = 0, c2 = 0; for (const x of counts) { const s = shareP1(x.owner, x.share); c1 += num(x.amount) * s; c2 += num(x.amount) * (1 - s); }
  const toPay = counts.filter(x => x.status === 'To pay').reduce((t, x) => t + num(x.amount), 0);
  const waiting = list.filter(x => miscStatus(x) === 'Awaiting approval');
  const byCat = MISC_CATS.map(c => [c, counts.filter(x => (x.category || 'Other') === c).reduce((t, x) => t + num(x.amount), 0)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...byCat.map(x => x[1]));
  const li = x => { const st = miscStatus(x), a = x.approvals || {};
    const approve = st === 'Awaiting approval' ? `<div class="row" style="margin-top:6px">${['p1', 'p2'].map(k => a[k] ? `<span class="pill s-good">${esc(who(k))} approved</span>` :
      `<button class="btn sm" data-action="approve-misc" data-id="${x.id}" data-who="${k}">Approve as ${esc(who(k))}</button><button class="btn sm ghost danger" data-action="decline-misc" data-id="${x.id}" data-who="${k}">Decline</button>`).join('')}</div>` : '';
    return `<li><span class="dot ${st === 'Declined' ? 'bad' : st !== 'Counted' ? 'warn' : x.status === 'Paid' ? 'good' : 'due'}"></span><div class="main tap" data-action="edit-misc" data-id="${x.id}"><div class="title">${esc(x.desc)}</div>
      <div class="sub">${dateShort(x.date)} · ${esc(x.category || 'Other')} · ${x.status === 'Paid' ? 'paid by ' + esc(who(x.paidBy)) : 'to pay'}${x.notes ? ' · ' + esc(x.notes) : ''}</div>${approve}</div>
      <div class="end"><div class="amt">${money(x.amount, true)}</div>${ownerPill(x.owner)}${st !== 'Counted' ? `<div><span class="pill ${st === 'Declined' ? 's-bad' : 's-warn'}">${st}</span></div>` : ''}</div>
      ${x.status === 'To pay' && st === 'Counted' ? `<button class="btn sm" data-action="mark-paid" data-id="${x.id}">Paid</button>` : ''}</li>`; };
  return header('Miscellaneous costs', `One-off and everyday costs that are not on the bill list. Shared ones of ${money(S().threshold)} or more, or ones paid for the other person, need both of you.`, `<button class="btn primary" data-action="new-misc">Add a cost</button>`) +
    `<div class="chips" style="margin-bottom:12px">${ms.map(x => `<button class="chip ${x === m ? 'on' : ''}" data-action="misc-month" data-v="${x}">${monthName(x)}</button>`).join('')}</div>
    <div class="grid g4" style="margin-bottom:12px">${kpi('Counted this month', money(total), `${counts.length} cost${counts.length === 1 ? '' : 's'} · ${monthName(m, true)}`, '')}${kpi(`${S().p1} carries`, money(c1), 'Including part of Shared', 't-p1')}
      ${kpi(`${S().p2} carries`, money(c2), 'Including part of Shared', 't-p2')}${kpi('Still to pay', money(toPay), waiting.length ? `${waiting.length} waiting for approval` : 'Planned costs', toPay ? 't-bad' : '')}</div>
    <div class="cols"><div class="card"><h2>${monthName(m, true)}</h2><ul class="list">${list.map(li).join('') || '<li class="muted">Nothing logged this month. Use Add a cost for anything outside the bill list.</li>'}</ul></div>
    <div class="card"><h2>By category</h2>${byCat.length ? `<ul class="list">${byCat.map(([c, v]) => `<li><div class="main"><div class="spread"><span class="title">${esc(c)}</span><span class="amt">${money(v)}</span></div><div class="bar" style="margin-top:6px"><i style="width:${v / maxCat * 100}%;background:var(--acc)"></i></div></div></li>`).join('')}</ul>` : '<p class="muted">Nothing counted yet.</p>'}
      <p class="small muted">Counted costs go into the plan, each person's share and settle up the same way bills do.</p></div></div>`;
};

const baseHome2 = VIEWS.home;
VIEWS.home = () => {
  const html = baseHome2(), n = pendingChanges().length;
  if (!n) return html;
  const i = html.indexOf('</div></div>') + 12;
  return html.slice(0, i) + `<div class="notice warn" style="margin-bottom:12px"><div style="flex:1"><b>${n} change${n > 1 ? 's' : ''} waiting for both signatures.</b> The current terms stay binding until you both sign.</div><a class="btn sm" href="#/agree">Review and sign</a></div>` + html.slice(i);
};
const baseSettings2 = VIEWS.settings;
VIEWS.settings = () => {
  const html = baseSettings2(), c = state.changes.find(x => x.status === 'Pending' && x.target === 'settings');
  const i = html.indexOf('</div></div>') + 12;
  const note = `<div class="notice ${c ? 'warn' : ''}" style="margin-bottom:12px"><div class="small" style="flex:1">${c ? `<b>Proposed:</b> ${changeLines(c).map(l => `${esc(l.label)} ${esc(l.from)} → ${esc(l.to)}`).join('; ')}. Waiting for ${esc(waitingOn(c).join(' and '))}.` : 'The split, the shared default, the approval amount (and take-home pay under By income) are part of your agreement. Changing them sends a proposal both of you sign.'}</div>${c ? '<a class="btn sm" href="#/agree">Review</a>' : ''}</div>`;
  return html.slice(0, i) + note + html.slice(i);
};

/* ---------- quick add and sample data ---------- */
function quickAdd() {
  $sheet.innerHTML = `<div><div class="sheet-head"><h2>Add</h2></div><div class="sheet-body"><div class="quick">
    <button class="btn" data-action="new-payment"><b>Log a payment</b><span>A bill or debt you paid</span></button>
    <button class="btn" data-action="new-misc"><b>Miscellaneous cost</b><span>Anything not on the bill list</span></button>
    <button class="btn" data-action="new-bill"><b>Propose a bill</b><span>Becomes binding when both sign</span></button>
    <button class="btn" data-action="new-debt"><b>Propose a debt</b><span>Becomes binding when both sign</span></button></div></div>
    <div class="sheet-foot"><button class="btn grow" data-action="close">Close</button></div></div>`;
  if (!$sheet.open) $sheet.showModal();
}
function sampleState() {
  const s = blankState(), m = thisMonth(), d = n => dayOf(m, n), id = () => uid();
  Object.assign(s.settings, { p1: 'Alex', p2: 'Sam', incomeP1: 6200, incomeP2: 4800, me: '' });
  s.settings.pay.p1.amount = 3100; s.settings.pay.p2.amount = 2400;
  const B = (name, amount, owner, dueDay, category, extra = {}) => Object.assign({ id: id(), name, amount, owner, dueDay, category, freq: 'Monthly', priority: 'Normal', status: 'Current' }, extra);
  s.bills = [B('Mortgage', 1850, 'p1', 1, 'Housing', { priority: 'Critical', portal: 'https://example.com/pay' }), B('Car payment', 420, 'p1', 12, 'Cars & transport'), B('Car insurance', 190, 'p1', 20, 'Insurance'),
    B('Electricity', 140, 'p2', 18, 'Utilities'), B('Internet', 80, 'p2', 22, 'Utilities'), B('School fees', 650, 'p2', 5, 'Schools & childcare'),
    B('Groceries', 700, 'shared', 28, 'Household'), B('Phones', 120, 'shared', 25, 'Personal')];
  s.debts = [{ id: id(), name: 'Visa card', type: 'Credit card', owner: 'p1', balance: 4200, asOf: `${m}-01`, payment: 150, apr: 0.229, dueDay: 15, status: 'Current', include: 'Yes' },
    { id: id(), name: 'Store card', type: 'Credit card', owner: 'p1', balance: 900, asOf: `${m}-01`, payment: 60, apr: 0.269, dueDay: 9, status: 'Current', include: 'Yes' }];
  const P = (bill, by, day, amt) => ({ id: id(), itemId: bill.id, itemKind: 'bill', itemName: bill.name, paidBy: by, amount: amt ?? bill.amount, date: d(day), kind: 'Scheduled', approvals: {} });
  s.payments = [P(s.bills[0], 'p1', 1), P(s.bills[5], 'p2', 5)];
  s.misc = [{ id: id(), desc: 'Plumber call-out', amount: 320, date: d(3), category: 'Repairs & maintenance', owner: 'shared', status: 'Paid', paidBy: 'p1', approvals: { p1: true } },
    { id: id(), desc: 'School trip', amount: 45, date: d(6), category: 'Kids & school extras', owner: 'p2', status: 'Paid', paidBy: 'p2', approvals: {} },
    { id: id(), desc: 'Birthday party', amount: 180, date: d(26), category: 'Gifts & celebrations', owner: 'shared', status: 'To pay', paidBy: 'joint', approvals: {} }];
  s.changes = [{ id: id(), target: 'bill', targetId: s.bills[6].id, action: 'edit', label: 'Groceries', before: { owner: 'shared' }, after: { owner: 'p2' }, at: nowISO(), by: 'p2', sig: { p1: null, p2: { name: 'Sam', at: nowISO(), device: '' } }, status: 'Pending' }];
  s.activity = [{ at: nowISO(), who: '', what: 'Loaded sample data', detail: 'Alex and Sam' }];
  return s;
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const a = e.target.closest('[data-action]'); if (!a) return;
  const id = a.dataset.id, k = a.dataset.who;
  switch (a.dataset.action) {
    case 'quick-add': return quickAdd();
    case 'new-misc': return openForm('misc', null);
    case 'edit-misc': return openForm('misc', id);
    case 'misc-month': ui.miscMonth = a.dataset.v; return render();
    case 'approve-misc': case 'decline-misc': { const x = state.misc.find(r => r.id === id); x.approvals = x.approvals || {}; x.approvals[k] = a.dataset.action === 'approve-misc'; logAct(`${who(k)} ${x.approvals[k] ? 'approved' : 'declined'} a cost`, `${x.desc} ${money(x.amount, true)}`); rerender(); return toast(x.approvals[k] ? 'Approved' : 'Declined'); }
    case 'sign-change': return openSign(id, k);
    case 'decline-change': { const c = state.changes.find(x => x.id === id); return ask(`Decline: ${changeTitle(c)}?`, 'The current terms stay as they are. The proposer can make a new proposal.', 'Decline', () => { c.sig[k] = { declined: true, at: nowISO(), device: S().me || '' }; closeChange(c, 'Declined'); rerender(); toast('Declined. Nothing changed.'); }, true); }
    case 'withdraw-change': { const c = state.changes.find(x => x.id === id); return ask(`Withdraw: ${changeTitle(c)}?`, 'The current terms stay as they are.', 'Withdraw', () => { closeChange(c, 'Withdrawn'); rerender(); toast('Withdrawn'); }); }
    case 'sample': state = normalize(sampleState()); ui.planMonth = null; rerender(); return toast('Sample data loaded. Erase it in Settings when you are done.');
  }
});

/* ---------- boot ---------- */
Object.assign(window.hub, { gateSave, applyChange, proposeSettings, sampleState });
// boot happens at the end of credit.js
