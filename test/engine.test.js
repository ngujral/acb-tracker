// The 15 ACB engine test cases from the requirements doc, plus date-rule checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLedger, yearReport, checkSale, QTY } from '../public/lib/engine.js';
import { defaultSettlementDate, addDays, isBusinessDay } from '../public/lib/dates.js';

const accounts = [
  { id: 'qt', name: 'Questrade margin', type: 'NONREG' },
  { id: 'td', name: 'TD Direct cash', type: 'NONREG' },
  { id: 'tfsa', name: 'Questrade TFSA', type: 'TFSA' },
];
const securities = [{ id: 'X', ticker: 'XEQT', exchange: 'TSX' }];
const $ = (dollars) => Math.round(dollars * 100);
let seq = 0;
const tx = (type, date, fields = {}) => ({
  id: `t${++seq}`, seq, accountId: 'qt', securityId: 'X', type,
  tradeDate: date, settleDate: date, commissionCents: 0, ...fields,
});
const buy = (date, qty, price, comm = 0, acct = 'qt') => tx('BUY', date, { qty: qty * QTY, grossCents: $(qty * price), commissionCents: $(comm), accountId: acct });
const sell = (date, qty, price, comm = 0, acct = 'qt') => tx('SELL', date, { qty: qty * QTY, grossCents: $(qty * price), commissionCents: $(comm), accountId: acct });
const run = (transactions) => computeLedger({ accounts, securities, transactions });
const pool = (ledger) => ledger.groups.X;

const case1 = () => [buy('2026-01-05', 100, 10, 10)];
const case2 = () => [...case1(), buy('2026-02-02', 100, 12, 10)];
const case3 = () => [...case2(), sell('2026-03-02', 50, 15, 10)];

test('1 first buy', () => {
  const p = pool(run(case1()));
  assert.equal(p.shares, 100 * QTY);
  assert.equal(p.acbCents, $(1010));
});

test('2 second buy averages', () => {
  const p = pool(run(case2()));
  assert.equal(p.shares, 200 * QTY);
  assert.equal(p.acbCents, $(2220));
});

test('3 partial sale', () => {
  const l = run(case3());
  assert.equal(l.dispositions[0].gainCents, $(185));
  assert.equal(l.dispositions[0].acbCents, $(555));
  assert.equal(pool(l).shares, 150 * QTY);
  assert.equal(pool(l).acbCents, $(1665));
});

test('4 return of capital', () => {
  const l = run([...case3(), tx('ROC', '2026-04-01', { amountCents: $(200) })]);
  assert.equal(pool(l).acbCents, $(1465));
  assert.equal(pool(l).shares, 150 * QTY);
});

test('5 ROC below zero', () => {
  const l = run([
    tx('TRANSFER_IN', '2026-01-02', { qty: 10 * QTY, amountCents: $(100) }),
    tx('ROC', '2026-06-30', { amountCents: $(150) }),
  ]);
  assert.equal(pool(l).acbCents, 0);
  const d = l.dispositions.find((x) => x.kind === 'NEGATIVE_ACB');
  assert.equal(d.gainCents, $(50));
  assert.equal(d.year, 2026);
});

test('6 reinvested distribution', () => {
  const l = run([...case3(), tx('REINVESTED_DIST', '2026-12-31', { amountCents: $(80) })]);
  assert.equal(pool(l).acbCents, $(1745));
  assert.equal(pool(l).shares, 150 * QTY);
});

test('7 2-for-1 split', () => {
  const l = run([...case3(), tx('SPLIT', '2026-05-01', { ratioNum: 2, ratioDen: 1, accountId: null })]);
  assert.equal(pool(l).shares, 300 * QTY);
  assert.equal(pool(l).acbCents, $(1665));
});

test('8 pooling across brokers', () => {
  const l = run([buy('2026-01-05', 100, 30, 0, 'qt'), buy('2026-01-06', 100, 32, 0, 'td'), sell('2026-02-02', 50, 35, 0, 'td')]);
  assert.equal(l.dispositions[0].acbCents, $(1550));
  assert.equal(Object.keys(l.groups).length, 1);
  assert.equal(pool(l).acbCents, $(4650));
});

const hold100 = () => tx('TRANSFER_IN', '2025-06-02', { qty: 100 * QTY, amountCents: $(2000) });

test('9 full superficial loss', () => {
  const l = run([hold100(), sell('2026-01-10', 100, 15), buy('2026-01-20', 100, 15.5)]);
  const d = l.dispositions[0];
  assert.equal(d.gainBeforeCents, -$(500));
  assert.equal(d.deniedCents, $(500));
  assert.equal(d.gainCents, 0);
  assert.equal(pool(l).acbCents, $(2050));
  assert.equal(pool(l).shares, 100 * QTY);
});

test('10 partial superficial loss', () => {
  const l = run([hold100(), sell('2026-01-10', 100, 15), buy('2026-01-20', 40, 15)]);
  const d = l.dispositions[0];
  assert.equal(d.deniedCents, $(200));
  assert.equal(d.gainCents, -$(300));
  assert.equal(pool(l).shares, 40 * QTY);
  assert.equal(pool(l).acbCents, $(800));
});

test('11 re-buy in TFSA loses the loss', () => {
  const l = run([hold100(), sell('2026-01-10', 100, 15), buy('2026-01-20', 100, 15.5, 0, 'tfsa')]);
  const d = l.dispositions[0];
  assert.equal(d.deniedCents, $(500));
  assert.equal(d.lostCents, $(500));
  assert.equal(d.gainCents, 0);
  assert.equal(pool(l).acbCents, 0);
  assert.equal(pool(l).shares, 0);
  assert.ok(l.warnings.some((w) => /permanently lost/.test(w.message)));
});

test('12 re-buy after the window', () => {
  const l = run([hold100(), sell('2026-01-10', 100, 15), buy(addDays('2026-01-10', 31), 100, 15.5)]);
  const d = l.dispositions[0];
  assert.equal(d.deniedCents, 0);
  assert.equal(d.gainCents, -$(500));
  // day 30 is still inside the window
  const l2 = run([hold100(), sell('2026-01-10', 100, 15), buy(addDays('2026-01-10', 30), 100, 15.5)]);
  assert.equal(l2.dispositions[0].deniedCents, $(500));
});

test('13 year-end settlement', () => {
  assert.equal(defaultSettlementDate('2026-12-31'), '2027-01-04');
  const t = sell('2026-12-31', 10, 25);
  t.settleDate = defaultSettlementDate(t.tradeDate);
  const l = run([buy('2026-06-01', 10, 20), t]);
  assert.equal(l.dispositions[0].year, 2027);
  assert.equal(yearReport(l, 2026).rows.length, 0);
  assert.equal(yearReport(l, 2027).totals.netGainCents, $(50));
});

test('14 oversell is an error', () => {
  const l = run([hold100(), sell('2026-03-02', 150, 20)]);
  assert.equal(l.errors.length, 1);
  assert.match(l.errors[0].message, /holds 100/);
});

test('15 editing an earlier trade recalculates', () => {
  const txs = case3();
  txs[0] = { ...txs[0], grossCents: $(1100) };
  const l = run(txs);
  assert.equal(l.dispositions[0].gainCents, $(160));
});

test('year report totals and inclusion rate', () => {
  const r = yearReport(run(case3()), 2026, 0.5);
  assert.equal(r.totals.proceedsCents, $(750));
  assert.equal(r.totals.outlaysCents, $(10));
  assert.equal(r.totals.acbCents, $(555));
  assert.equal(r.totals.netGainCents, $(185));
  assert.equal(r.totals.taxableCents, $(92.5));
});

test('sale check warns about a recent buy', () => {
  const data = { accounts, securities, transactions: [hold100(), buy('2026-03-01', 10, 14)] };
  const r = checkSale(data, { accountId: 'qt', securityId: 'X', qty: 100 * QTY, grossCents: $(1500), tradeDate: '2026-03-10', settleDate: '2026-03-11' });
  assert.equal(r.recentBuys.length, 1);
  assert.ok(r.disposition.deniedCents > 0);
  assert.equal(r.safeRebuyAfter, '2026-04-10');
});

test('market holidays', () => {
  assert.equal(isBusinessDay('2026-04-03'), false); // Good Friday 2026
  assert.equal(isBusinessDay('2026-07-01'), false);
  assert.equal(isBusinessDay('2026-08-03'), false); // Civic Holiday
  assert.equal(defaultSettlementDate('2024-05-24'), '2024-05-28'); // T+2 before the switch
  assert.equal(defaultSettlementDate('2026-11-26'), '2026-11-27');
});

test('USD buy and sell convert at each settlement-date rate', () => {
  const securitiesUS = [...securities, { id: 'A', ticker: 'AAPL', exchange: 'US' }];
  const usd = (type, date, qty, price, comm, fxRate) => ({ ...tx(type, date, { qty: qty * QTY, grossCents: $(qty * price), commissionCents: $(comm) }), securityId: 'A', currency: 'USD', fxRate });
  const l = computeLedger({ accounts, securities: securitiesUS, transactions: [
    usd('BUY', '2026-02-02', 10, 150, 5, 1.35),
    usd('SELL', '2026-06-01', 10, 160, 5, 1.40),
  ] });
  const d = l.dispositions[0];
  assert.equal(d.acbCents, $(2031.75)); // (1500 + 5) x 1.35
  assert.equal(d.proceedsCents, $(2240));
  assert.equal(d.outlaysCents, $(7));
  assert.equal(d.gainCents, $(201.25));
  assert.equal(d.currency, 'USD');
  assert.match(d.explanation, /US\$1,600\.00/);
});

test('USD: currency loss can turn a USD gain into a CAD loss', () => {
  const securitiesUS = [...securities, { id: 'A', ticker: 'AAPL', exchange: 'US' }];
  const usd = (type, date, qty, price, fxRate) => ({ ...tx(type, date, { qty: qty * QTY, grossCents: $(qty * price) }), securityId: 'A', currency: 'USD', fxRate });
  const l = computeLedger({ accounts, securities: securitiesUS, transactions: [usd('BUY', '2026-01-05', 100, 100, 1.45), usd('SELL', '2026-09-01', 100, 105, 1.30)] });
  assert.equal(l.dispositions[0].gainCents, $(13650 - 14500));
});

test('USD without a rate is an error', () => {
  const l = run([{ ...buy('2026-01-05', 1, 100), currency: 'USD' }]);
  assert.match(l.errors[0].message, /exchange rate/);
});
