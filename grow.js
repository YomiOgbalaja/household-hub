/* Household Hub, part 4: Opportunities & investments.
   Everything here is computed live from the household's own numbers plus a dated market snapshot that the
   household can update in the app. It finds areas to cut, prices what debt and penalties cost each month, runs a
   payoff plan, suggests a budget, and shows what freed cash could grow to. It is general education and arithmetic,
   not personalised investment, tax or legal advice. Shares the global scope of the other scripts. */
'use strict';

/* ---------- market snapshot (as of 19 Nov 2026; every value can be updated in the app) ---------- */
const MARKET = {
  asOf: '2026-11-19',
  rates: {
    hysa: { v: 0.044, label: 'Top no-strings high-yield savings APY', src: 'Bankrate, Nov 2026', url: 'https://www.bankrate.com/banking/savings/best-high-yield-interests-savings-accounts/' },
    hysaAvg: { v: 0.0057, label: 'National average savings APY', src: 'Bankrate, Nov 2026', url: 'https://www.bankrate.com/banking/savings/best-high-yield-interests-savings-accounts/' },
    card: { v: 0.2119, label: 'Average credit card APR', src: 'Federal Reserve G.19, Aug 2026', url: 'https://www.lendingtree.com/credit-cards/study/average-credit-card-interest-rate-in-america/' },
    personal: { v: 0.1186, label: 'Average 24-month personal loan APR', src: 'Federal Reserve, Sep 2026', url: 'https://www.consumeraffairs.com/finance/personal-loan-interest-rates.html' },
    mortgage: { v: 0.0711, label: '30-year fixed mortgage rate', src: 'Freddie Mac PMMS, 12 Nov 2026', url: 'https://www.freddiemac.com/pmms' },
    t10: { v: 0.0515, label: '10-year Treasury yield', src: 'Trading Economics, 16 Nov 2026', url: 'https://tradingeconomics.com/united-states/government-bond-yield' },
    cpi: { v: 0.037, label: 'Inflation, CPI 12 months to Sep 2026', src: 'BLS', url: 'https://www.bls.gov/cpi/' },
    irs: { v: 0.07, label: 'IRS underpayment interest, Q4 2026', src: 'IRS IR-2026-98', url: 'https://www.irs.gov/newsroom/interest-rates-remain-the-same-for-the-fourth-quarter-of-2026' },
    ftp: { v: 0.005, label: 'IRS failure-to-pay penalty a month (0.25% on a payment plan)', src: 'IRS', url: 'https://www.irs.gov/payments/failure-to-pay-penalty' },
  },
  limits: { k401: 25500, ira: 7500, hsaSelf: 4500, hsaFamily: 9000, dcfsa: 7500, src: 'IRS Notice 2026-66 and Rev. Proc. 2026-24', url: 'https://www.plansponsor.com/irs-raises-401k-contribution-limit-to-25500-ira-limit-to-7500/' },
  bls: { total: 81905, housing: 0.339, transport: 0.165, src: 'BLS Consumer Expenditures, 2025', url: 'https://www.bls.gov/news.release/cesan.htm' },
};
const R = k => { const o = (state.market || {})[k]; return o != null && o !== '' ? num(o) : MARKET.rates[k].v; };
const marketAsOf = () => (state.market && state.market.asOf) || MARKET.asOf;
const taxRate = () => S().taxRate != null && S().taxRate !== '' ? num(S().taxRate) : 0.30;
const NEEDS = ['Housing', 'Utilities', 'Schools & childcare', 'Insurance', 'Cars & transport', 'Taxes', 'Groceries', 'Medical', 'Repairs & maintenance', 'Car costs', 'Kids & school extras', 'Fees & fines'];
const pctx = (v, d = 1) => `${(num(v) * 100).toFixed(d).replace(/\.0$/, '')}%`;

/* ---------- the household picture, computed live ---------- */
function picture() {
  const t = totals(), cm = thisMonth();
  const live = a => a.filter(x => !x.pending);
  const cat = {};
  for (const b of live(state.bills)) { const v = billMonthly(b); if (v) cat[b.category || 'Other'] = (cat[b.category || 'Other'] || 0) + v; }
  const recentMisc = state.misc.filter(x => miscStatus(x) === 'Counted' && x.date && monthDiff(ym(x.date), cm) <= 2 && monthDiff(ym(x.date), cm) >= 0);
  const miscMonths = Math.max(1, new Set(recentMisc.map(x => ym(x.date))).size);
  for (const x of recentMisc) cat[x.category || 'Other'] = (cat[x.category || 'Other'] || 0) + num(x.amount) / miscMonths;
  const cashOut = state.cash.filter(c => c.dir === 'Out' && ym(c.date) === latestCashMonth());
  const disc = cashOut.filter(c => c.cls === 'Discretionary').reduce((s, c) => s + num(c.amount), 0);
  if (disc) cat['Everyday spending'] = (cat['Everyday spending'] || 0) + disc;
  const debtMo = t.debtMo;
  const spend = Object.values(cat).reduce((s, v) => s + v, 0) + debtMo;
  const needs = Object.entries(cat).filter(([k]) => NEEDS.includes(k)).reduce((s, [, v]) => s + v, 0) + debtMo;
  const wants = spend - needs;
  const cash = state.accounts.reduce((s, a) => s + num(a.balance), 0);
  const debts = live(state.debts).filter(d => d.include === 'Yes' && d.status !== 'Paid off');
  const interestMo = debts.reduce((s, d) => s + debtBalance(d) * num(d.apr) / 12, 0);
  const irsMo = debts.filter(d => d.type === 'Tax' && /irs/i.test(d.name)).reduce((s, d) => s + debtBalance(d) * (R('irs') / 12 + R('ftp') / (/plan|installment/i.test(`${d.status} ${d.terms || ''}`) && d.status !== 'On hold' ? 2 : 1)), 0);
  return { t, cat, debtMo, spend, needs, wants, income: t.income, gap: t.income - spend, cash, debt: t.debt, interestMo, irsMo, debts, disc };
}
function latestCashMonth() { return state.cash.map(c => ym(c.date)).filter(Boolean).sort().pop() || thisMonth(); }

/* ---------- opportunities: rules over the live data ---------- */
function opportunities() {
  const P = picture(), out = [], add = o => out.push(Object.assign({ kind: 'cut', monthly: 0, frees: 0, oneTime: 0, links: [] }, o));
  const live = a => a.filter(x => !x.pending);
  // 1. spending above income
  if (P.income > 0 && P.gap < -1) add({ id: 'gap', kind: 'fix', title: `Spending runs ${money(-P.gap)} a month above income`, detail: `Monthly bills, debt payments and everyday spending come to ${money(P.spend)} against ${money(P.income)} of income${P.t.incomeFromCash ? ' logged this month' : ''}. Every cut below closes this gap first; until it is closed, new debt fills it.`, impact: 'Top priority' });
  if (!P.income) add({ id: 'income', kind: 'fix', title: 'Add take-home pay to unlock the budget', detail: 'Enter each person\'s monthly take-home in Settings, or log income in Cash flow. The budget, savings rate and the gap all need it.', impact: 'Data', go: 'settings' });
  // 2. IRS balances: interest plus failure-to-pay penalty, and what a payment plan saves
  for (const d of live(state.debts).filter(d => d.type === 'Tax' && /irs/i.test(d.name) && debtBalance(d) > 0 && d.include !== 'No')) {
    const bal = debtBalance(d), now = bal * (R('irs') / 12 + R('ftp')), plan = bal * (R('irs') / 12 + R('ftp') / 2);
    const onPlan = /plan|installment/i.test(`${d.status} ${d.terms || ''}`) && d.status !== 'On hold';
    add({ id: `irs:${d.id}`, kind: 'debt', title: onPlan ? `${d.name}: keep the payment plan current` : `${d.name}: set up an IRS payment plan`, monthly: onPlan ? 0 : now - plan,
      detail: `${money(bal)} owed. At ${pctx(R('irs'))} interest plus the ${pctx(R('ftp'), 2)} a month failure-to-pay penalty it grows by about ${money(now)} a month. ${onPlan ? 'On a plan the penalty is halved.' : `An installment agreement halves the penalty to ${pctx(R('ftp') / 2, 2)} a month, about ${money(now - plan)} a month less, and stops most collection action while you keep to it.`}`,
      impact: money(now) + '/mo cost', links: [['IRS payment plans', 'https://www.irs.gov/payments/payment-plans-installment-agreements']] });
  }
  // 3. high-interest debt: what it costs, and what a lower rate would save
  const hi = live(state.debts).filter(d => d.include === 'Yes' && num(d.apr) >= 0.10 && debtBalance(d) > 0).sort((a, b) => num(b.apr) - num(a.apr));
  for (const d of hi) {
    const bal = debtBalance(d), cost = bal * num(d.apr) / 12, save = bal * Math.max(0, num(d.apr) - R('personal')) / 12;
    add({ id: `apr:${d.id}`, kind: 'debt', title: `${d.name} at ${pctx(d.apr)}: costs ${money(cost)} a month in interest`, monthly: num(d.apr) > R('personal') + 0.05 && bal >= 1000 ? save : 0,
      detail: `${num(d.payment) && num(d.payment) <= cost ? `The ${money(d.payment)} payment is below the interest, so the balance grows every month. ` : ''}Put any extra here first: it is the highest rate you pay${hi.length > 1 ? ` after ${hi.indexOf(d) ? hi.slice(0, hi.indexOf(d)).map(x => x.name).join(', ') : 'nothing'}` : ''}. ${num(d.apr) > R('personal') + 0.05 ? `At the ${pctx(R('personal'))} average personal-loan rate the same balance would cost about ${money(cost - save)} a month, if your credit qualifies. Also ask ${d.institution || 'the issuer'} for a lower rate or a hardship plan.` : 'Ask the issuer whether a lower rate or a 0% balance transfer is available.'}`,
      impact: money(cost) + '/mo interest' });
  }
  // 4. collections and settlement offers
  const coll = live(state.debts).filter(d => d.include === 'Yes' && ['In collections', 'Settlement offer'].includes(d.status) && debtBalance(d) > 0);
  if (coll.length) {
    const offers = coll.filter(d => d.status === 'Settlement offer'), bal = coll.reduce((s, d) => s + debtBalance(d), 0);
    add({ id: 'collections', kind: 'debt', title: `${coll.length} accounts in collections or with settlement offers: ${money(bal)}`, impact: offers.length ? `${offers.length} offer${offers.length > 1 ? 's' : ''} open` : 'Negotiate',
      detail: `${offers.length ? `Offers are open on ${offers.map(d => d.name).join(', ')}. ` : ''}Ask each collector for a lump-sum settlement or a hardship plan, get it in writing before you pay, and log the agreed amount on the debt. Check whether any account is past your state's time limit before paying. Settled amounts above $600 can count as taxable income.`,
      links: [['CFPB: dealing with debt collectors', 'https://www.consumerfinance.gov/consumer-tools/debt-collection/']] });
  }
  // 5. past-due bills
  const late = live(state.bills).filter(b => num(b.pastDue) > 0).sort((a, b) => num(b.pastDue) - num(a.pastDue));
  if (late.length) add({ id: 'pastdue', kind: 'fix', title: `${money(late.reduce((s, b) => s + num(b.pastDue), 0))} past due on ${late.length} bill${late.length > 1 ? 's' : ''}`, impact: 'Stop late fees',
    detail: `${late.slice(0, 4).map(b => `${b.name} ${money(b.pastDue)}`).join(', ')}${late.length > 4 ? ' and more' : ''}. Call each one for a payment arrangement before the next cycle: utilities and carriers usually spread arrears over several months, which stops late fees and shut-off notices.` });
  // 6. vehicles
  const cars = live(state.bills).filter(b => b.category === 'Cars & transport' && (FREQ[b.freq] ?? 1) === 1 && num(b.amount) >= 300).sort((a, b) => num(a.amount) - num(b.amount));
  const transport = (P.cat['Cars & transport'] || 0) + (P.cat['Car costs'] || 0);
  if (cars.length >= 2 || (P.spend && transport / P.spend > MARKET.bls.transport * 1.25)) {
    add({ id: 'vehicles', title: cars.length >= 2 ? `${cars.length} vehicle payments: ${money(cars.reduce((s, b) => s + num(b.amount), 0))} a month` : `Transport is ${pctx(transport / (P.spend || 1), 0)} of spending (US average ${pctx(MARKET.bls.transport, 0)})`, monthly: cars.length >= 2 ? num(cars[0].amount) : 0, impact: cars.length >= 2 ? 'Biggest single cut' : 'Review',
      detail: `${cars.map(b => `${b.name} ${money(b.amount)}`).join(' and ')} a month; transport is ${pctx(transport / (P.spend || 1), 0)} of your spending against a US average of ${pctx(MARKET.bls.transport, 0)}${cars.length >= 2 ? `. Selling or trading down one vehicle frees about ${money(cars[0].amount)} a month plus its insurance and registration. If you keep both, ask each lender about refinancing at today's rates.` : '.'}`,
      links: [['BLS consumer spending', MARKET.bls.url]] });
  }
  // 7. insurance
  const carIns = live(state.bills).filter(b => b.category === 'Insurance' && /car|auto/i.test(b.name)), homeIns = live(state.bills).filter(b => b.category === 'Insurance' && /home|renter/i.test(b.name));
  if (carIns.length) add({ id: 'insurance', title: `Re-shop ${carIns.length > 1 ? `${carIns.length} car policies` : 'car insurance'}${homeIns.length ? ' and bundle with home' : ''}`, impact: 'Quote check',
    detail: `Car cover costs ${money(carIns.reduce((s, b) => s + billMonthly(b), 0))} a month${carIns.length > 1 ? ' across separate policies' : ''}. Get two or three quotes for the same cover, ask about multi-car and home bundles, and raise deductibles only as far as your emergency fund covers.` });
  const life = live(state.bills).filter(b => /\biul\b|whole life|universal life/i.test(b.name));
  if (life.length) add({ id: 'cashvalue', title: `Review ${life.length} cash-value life polic${life.length > 1 ? 'ies' : 'y'}: ${money(life.reduce((s, b) => s + billMonthly(b), 0))} a month`, impact: 'Ask a fee-only adviser',
    detail: `${life.map(b => b.name).join(', ')}. Ask each insurer for the current cash value, surrender charges and the cost of insurance inside the policy, then compare with a term quote for the same death benefit. Do not cancel anything before replacement cover is in force.` });
  // 8. childcare: dependent care FSA
  const care = P.cat['Schools & childcare'] || 0;
  if (care * 12 >= MARKET.limits.dcfsa) add({ id: 'dcfsa', kind: 'grow', title: 'Pay childcare through a dependent care FSA', monthly: MARKET.limits.dcfsa * taxRate() / 12, impact: `${money(MARKET.limits.dcfsa * taxRate())}/yr est.`,
    detail: `Childcare and school costs run ${money(care)} a month. If either employer offers a dependent care FSA, up to ${money(MARKET.limits.dcfsa)} a household can come out pre-tax, worth about ${money(MARKET.limits.dcfsa * taxRate())} a year at an assumed ${pctx(taxRate(), 0)} combined tax rate (change it below). Enrol at open enrolment or after a qualifying event.` });
  // 9. unclear or placeholder items
  const unclear = live(state.bills).filter(b => b.amount && (b.status === 'Confirm' || /unlabel|unknown|misc item/i.test(b.name)) && (FREQ[b.freq] ?? 1) === 1);
  if (unclear.length) add({ id: 'unclear', title: `Identify or cancel ${unclear.length} unclear charge${unclear.length > 1 ? 's' : ''}`, monthly: unclear.filter(b => /unlabel|unknown/i.test(b.name)).reduce((s, b) => s + billMonthly(b), 0), impact: 'Quick win',
    detail: `${unclear.map(b => `${b.name} (${money(b.amount)})`).join(', ')}. Match each to a statement line. Anything nobody recognises is usually a forgotten subscription.` });
  // 10. everyday spending
  if (P.disc > 0) add({ id: 'everyday', title: `Trim everyday spending by 15%`, monthly: P.disc * 0.15, impact: 'Habit',
    detail: `${money(P.disc)} of discretionary spending was logged in ${monthName(latestCashMonth(), true)}. A 15% trim is about ${money(P.disc * 0.15)} a month. Give each of you a fixed personal allowance and log the rest as misc costs so the pattern shows.` });
  // 11. BNPL roll-down: plans ending soon free cash
  const bnpl = live(state.debts).filter(d => d.type === 'BNPL' && num(d.payment) > 0 && debtBalance(d) > 0).map(d => ({ d, n: Math.ceil(debtBalance(d) / num(d.payment)) })).filter(x => x.n <= 6);
  if (bnpl.length) add({ id: 'bnpl', kind: 'grow', title: `${bnpl.length} pay-later plan${bnpl.length > 1 ? 's end' : ' ends'} within 6 months`, frees: bnpl.reduce((s, x) => s + num(x.d.payment), 0), impact: `Frees ${money(bnpl.reduce((s, x) => s + num(x.d.payment), 0))}/mo`,
    detail: `${bnpl.map(x => `${x.d.name} ends about ${monthName(addMonths(thisMonth(), x.n), true)} (${money(x.d.payment)})`).join('; ')}. Roll each freed payment straight into the next debt instead of spending it, and start no new pay-later plans.` });
  // 12. idle cash
  if (P.cash >= 1000) add({ id: 'idle', kind: 'grow', title: `Move savings to a ${pctx(R('hysa'), 2)} high-yield account`, monthly: Math.max(0, P.cash - P.spend / 4) * (R('hysa') - R('hysaAvg')) / 12, impact: 'Easy',
    detail: `${money(P.cash)} sits in your accounts. The national average pays ${pctx(R('hysaAvg'), 2)}; top no-strings FDIC-insured accounts pay about ${pctx(R('hysa'), 2)}. Keep a week of bills in checking and move the rest.`, links: [['Rates', MARKET.rates.hysa.url]] });
  // 13. missing data that hides cost
  const noApr = live(state.debts).filter(d => d.include === 'Yes' && (d.apr == null || d.apr === '') && ['Credit card', 'Other loan', 'Student loan'].includes(d.type) && debtBalance(d) > 0 && !['In collections', 'Settlement offer'].includes(d.status));
  if (noApr.length) add({ id: 'apr-missing', kind: 'fix', title: `Add the interest rate to ${noApr.length} debt${noApr.length > 1 ? 's' : ''}`, impact: 'Data', go: 'debts',
    detail: `${noApr.map(d => d.name).join(', ')}. Without a rate the payoff plan treats them as 0% and cannot rank them. It is on each statement.` });
  const noPay = live(state.debts).filter(d => d.include === 'Yes' && !num(d.payment) && debtBalance(d) > 0 && !['In collections', 'Settlement offer'].includes(d.status) && d.type !== 'Family & friends');
  if (noPay.length) add({ id: 'pay-missing', kind: 'fix', title: `Set a monthly payment on ${noPay.length} debt${noPay.length > 1 ? 's' : ''}`, impact: 'Data', go: 'debts',
    detail: `${noPay.slice(0, 6).map(d => d.name).join(', ')}${noPay.length > 6 ? ' and more' : ''} have no payment, so they never shrink in the plan. Enter at least the minimum due.` });
  const blanks = state.bills.filter(b => !num(b.amount));
  if (blanks.length) add({ id: 'blanks', kind: 'fix', title: `Remove ${blanks.length} empty bill row${blanks.length > 1 ? 's' : ''}`, impact: 'Tidy', go: 'bills', detail: `${blanks.map(b => b.name).join(', ')} ha${blanks.length > 1 ? 've' : 's'} no amount. Totals rows from the old spreadsheet are not needed here.` });
  // tracking state and order
  const O = state.opps || {};
  const rank = { fix: 0, debt: 1, cut: 2, grow: 3 };
  for (const o of out) o.status = (O[o.id] && O[o.id].status) || 'open';
  return out.sort((a, b) => (a.status === 'dismissed') - (b.status === 'dismissed') || (b.monthly - a.monthly) || rank[a.kind] - rank[b.kind]);
}

/* ---------- debt payoff simulation ---------- */
function payoffDebts() { return state.debts.filter(d => !d.pending && d.include === 'Yes' && d.status !== 'Paid off' && num(d.payment) > 0 && debtBalance(d) > 0); }
function simulate(extra, strategy, rollover = true) {
  const ds = payoffDebts().map(d => ({ id: d.id, name: d.name, bal: debtBalance(d), apr: num(d.apr), min: num(d.payment), done: 0 }));
  const series = [ds.reduce((s, d) => s + d.bal, 0)], freedBy = [], cum = [0];
  const underwater = ds.filter(d => d.apr && d.min <= d.bal * d.apr / 12 + 0.01).map(d => d.name);
  let interest = 0, m = 0;
  while (ds.some(d => d.bal > 0.005) && m < 480) {
    m++;
    let pool = extra, freed = 0;
    for (const d of ds) if (d.bal > 0.005) { const i = d.bal * d.apr / 12; d.bal += i; interest += i; }
    for (const d of ds) {
      if (d.bal > 0.005) { const p = Math.min(d.min, d.bal); d.bal -= p; if (d.bal <= 0.005 && !d.done) d.done = m; }
      else { freed += d.min; if (rollover) pool += d.min; }
    }
    const order = ds.filter(d => d.bal > 0.005).sort(strategy === 'snowball' ? (a, b) => a.bal - b.bal : (a, b) => b.apr - a.apr || a.bal - b.bal);
    for (const d of order) { if (pool <= 0) break; const p = Math.min(pool, d.bal); d.bal -= p; pool -= p; if (d.bal <= 0.005 && !d.done) d.done = m; }
    series.push(ds.reduce((s, d) => s + Math.max(0, d.bal), 0)); freedBy.push(freed); cum.push(interest);
  }
  return { months: ds.every(d => d.bal <= 0.005) ? m : null, interest, cum, underwater, series, freedBy, order: ds.slice().sort((a, b) => (a.done || 9999) - (b.done || 9999)) };
}

/* ---------- small charts ---------- */
function lineChart(lines, opts = {}) {
  const W = 560, H = opts.h || 180, pl = 44, pb = 22, pt = 8, n = Math.max(...lines.map(l => l.pts.length));
  const max = Math.max(1, ...lines.flatMap(l => l.pts));
  const x = i => pl + (i / Math.max(1, n - 1)) * (W - pl - 8), y = v => pt + (1 - v / max) * (H - pb - pt);
  const ticks = [0, 0.5, 1].map(f => `<text x="${pl - 6}" y="${y(max * f) + 4}" text-anchor="end">${money(max * f >= 1e6 ? Math.round(max * f / 1e5) * 1e5 : max * f)}</text><line x1="${pl}" x2="${W - 8}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="#e5e9ec"/>`).join('');
  const xl = (opts.labels || []).map(([i, t]) => `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(t)}</text>`).join('');
  const paths = lines.map(l => `<path d="${l.pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}" fill="none" stroke="${l.color}" stroke-width="2.5" ${l.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'Chart')}">${ticks}${paths}${xl}</svg>
    <div class="legend">${lines.map(l => `<span><span class="sw" style="background:${l.color}"></span>${esc(l.name)}</span>`).join('')}</div>`;
}
function fv(monthly, rate, years, start = 0) { const r = rate / 12, n = years * 12; return r ? start * Math.pow(1 + r, n) + monthly * ((Math.pow(1 + r, n) - 1) / r) : start + monthly * n; }

/* ---------- net worth snapshots: one per month, kept automatically ---------- */
function snapshot() {
  state.snapshots = Array.isArray(state.snapshots) ? state.snapshots : [];
  const m = thisMonth(), P = picture(), rec = { m, cash: Math.round(P.cash), debt: Math.round(P.debt), at: new Date().toISOString() };
  const i = state.snapshots.findIndex(s => s.m === m);
  if (i < 0) state.snapshots.push(rec); else if (state.snapshots[i].cash !== rec.cash || state.snapshots[i].debt !== rec.debt) state.snapshots[i] = rec; else return false;
  state.snapshots.sort((a, b) => a.m.localeCompare(b.m)); return true;
}

/* ---------- the section ---------- */
ui.growExtra = ui.growExtra ?? 250; ui.growStrat = ui.growStrat || 'avalanche'; ui.growTab = ui.growTab || 'open';
VIEWS.grow = () => {
  if (!state.bills.length && !state.debts.length) return header('Opportunities & investments', '') + emptyStart();
  if (snapshot()) save();
  const P = picture(), opps = opportunities(), O = state.opps || {};
  const active = opps.filter(o => o.status !== 'dismissed'), found = active.filter(o => o.status !== 'done').reduce((s, o) => s + o.monthly, 0);
  const captured = opps.filter(o => o.status === 'done').reduce((s, o) => s + o.monthly, 0);
  const shown = opps.filter(o => ui.growTab === 'open' ? !['done', 'dismissed'].includes(o.status) : ui.growTab === o.status);
  const sim = simulate(ui.growExtra, ui.growStrat), base = simulate(0, ui.growStrat, false);
  const horizon = sim.months || 120, baseInt = base.cum[Math.min(horizon, base.cum.length - 1)], planInt = sim.cum[Math.min(horizon, sim.cum.length - 1)];
  const pd = payoffDebts(), left = P.debts.filter(d => !num(d.payment) && debtBalance(d) > 0);
  const ef = P.spend * 3, efPct = ef ? Math.min(1, P.cash / ef) : 0;
  const invest = found + captured;
  const years = [5, 10, 20], scen = [[`Savings at ${pctx(R('hysa'), 1)}`, R('hysa'), '#9db6c8'], ['Balanced at 5%', 0.05, '#5f9ea0'], ['Growth at 7%', 0.07, '#2f6f73']];
  const kindCls = { fix: 's-bad', debt: 's-warn', cut: 's-acc', grow: 's-good' }, kindTxt = { fix: 'Fix first', debt: 'Debt', cut: 'Cut', grow: 'Grow' };
  const oppLi = o => `<li class="opp"><div class="main"><div class="row" style="gap:6px;margin-bottom:2px"><span class="pill ${kindCls[o.kind]}">${kindTxt[o.kind]}</span>${o.status === 'doing' ? '<span class="pill s-due">In progress</span>' : ''}</div>
      <div class="title">${esc(o.title)}</div><div class="sub" style="white-space:normal">${esc(o.detail)}</div>
      <div class="row" style="margin-top:8px;gap:6px">${o.status !== 'doing' && o.status !== 'done' ? `<button class="btn sm" data-action="opp" data-id="${esc(o.id)}" data-v="doing">Start</button>` : ''}${o.status !== 'done' ? `<button class="btn sm" data-action="opp" data-id="${esc(o.id)}" data-v="done">Done</button>` : `<button class="btn sm ghost" data-action="opp" data-id="${esc(o.id)}" data-v="open">Reopen</button>`}
        <button class="btn sm ghost" data-action="opp-action" data-id="${esc(o.id)}">Make it an action</button>${o.status !== 'dismissed' ? `<button class="btn sm ghost" data-action="opp" data-id="${esc(o.id)}" data-v="dismissed">Not for us</button>` : ''}
        ${o.go ? `<a class="btn sm ghost" href="#/${o.go}">Open</a>` : ''}${o.links.map(([t, u]) => `<a class="btn sm ghost" href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>`).join('')}</div></div>
      <div class="end">${o.monthly > 0.5 ? `<div class="amt" style="color:var(--good)">${money(o.monthly)}<span class="small muted">/mo</span></div>` : o.frees ? `<div class="amt">${money(o.frees)}<span class="small muted">/mo</span></div>` : ''}<div class="small muted" style="text-align:right">${esc(o.impact || '')}</div></div></li>`;
  // budget
  const inc = P.income, b50 = inc * 0.5, b30 = inc * 0.3, b20 = inc * 0.2, savingNow = Math.max(0, inc - P.spend);
  const bud = [['Needs', P.needs, b50, 'Housing, utilities, childcare, insurance, cars, taxes, groceries, debt minimums'], ['Wants', P.wants, b30, 'Everything else'], ['Saving and extra debt payments', savingNow, b20, 'What is left after spending']];
  const cats = Object.entries(P.cat).sort((a, b) => b[1] - a[1]), maxCat = Math.max(1, ...cats.map(c => c[1]));
  const cuts = {}; for (const o of active) if (o.monthly > 0 && o.kind === 'cut') { const c = o.id === 'vehicles' ? 'Cars & transport' : o.id === 'everyday' ? 'Everyday spending' : o.id === 'unclear' ? 'Other' : null; if (c) cuts[c] = (cuts[c] || 0) + o.monthly; }
  // net worth
  const snaps = state.snapshots || [];
  const ladder = [
    ['Keep housing, utilities, taxes and insurance current', !state.bills.some(b => !b.pending && num(b.pastDue) > 0 && ['Housing', 'Utilities', 'Insurance', 'Taxes'].includes(b.category))],
    ['Starter emergency fund of $2,000', P.cash >= 2000],
    ['Take any employer 401(k) match in full', null],
    ['Clear debt above 10% interest', !P.debts.some(d => num(d.apr) >= 0.10 && debtBalance(d) > 0)],
    [`Emergency fund of 3 months of spending (${money(ef)})`, P.cash >= ef],
    [`Retirement: up to ${money(MARKET.limits.k401)} each in a 401(k) and ${money(MARKET.limits.ira)} each in an IRA for 2027`, null],
    ['Other goals: home, education, taxable investing', null]];
  const firstOpen = ladder.findIndex(l => l[1] === false);
  return header('Opportunities & investments', `Built from your own numbers and market rates as of ${dateLong(marketAsOf())}. Updates as you log payments, costs and statements.`, `<button class="btn" data-action="market">Update rates</button>`) +
    `<div class="grid g4" style="margin-bottom:12px">
      ${kpi('Savings found', money(found), `${active.filter(o => o.monthly > 0.5 && o.status !== 'done').length} opportunities a month`, 't-good')}
      ${kpi('Captured so far', money(captured), 'Marked done', captured ? 't-good' : '')}
      ${kpi('Interest and penalties', money(P.interestMo + P.irsMo), 'A month: card rates plus IRS interest and penalty', 't-bad')}
      ${kpi(P.income ? 'Monthly gap' : 'Monthly spending', P.income ? money(P.gap) : money(P.spend), P.income ? `Income ${money(P.income)} − spending ${money(P.spend)}` : 'Add income in Settings', P.income && P.gap < 0 ? 't-bad' : 't-good')}</div>
    <div class="cols"><div>
      <div class="card"><div class="spread"><h2>Opportunities</h2><div class="chips">${[['open', 'To do'], ['done', 'Done'], ['dismissed', 'Not for us']].map(([k, v]) => `<button class="chip ${ui.growTab === k ? 'on' : ''}" data-action="grow-tab" data-v="${k}">${v} (${opps.filter(o => k === 'open' ? !['done', 'dismissed'].includes(o.status) : o.status === k).length})</button>`).join('')}</div></div>
        <ul class="list">${shown.map(oppLi).join('') || '<li class="muted">Nothing here.</li>'}</ul></div>
      <div class="card"><div class="spread"><h2>Debt payoff plan</h2><div class="chips">${[['avalanche', 'Highest rate first'], ['snowball', 'Smallest balance first']].map(([k, v]) => `<button class="chip ${ui.growStrat === k ? 'on' : ''}" data-action="grow-strat" data-v="${k}">${v}</button>`).join('')}</div></div>
        <div class="field" style="margin:6px 0 10px"><label for="extra">Extra each month on top of the minimums: <b id="extra-v">${money(ui.growExtra)}</b></label><input id="extra" type="range" min="0" max="3000" step="50" value="${ui.growExtra}" data-input="growExtra" style="width:100%"></div>
        <div class="grid g4" style="margin-bottom:10px">${kpi('Debt-free in', sim.months ? `${sim.months} mo` : '40+ yrs', sim.months ? monthName(addMonths(thisMonth(), sim.months), true) : 'Raise the extra', 't-good')}${kpi('Interest paid', money(planInt), sim.months ? 'Until debt-free' : 'Over 10 years', '')}
          ${kpi('Interest saved', money(Math.max(0, baseInt - planInt)), `Versus minimums only, over ${horizon} mo`, 't-good')}${kpi('Minimums only', base.months ? `${base.months} mo` : 'Never', base.months ? 'To debt-free' : `${base.underwater.length} payment${base.underwater.length === 1 ? ' is' : 's are'} below interest`, base.months ? '' : 't-bad')}</div>
        ${base.underwater.length ? `<div class="notice warn" style="margin-bottom:10px"><div class="small">${esc(base.underwater.join(', '))}: the monthly payment is less than the interest charged, so the balance grows. Raise the payment or the plan above, or ask for a lower rate.</div></div>` : ''}
        ${lineChart([{ name: 'Minimums only', pts: base.series.slice(0, 121), color: '#c9d6e3', dash: 1 }, { name: 'This plan', pts: sim.series.slice(0, 121), color: '#2f6f73' }], { label: 'Debt balance over time', labels: [[0, 'Now'], [Math.min(60, Math.max(base.series.length, sim.series.length) - 1), Math.min(60, Math.max(base.series.length, sim.series.length) - 1) + ' mo'], [Math.min(120, Math.max(base.series.length, sim.series.length) - 1), Math.min(120, Math.max(base.series.length, sim.series.length) - 1) + ' mo']] })}
        <p class="small muted">Covers ${pd.length} debts with a monthly payment (${money(pd.reduce((s, d) => s + debtBalance(d), 0))}). Each paid-off payment rolls into the next. ${left.length ? `${left.length} debts with no payment set (${money(left.reduce((s, d) => s + debtBalance(d), 0))}, mostly collections and taxes) are not in the plan until you agree a payment.` : ''}</p>
        <ol class="small" style="margin:6px 0 0;padding-left:20px">${sim.order.slice(0, 8).map(d => `<li>${esc(d.name)}${d.done ? ` · paid off ${monthName(addMonths(thisMonth(), d.done), true)}` : ''}${d.apr ? ` · ${pctx(d.apr)}` : ''}</li>`).join('')}</ol></div>
      <div class="card"><h2>What the savings could grow to</h2><p class="small muted" style="margin-top:0">If the ${money(invest)} a month found here is saved or invested instead of spent. Illustrative rates, not a forecast; values are before tax and in future dollars.</p>
        <div class="tablewrap"><table><thead><tr><th>Rate</th>${years.map(y => `<th>${y} years</th>`).join('')}</tr></thead><tbody>${scen.map(([n, r]) => `<tr><td>${esc(n)}</td>${years.map(y => `<td>${money(fv(invest, r, y))}</td>`).join('')}</tr>`).join('')}
          <tr class="total"><td>Put in</td>${years.map(y => `<td>${money(invest * 12 * y)}</td>`).join('')}</tr></tbody></table></div>
        ${lineChart(scen.map(([n, r, c]) => ({ name: n, color: c, pts: Array.from({ length: 21 }, (_, y) => fv(invest, r, y)) })), { label: 'Growth of monthly savings', labels: [[0, 'Now'], [10, '10 yrs'], [20, '20 yrs']] })}
        <p class="small muted">At ${pctx(R('cpi'))} inflation, ${money(fv(invest, 0.07, 20))} in 20 years is worth about ${money(fv(invest, 0.07, 20) / Math.pow(1 + R('cpi'), 20))} in today's money.</p></div>
    </div><div>
      <div class="card"><h2>Suggested budget</h2>${inc ? `<p class="small muted" style="margin-top:0">The 50/30/20 guide against your ${money(inc)} monthly income.</p>
        ${bud.map(([n, v, tg, h]) => `<div style="margin:10px 0"><div class="spread small"><b>${n}</b><span class="num">${money(v)} <span class="muted">of ${money(tg)} guide</span></span></div><div class="bar" style="margin-top:4px"><i style="width:${Math.min(100, v / (tg || 1) * 100)}%;background:${n === 'Saving and extra debt payments' ? (v >= tg ? 'var(--good)' : 'var(--warn)') : (v > tg ? 'var(--bad)' : 'var(--good)')}"></i></div><div class="tiny muted">${pct(v / inc)} of income · ${h}</div></div>`).join('')}` : '<p class="muted">Add take-home pay in Settings to compare against the 50/30/20 guide.</p>'}
        <h3 style="margin:14px 0 6px;font-size:14px">Where the money goes each month</h3><ul class="list">${cats.map(([c, v]) => `<li><div class="main"><div class="spread"><span class="title">${esc(c)}</span><span class="amt">${money(v)}${cuts[c] ? ` <span class="small" style="color:var(--good)">→ ${money(v - cuts[c])}</span>` : ''}</span></div><div class="bar" style="margin-top:6px"><i style="width:${v / maxCat * 100}%;background:${cuts[c] ? 'var(--warn)' : 'var(--acc)'}"></i></div>
          <div class="sub">${pct(v / (P.spend || 1))} of spending${c === 'Housing' ? ` · US average ${pctx(MARKET.bls.housing, 0)}` : c === 'Cars & transport' ? ` · US average ${pctx(MARKET.bls.transport, 0)}` : ''}</div></div></li>`).join('')}
          <li><div class="main"><div class="spread"><span class="title">Debt payments</span><span class="amt">${money(P.debtMo)}</span></div><div class="sub">${pct(P.debtMo / (P.spend || 1))} of spending${inc ? ` · with housing, ${pct((P.debtMo + (P.cat.Housing || 0)) / inc)} of income (lenders look for under 36%)` : ''}</div></div></li></ul></div>
      <div class="card"><h2>Order of operations</h2><p class="small muted" style="margin-top:0">A widely used sequence for building wealth. Ticks come from your data.</p>
        <ol class="ladder">${ladder.map(([t, ok], i) => `<li class="${ok === true ? 'ok' : i === firstOpen ? 'next' : ''}"><span class="mark">${ok === true ? '✓' : i === firstOpen ? '→' : ok === null ? '?' : ''}</span>${esc(t)}</li>`).join('')}</ol>
        <div style="margin-top:10px"><div class="spread small"><b>Emergency fund</b><span>${money(P.cash)} of ${money(ef)}</span></div><div class="bar" style="margin-top:4px"><i style="width:${efPct * 100}%;background:var(--good)"></i></div></div></div>
      <div class="card"><h2>Net worth trend</h2>${snaps.length > 1 ? lineChart([{ name: 'Cash', pts: snaps.map(s => s.cash), color: '#1e7b45' }, { name: 'Debt', pts: snaps.map(s => s.debt), color: '#b42318' }], { label: 'Cash and debt by month', labels: [[0, monthName(snaps[0].m)], [snaps.length - 1, monthName(snaps[snaps.length - 1].m)]] }) : ''}
        <div class="spread"><span class="small">Cash ${money(P.cash)} − debt ${money(P.debt)}</span><b class="num" style="color:${P.cash - P.debt < 0 ? 'var(--bad)' : 'var(--good)'}">${money(P.cash - P.debt)}</b></div>
        <p class="small muted">A snapshot is saved each month you open this page, so the trend fills in over time. Accounts and debts only; add home equity and retirement balances as accounts to include them.</p></div>
      <div class="card"><div class="spread"><h2>Market rates</h2><span class="small muted">as of ${dateShort(marketAsOf())}</span></div><ul class="list">${Object.entries(MARKET.rates).map(([k, r]) => `<li><div class="main"><div class="title small">${esc(r.label)}</div><div class="sub"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.src)}</a>${(state.market || {})[k] != null && state.market[k] !== '' ? ' · updated by you' : ''}</div></div><div class="end amt">${pctx(R(k), 2)}</div></li>`).join('')}
        <li><div class="main"><div class="title small">2027 limits: 401(k) ${money(MARKET.limits.k401)}, IRA ${money(MARKET.limits.ira)}, HSA ${money(MARKET.limits.hsaSelf)} self / ${money(MARKET.limits.hsaFamily)} family, dependent care FSA ${money(MARKET.limits.dcfsa)}</div><div class="sub"><a href="${MARKET.limits.url}" target="_blank" rel="noopener">${MARKET.limits.src}</a></div></div></li></ul>
        <p class="small muted">Assumed combined tax rate for estimates: ${pctx(taxRate(), 0)}. Change it with Update rates.</p></div>
    </div></div>
    <p class="small muted" style="margin-top:16px">General education and arithmetic from your own numbers. Household Hub is not a licensed financial, tax or legal adviser, and none of this is a recommendation to buy or sell any investment or product. Check big moves, especially insurance, tax settlements and investing, with a fee-only adviser or tax professional.</p>`;
};

/* ---------- home summary ---------- */
const baseHome3 = VIEWS.home;
VIEWS.home = () => {
  const html = baseHome3();
  if (!state.bills.length && !state.debts.length) return html;
  const opps = opportunities().filter(o => !['done', 'dismissed'].includes(o.status)), top = opps.filter(o => o.monthly > 0.5).sort((a, b) => b.monthly - a.monthly).slice(0, 3);
  const total = opps.reduce((s, o) => s + o.monthly, 0);
  const card = `<div class="card grow-strip"><div class="spread"><h2>Opportunities & investments</h2><a href="#/grow" class="small">See all ${opps.length}</a></div>
    <p class="small muted" style="margin:-2px 0 8px">${money(total)} a month found. Saved for 10 years at 5%, that is about ${money(fv(total, 0.05, 10))}.</p>
    <ul class="list">${top.map(o => `<li class="tap" data-go="grow"><div class="main"><div class="title">${esc(o.title)}</div></div><div class="end amt" style="color:var(--good)">${money(o.monthly)}/mo</div></li>`).join('')}</ul></div>`;
  const i = html.indexOf('<div class="cols" style="margin-top:16px">');
  return i < 0 ? html : html.slice(0, i) + `<div style="margin-top:16px">${card}</div>` + html.slice(i);
};

/* ---------- update rates sheet ---------- */
function openMarket() {
  const m = state.market || {};
  const row = (k, r) => `<div class="field"><label>${esc(r.label)} (%)</label><input type="number" step="any" inputmode="decimal" name="${k}" value="${m[k] != null && m[k] !== '' ? +(num(m[k]) * 100).toFixed(4) : ''}" placeholder="${+(r.v * 100).toFixed(4)}"></div>`;
  $sheet.innerHTML = `<form id="mkt"><div class="sheet-head"><h2>Update rates</h2><p class="small muted" style="margin:4px 0 0">Leave a field blank to use the snapshot value shown in grey.</p></div>
    <div class="sheet-body"><div class="fields">${Object.entries(MARKET.rates).map(([k, r]) => row(k, r)).join('')}
    <div class="field"><label>Rates as of</label><input type="date" name="asOf" value="${esc(m.asOf || '')}" placeholder="${MARKET.asOf}"></div>
    <div class="field"><label>Your combined tax rate (%)</label><input type="number" step="any" name="taxRate" value="${S().taxRate != null && S().taxRate !== '' ? Math.round(num(S().taxRate) * 100) : ''}" placeholder="30"><span class="hint">Federal plus state, for estimates only</span></div></div></div>
    <div class="sheet-foot"><button type="button" class="btn grow" data-action="market-reset">Use the snapshot</button><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary">Save</button></div></form>`;
  if (!$sheet.open) $sheet.showModal();
}
document.addEventListener('submit', e => {
  const f = e.target.closest('#mkt'); if (!f) return; e.preventDefault();
  const m = {}; for (const k of Object.keys(MARKET.rates)) { const v = f[k].value.trim(); if (v !== '') m[k] = num(v) / 100; }
  if (f.asOf.value) m.asOf = f.asOf.value;
  state.market = m; S().taxRate = f.taxRate.value.trim() === '' ? null : num(f.taxRate.value) / 100;
  logAct('Updated market rates', Object.keys(m).length + ' values'); $sheet.close(); rerender(); toast('Rates updated');
});

/* ---------- events ---------- */
document.addEventListener('input', e => {
  if (e.target.dataset.input !== 'growExtra') return;
  ui.growExtra = num(e.target.value); const v = document.getElementById('extra-v'); if (v) v.textContent = money(ui.growExtra);
  clearTimeout(e.target._t); e.target._t = setTimeout(() => { const y = window.scrollY; render(); window.scrollTo(0, y); const r = document.getElementById('extra'); if (r) r.focus(); }, 120);
});
document.addEventListener('click', e => {
  const a = e.target.closest('[data-action]'); if (!a) return;
  switch (a.dataset.action) {
    case 'grow-tab': ui.growTab = a.dataset.v; return render();
    case 'grow-strat': ui.growStrat = a.dataset.v; return render();
    case 'market': return openMarket();
    case 'market-reset': state.market = {}; $sheet.close(); rerender(); return toast('Using the snapshot rates');
    case 'opp': { state.opps = state.opps || {}; const o = opportunities().find(x => x.id === a.dataset.id); state.opps[a.dataset.id] = { status: a.dataset.v, at: new Date().toISOString() };
      logAct({ doing: 'Started an opportunity', done: 'Captured an opportunity', dismissed: 'Set aside an opportunity', open: 'Reopened an opportunity' }[a.dataset.v], o ? o.title : a.dataset.id); rerender();
      return toast(a.dataset.v === 'done' && o && o.monthly > 0.5 ? `Captured ${money(o.monthly)} a month` : 'Updated'); }
    case 'opp-action': { const o = opportunities().find(x => x.id === a.dataset.id); if (!o) return;
      if (state.actions.some(x => x.oppId === o.id && x.status !== 'Done')) { location.hash = '#/actions'; return toast('Already on the action list'); }
      state.actions.push({ id: uid(), oppId: o.id, title: o.title, detail: o.detail.replace(/<[^>]+>/g, ''), owner: 'shared', deadline: addDays(todayISO(), 14), amount: o.monthly ? Math.round(o.monthly) : null, priority: o.kind === 'fix' ? 'High' : 'Normal', status: 'Open' });
      state.opps = state.opps || {}; if (!state.opps[o.id] || state.opps[o.id].status === 'open') state.opps[o.id] = { status: 'doing', at: new Date().toISOString() };
      logAct('Added an action from an opportunity', o.title); rerender(); return toast('Added to Actions, due in 2 weeks'); }
  }
});

/* ---------- export ---------- */
const baseExportExtra = exportExtra;
exportExtra = function (add, D, $) {
  baseExportExtra(add, D, $);
  add('Opportunities', ['Opportunity', 'Type', 'Saves a month', 'Frees a month', 'Status', 'Detail'], opportunities().map(o => [o.title, o.kind, $(o.monthly || null), $(o.frees || null), o.status, o.detail.replace(/<[^>]+>/g, '')]), [50, 8, 12, 12, 11, 90]);
  add('Market Rates', ['Measure', 'Value', 'Source', 'Link'], Object.entries(MARKET.rates).map(([k, r]) => [r.label, { t: 'n', v: R(k), z: '0.00%' }, r.src, r.url]).concat([['As of', marketAsOf(), '', '']]), [52, 10, 30, 60]);
  add('Net Worth', ['Month', 'Cash', 'Debt', 'Net'], (state.snapshots || []).map(s => [s.m, $(s.cash), $(s.debt), $(s.cash - s.debt)]), [10, 14, 14, 14]);
};

Object.assign(window.hub, { opportunities, simulate, picture });
// boot happens at the end of credit.js
