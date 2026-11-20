/* Household Hub, part 5: credit scores, inside Opportunities & investments.
   Each person logs the scores they see (any app or bureau). The factor breakdown is read from the household's own
   bills and debts: late payments, card utilization against credit limits, collections, credit age and new accounts,
   weighted the way FICO publishes its score. Credit steps join the opportunities list. */
'use strict';

const FICO_WEIGHTS = [['Payment history', 0.35], ['Amounts owed (utilization)', 0.30], ['Length of credit history', 0.15], ['New credit', 0.10], ['Credit mix', 0.10]];
const BANDS = [[800, 'Exceptional', 'good'], [740, 'Very good', 'good'], [670, 'Good', 'acc'], [580, 'Fair', 'warn'], [300, 'Poor', 'bad']];
const CREDIT_LINKS = { reports: 'https://www.annualcreditreport.com', dispute: 'https://www.consumerfinance.gov/consumer-tools/credit-reports-and-scores/', fico: 'https://www.myfico.com/credit-education/whats-in-your-credit-score' };
const band = s => BANDS.find(b => s >= b[0]) || BANDS[BANDS.length - 1];

FORMS.score = { coll: 'credit', title: 'Credit score', fields: () => [
  ['who', 'Whose score', 'select', { opts: [['p1', S().p1], ['p2', S().p2]], def: ui.creditK || S().me || 'p1' }], ['score', 'Score', 'money', { req: 1, hint: '300 to 850' }],
  ['date', 'Date', 'date', { req: 1, def: todayISO() }], ['source', 'Where from', 'select', { opts: L(['FICO 8 (Experian)', 'FICO (bank or card app)', 'VantageScore (Credit Karma)', 'Equifax', 'TransUnion', 'Lender pull', 'Other']), def: 'FICO (bank or card app)' }],
  ['notes', 'Notes', 'textarea', { full: 1 }]] };
const baseValidate = validateForm;
validateForm = function (type, form) {
  if (type === 'score') { const v = num(form.elements.score.value); if (v < 300 || v > 850) return 'Scores run from 300 to 850'; }
  return baseValidate(type, form);
};

/* ---------- reading credit from the household data ---------- */
function forPerson(x, k) { return x.owner === k || x.owner === 'shared'; }
function creditPicture(k) {
  const live = state.debts.filter(d => !d.pending && d.include !== 'No' && forPerson(d, k));
  const cards = live.filter(d => d.type === 'Credit card' && !['In collections', 'Settlement offer', 'Paid off'].includes(d.status));
  const limited = cards.filter(d => num(d.limit) > 0);
  const bal = limited.reduce((s, d) => s + debtBalance(d), 0), lim = limited.reduce((s, d) => s + num(d.limit), 0);
  const util = lim ? bal / lim : null;
  const over = limited.map(d => ({ d, u: debtBalance(d) / num(d.limit), need: Math.max(0, debtBalance(d) - 0.3 * num(d.limit)) })).sort((a, b) => b.u - a.u);
  const late = state.bills.filter(b => !b.pending && forPerson(b, k) && (b.status === 'Behind' || num(b.pastDue) > 0)).concat(live.filter(d => d.status === 'Behind'));
  const coll = live.filter(d => d.type === 'Collection' || ['In collections', 'Settlement offer'].includes(d.status));
  const opened = live.map(d => d.opened).filter(Boolean).sort();
  const ageYears = opened.length ? monthDiff(opened[0], thisMonth()) / 12 : null;
  const recent = live.filter(d => d.opened && monthDiff(d.opened, thisMonth()) <= 12).length;
  const bnpl = live.filter(d => d.type === 'BNPL' && debtBalance(d) > 0);
  const types = new Set(live.filter(d => debtBalance(d) > 0).map(d => d.type));
  const mortgage = state.bills.some(b => !b.pending && forPerson(b, k) && /mortgage/i.test(b.name));
  const scores = (state.credit || []).filter(s => s.who === k && s.score).sort((a, b) => a.date.localeCompare(b.date));
  return { cards, limited, noLimit: cards.filter(d => !num(d.limit)), bal, lim, util, over, late, coll, collBal: coll.reduce((s, d) => s + debtBalance(d), 0), ageYears, recent, bnpl, types, mortgage, scores, latest: scores[scores.length - 1], prev: scores[scores.length - 2] };
}
function factors(C) {
  const f = [];
  f.push(['Payment history', 0.35, C.late.length ? 'bad' : 'good', C.late.length ? `${C.late.length} account${C.late.length > 1 ? 's are' : ' is'} behind: ${C.late.slice(0, 4).map(x => x.name).join(', ')}${C.late.length > 4 ? '…' : ''}. A payment 30 or more days late is reported and is the biggest single hit. Set autopay for at least the minimum everywhere.` : 'Nothing marked behind. Keep every account at least at the minimum, on time, every month.']);
  f.push(['Amounts owed (utilization)', 0.30, C.util == null ? (C.cards.length ? 'warn' : 'good') : C.util > 0.3 ? 'bad' : C.util > 0.1 ? 'warn' : 'good',
    C.util == null ? (C.cards.length ? `Add credit limits to ${C.cards.length} card${C.cards.length > 1 ? 's' : ''} to see utilization.` : 'No open cards tracked.') : `${pctx(C.util, 0)} of ${money(C.lim)} in limits is used. Under 30% helps; under 10% is best. ${C.over.filter(o => o.u > 0.3).length ? `Over 30%: ${C.over.filter(o => o.u > 0.3).map(o => `${o.d.name} ${pctx(o.u, 0)}`).join(', ')}.` : ''}${C.noLimit.length ? ` ${C.noLimit.length} card${C.noLimit.length > 1 ? 's have' : ' has'} no limit entered.` : ''}`]);
  f.push(['Length of credit history', 0.15, C.ageYears == null ? 'warn' : C.ageYears >= 7 ? 'good' : 'warn', C.ageYears == null ? 'Add the month each account opened to track credit age. Keep your oldest cards open, even at a zero balance.' : `Oldest account about ${Math.floor(C.ageYears)} years. Keep old cards open and used lightly; closing them shortens history and cuts available credit.`]);
  f.push(['New credit', 0.10, C.recent > 1 || C.bnpl.length > 3 ? 'warn' : 'good', `${C.recent ? `${C.recent} account${C.recent > 1 ? 's' : ''} opened in the last year. ` : ''}${C.bnpl.length ? `${C.bnpl.length} pay-later plans open; some lenders now report them. ` : ''}Avoid new applications for a few months before a refinance or consolidation loan.`]);
  f.push(['Credit mix', 0.10, C.types.size >= 2 || C.mortgage ? 'good' : 'warn', `${C.mortgage ? 'Mortgage plus ' : ''}${[...C.types].join(', ') || 'no open debts'}. Mix matters least; never open an account just for it.`]);
  if (C.coll.length) f.push(['Collections', null, 'bad', `${C.coll.length} account${C.coll.length > 1 ? 's' : ''} in collections (${money(C.collBal)}). Newer scores (FICO 9 and 10, VantageScore 3 and 4) ignore paid collections, and collections drop off reports seven years after the first missed payment. Get any settlement in writing, then check the report shows it as paid.`]);
  return f;
}

/* ---------- credit steps join the opportunities ---------- */
const baseOpps = opportunities;
opportunities = function () {
  const out = baseOpps(), O = state.opps || {}, add = o => out.push(Object.assign({ kind: 'credit', monthly: 0, frees: 0, links: [], status: (O[o.id] && O[o.id].status) || 'open' }, o));
  for (const k of ['p1', 'p2']) {
    const C = creditPicture(k), n = S()[k];
    if (!C.cards.length && !C.coll.length && !C.late.length) continue;
    const need = C.over.reduce((s, o) => s + o.need, 0);
    if (need > 0) add({ id: `util:${k}`, title: `${n}: pay ${money(need)} to bring every card under 30% utilization`, impact: 'Score lift', detail: `${C.over.filter(o => o.need > 0).map(o => `${o.d.name} ${pctx(o.u, 0)} used, pay ${money(o.need)}`).join('; ')}. Utilization is 30% of a FICO score and updates as soon as the lower balance reports, usually on the statement date. Pay before the statement closes for the fastest effect.` });
    if (C.noLimit.length) add({ id: `limits:${k}`, kind: 'fix', title: `${n}: add credit limits to ${C.noLimit.length} card${C.noLimit.length > 1 ? 's' : ''}`, impact: 'Data', go: 'debts', detail: `${C.noLimit.map(d => d.name).join(', ')}. The limit is on each statement; with it the app can show utilization and what to pay first.` });
    if (C.late.length) add({ id: `autopay:${k}`, kind: 'fix', title: `${n}: protect payment history with autopay`, impact: 'Score protection', detail: `Set autopay for at least the minimum on every card and loan, and catch up ${C.late.slice(0, 3).map(x => x.name).join(', ')} before it reaches 30 days late. Payment history is 35% of a FICO score.` });
    add({ id: `reports:${k}`, title: `${n}: check all three credit reports`, impact: 'Free', links: [['AnnualCreditReport.com', CREDIT_LINKS.reports], ['CFPB: disputing errors', CREDIT_LINKS.dispute]],
      detail: `Free every week from Equifax, Experian and TransUnion. Check that each account, balance and late mark is right, that settled or paid collections show as paid, and dispute anything wrong with the bureau in writing.${C.scores.length ? '' : ' Then log the scores here to track progress.'}` });
  }
  return out;
};

/* ---------- the credit card in the section ---------- */
function scoreChart(scores) {
  if (scores.length < 2) return '';
  const W = 560, H = 120, pl = 36, lo = Math.max(300, Math.min(...scores.map(s => num(s.score))) - 40), hi = Math.min(850, Math.max(...scores.map(s => num(s.score))) + 40);
  const t0 = Date.parse(scores[0].date), t1 = Date.parse(scores[scores.length - 1].date) || t0 + 1;
  const x = s => pl + ((Date.parse(s.date) - t0) / Math.max(1, t1 - t0)) * (W - pl - 10), y = v => 8 + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - 30);
  const bands = BANDS.filter(b => b[0] >= lo && b[0] <= hi).map(b => `<line x1="${pl}" x2="${W - 10}" y1="${y(b[0])}" y2="${y(b[0])}" stroke="#e5e9ec" stroke-dasharray="3 3"/><text x="${pl - 4}" y="${y(b[0]) + 4}" text-anchor="end">${b[0]}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score history">${bands}<path d="${scores.map((s, i) => `${i ? 'L' : 'M'}${x(s).toFixed(1)},${y(num(s.score)).toFixed(1)}`).join('')}" fill="none" stroke="#2f6f73" stroke-width="2.5"/>
    ${scores.map(s => `<circle cx="${x(s)}" cy="${y(num(s.score))}" r="3.5" fill="#2f6f73"><title>${dateShort(s.date)}: ${s.score}</title></circle>`).join('')}
    <text x="${pl}" y="${H - 4}">${dateShort(scores[0].date)}</text><text x="${W - 10}" y="${H - 4}" text-anchor="end">${dateShort(scores[scores.length - 1].date)}</text></svg>`;
}
function creditCard() {
  const k = ui.creditK || S().me || 'p1', C = creditPicture(k), L_ = C.latest, b = L_ ? band(num(L_.score)) : null;
  const diff = L_ && C.prev ? num(L_.score) - num(C.prev.score) : null, tone = { good: 'var(--good)', acc: 'var(--acc)', warn: 'var(--warn)', bad: 'var(--bad)' };
  const F = factors(C);
  return `<div class="card"><div class="spread"><h2>Credit score</h2><div class="row" style="gap:6px"><div class="chips">${['p1', 'p2'].map(x => `<button class="chip ${x === k ? 'on' : ''}" data-action="credit-k" data-v="${x}">${esc(S()[x])}</button>`).join('')}</div><button class="btn sm" data-action="new-score">Log a score</button></div></div>
    <div class="score-head">${L_ ? `<div class="score-num" style="color:${tone[b[2]]}">${esc(L_.score)}</div><div><div><b>${b[1]}</b>${diff != null ? ` <span class="pill ${diff >= 0 ? 's-good' : 's-bad'}">${diff >= 0 ? '+' : ''}${diff} since ${dateShort(C.prev.date)}</span>` : ''}</div><div class="small muted">${esc(L_.source || '')} · ${dateShort(L_.date)} · <span class="tap" data-action="edit-score" data-sid="${L_.id}">edit</span></div></div>`
      : `<div class="small muted">No score logged for ${esc(S()[k])} yet. Most banking and card apps show a free FICO or VantageScore; log it here monthly to see the trend.</div>`}</div>
    <div class="scale">${BANDS.slice().reverse().map((x, i, a) => `<span style="flex:${(a[i + 1] ? a[i + 1][0] : 851) - x[0]};background:${tone[x[2]]};opacity:${b && b[1] === x[1] ? 1 : .28}" title="${x[1]} ${x[0]}+"></span>`).join('')}${L_ ? `<i style="left:${(num(L_.score) - 300) / 550 * 100}%"></i>` : ''}</div>
    <div class="scale-labels tiny muted">${[300, 580, 670, 740, 800].map(v => `<span style="left:${(v - 300) / 550 * 100}%">${v}</span>`).join('')}</div>
    ${scoreChart(C.scores)}
    <h3 style="margin:14px 0 4px;font-size:14px">What is moving ${esc(S()[k])}'s score</h3>
    <ul class="list">${F.map(([n, w, st, t]) => `<li><span class="dot ${st === 'good' ? 'good' : st === 'bad' ? 'bad' : 'warn'}"></span><div class="main"><div class="spread"><span class="title">${esc(n)}</span><span class="small muted">${w ? pctx(w, 0) + ' of score' : 'Report item'}</span></div><div class="sub" style="white-space:normal">${esc(t)}</div></div></li>`).join('')}</ul>
    ${C.limited.length ? `<h3 style="margin:14px 0 4px;font-size:14px">Card utilization</h3><ul class="list">${C.over.map(o => `<li class="tap" data-action="edit-debt" data-id="${o.d.id}"><div class="main"><div class="spread"><span class="title">${esc(o.d.name)}</span><span class="amt">${pctx(o.u, 0)}</span></div><div class="bar" style="margin-top:6px"><i style="width:${Math.min(100, o.u * 100)}%;background:${o.u > 0.3 ? 'var(--bad)' : o.u > 0.1 ? 'var(--warn)' : 'var(--good)'}"></i></div><div class="sub">${money(debtBalance(o.d))} of ${money(o.d.limit)}${o.need ? ` · pay ${money(o.need)} to reach 30%` : ''}</div></div></li>`).join('')}</ul>` : ''}
    <p class="small muted" style="margin-bottom:0">Weights as published by <a href="${CREDIT_LINKS.fico}" target="_blank" rel="noopener">myFICO</a>. Read from the debts and bills in this app${C.noLimit.length ? '; add credit limits and opened dates to debts for a fuller picture' : ''}. A better score is what unlocks the lower consolidation and refinance rates above.</p></div>`;
}
const baseGrow = VIEWS.grow;
VIEWS.grow = () => {
  const html = baseGrow(), mark = '<div class="card"><div class="spread"><h2>Debt payoff plan</h2>', i = html.indexOf(mark);
  return i < 0 ? html : html.slice(0, i) + creditCard() + html.slice(i);
};

document.addEventListener('click', e => {
  const a = e.target.closest('[data-action]'); if (!a) return;
  switch (a.dataset.action) {
    case 'credit-k': ui.creditK = a.dataset.v; return render();
    case 'new-score': return openForm('score', null, { who: ui.creditK || S().me || 'p1' });
    case 'edit-score': return openForm('score', a.dataset.sid);
  }
});
const baseExportExtra2 = exportExtra;
exportExtra = function (add, D, $) {
  baseExportExtra2(add, D, $);
  add('Credit Scores', ['Date', 'Person', 'Score', 'Band', 'Source', 'Notes'], (state.credit || []).slice().sort((a, b) => a.date.localeCompare(b.date)).map(s => [D(s.date), who(s.who), num(s.score), band(num(s.score))[1], s.source, s.notes]), [12, 12, 8, 12, 26, 40]);
};
const baseImportExtra = importExtra;
importExtra = function (J, g, out, h) {
  baseImportExtra(J, g, out, h);
  out.credit = J('Credit Scores').filter(r => r.Score).map(r => ({ id: uid(), date: h.dateV(r.Date), who: h.ownerKey(r.Person) === 'p2' ? 'p2' : 'p1', score: h.numV(r.Score), source: h.str(r.Source), notes: h.str(r.Notes) }));
};

/* ---------- boot ---------- */
Object.assign(window.hub, { creditPicture });
go();
