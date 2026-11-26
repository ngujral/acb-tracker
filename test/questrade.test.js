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
  assert.equal(usd.status, 'skipped');
  assert.match(usd.reason, /USD/);
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
  assert.match(parseQuestrade('a,b\n1,2\n').error, /Missing column/);
});

test('date formats', () => {
  assert.equal(parseDate('1/5/2026 12:00:00 AM'), '2026-01-05');
  assert.equal(parseDate('05-Jan-2026'), '2026-01-05');
  assert.equal(parseDate('Jan 5, 2026'), '2026-01-05');
});

test('csv quoting', () => {
  assert.deepEqual(parseCSV('a,"b,c","d ""q"""\n'), [['a', 'b,c', 'd "q"']]);
});
