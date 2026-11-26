import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQuestrade, markDuplicates, parseDate } from '../public/lib/questrade.js';
import { parseCSV } from '../public/lib/csv.js';
import { QTY } from '../public/lib/engine.js';

const text = readFileSync(new URL('./fixtures/questrade-sample.csv', import.meta.url), 'utf8');

test('parses trades, DRIP, and skips the rest with reasons', () => {
  const { rows, error } = parseQuestrade(text);
  assert.equal(error, undefined);
  assert.equal(rows.length, 8);
  const [b1, b2, s, dis, rei, usd, tfsa, dep] = rows;
  assert.equal(b1.type, 'BUY');
  assert.equal(b1.ticker, 'XEQT');
  assert.equal(b1.exchange, 'TSX');
  assert.equal(b1.qty, 100 * QTY);
  assert.equal(b1.grossCents, 300000);
  assert.equal(b1.commissionCents, 495);
  assert.equal(b1.tradeDate, '2026-01-05');
  assert.equal(b1.settleDate, '2026-01-06');
  assert.equal(b1.accountType, 'NONREG');
  assert.equal(s.type, 'SELL');
  assert.equal(s.qty, 50 * QTY);
  assert.equal(s.grossCents, 5002500);
  assert.equal(dis.status, 'skipped');
  assert.equal(rei.type, 'BUY');
  assert.equal(rei.grossCents, 3120);
  assert.equal(usd.status, 'new');
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.exchange, 'US');
  assert.equal(usd.grossCents, 200000);
  assert.equal(tfsa.accountType, 'TFSA');
  assert.equal(dep.status, 'skipped');
});

test('duplicates within a file and against existing hashes', () => {
  const { rows } = parseQuestrade(text);
  markDuplicates(rows, []);
  assert.equal(rows[1].status, 'duplicate');
  const again = markDuplicates(parseQuestrade(text).rows, rows.filter((r) => r.status === 'new').map((r) => r.importHash));
  assert.equal(again.filter((r) => r.status === 'new').length, 0);
});

test('rejects a non-Questrade file', () => {
  assert.match(parseQuestrade('a,b\n1,2\n').error, /Couldn't find the column/);
});

test('date formats', () => {
  assert.equal(parseDate('1/5/2026 12:00:00 AM', 'MDY'), '2026-01-05');
  assert.equal(parseDate('05-Jan-2026'), '2026-01-05');
  assert.equal(parseDate('Jan 5, 2026'), '2026-01-05');
});

test('csv quoting', () => {
  assert.deepEqual(parseCSV('a,"b,c","d ""q"""\n'), [['a', 'b,c', 'd "q"']]);
});

test('reads the Questrade .xlsx export directly', async () => {
  const { readXlsx } = await import('../public/lib/xlsx.js');
  const { parseQuestradeRows } = await import('../public/lib/questrade.js');
  const buf = readFileSync(new URL('./fixtures/questrade-sample.xlsx', import.meta.url));
  const sheet = await readXlsx(new Uint8Array(buf));
  const fromXlsx = parseQuestradeRows(sheet).rows;
  const fromCsv = parseQuestrade(text).rows;
  assert.equal(fromXlsx.length, 8);
  const pick = (r) => [r.status, r.type, r.tradeDate, r.settleDate, r.ticker, r.qty, r.grossCents, r.commissionCents, r.accountType, r.importHash];
  assert.deepEqual(fromXlsx.map(pick), fromCsv.map(pick));
});

test('Questrade web export: "Trans. date" header, DD/MM/YYYY dates, brackets for negatives', async () => {
  const csv = readFileSync(new URL('./fixtures/questrade-web-columns.csv', import.meta.url), 'utf8');
  const { rows, error } = parseQuestrade(csv);
  assert.equal(error, undefined);
  const [msft, bmnr, etha, meta] = rows;
  assert.equal(msft.tradeDate, '2026-01-29');
  assert.equal(msft.settleDate, '2026-01-30');
  assert.equal(msft.qty, 1539400);
  assert.equal(msft.grossCents, 65197);
  assert.equal(msft.currency, 'USD');
  assert.equal(bmnr.qty, Math.round(2579.3436 * QTY));
  assert.equal(etha.type, 'SELL');
  assert.equal(etha.qty, 3501 * QTY);
  assert.equal(etha.grossCents, 5343437);
  assert.equal(etha.settleDate, '2026-02-17');
  // 05/03/2026 is ambiguous on its own; the file's other dates show it's day-first
  assert.equal(meta.tradeDate, '2026-03-05');
});

test('date order detection', async () => {
  const { detectDateOrder, parseDate } = await import('../public/lib/questrade.js');
  assert.equal(detectDateOrder(['29/01/2026', '05/03/2026']), 'DMY');
  assert.equal(detectDateOrder(['01/29/2026']), 'MDY');
  assert.equal(parseDate('1/5/2026 12:00:00 AM', 'MDY'), '2026-01-05');
  assert.equal(parseDate('13/02/2026'), '2026-02-13');
});
