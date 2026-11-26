// Questrade activity export parser.
// Questrade's Activities export (Reports > Activities > Export) is an Excel file; open it and
// save as CSV. Expected columns (matched case-insensitively, order does not matter):
//   Transaction Date, Settlement Date, Action, Symbol, Description, Quantity, Price,
//   Gross Amount, Commission, Net Amount, Currency, Account #, Activity Type, Account Type
//
// Output rows are engine-ready transactions without accountId/securityId; the import screen
// maps accountNumber and ticker to stored accounts and securities.

import { parseCSV } from './csv.js';
import { QTY } from './engine.js';
import { defaultSettlementDate } from './dates.js';

const COLS = {
  tradeDate: ['transaction date', 'trade date'],
  settleDate: ['settlement date'],
  action: ['action'],
  symbol: ['symbol'],
  description: ['description'],
  quantity: ['quantity'],
  price: ['price'],
  gross: ['gross amount'],
  commission: ['commission'],
  net: ['net amount'],
  currency: ['currency'],
  accountNumber: ['account #', 'account number', 'account'],
  activityType: ['activity type'],
  accountType: ['account type'],
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseDate(s) {
  if (!s) return null;
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // M/D/YYYY (Excel en-US)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ,]+(\d{4})/); // 15-Jan-2026
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^([A-Za-z]{3})[a-z]* (\d{1,2}),? (\d{4})/); // Jan 15, 2026
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

const num = (s) => {
  if (s == null) return 0;
  const t = String(s).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
};

export function accountTypeFrom(label) {
  const s = (label || '').toUpperCase();
  if (s.includes('TFSA')) return 'TFSA';
  if (s.includes('FHSA')) return 'FHSA';
  if (s.includes('RESP')) return 'RESP';
  if (/RRSP|RSP|LIRA|RRIF|RIF|LIF|SPOUSAL/.test(s)) return 'RRSP';
  return 'NONREG';
}

export function tickerFrom(symbol) {
  const s = (symbol || '').trim().toUpperCase();
  const m = s.match(/^(.*?)\.(TO|VN|CN|NE)$/);
  return m ? { ticker: m[1], exchange: { TO: 'TSX', VN: 'TSXV', CN: 'CSE', NE: 'NEO' }[m[2]] } : { ticker: s, exchange: '' };
}

export function importHash(t) {
  return [t.accountNumber, t.tradeDate, t.ticker, t.type, t.qty, t.grossCents].join('|');
}

export function parseQuestrade(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { error: 'The file is empty.', rows: [] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const [k, names] of Object.entries(COLS)) idx[k] = header.findIndex((h) => names.includes(h));
  const missing = ['tradeDate', 'action', 'symbol', 'quantity'].filter((k) => idx[k] < 0);
  if (missing.length) return { error: `This doesn't look like a Questrade activity export. Missing column(s): ${missing.join(', ')}.`, rows: [] };

  const out = [];
  rows.slice(1).forEach((r, i) => {
    const get = (k) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
    const line = i + 2;
    const action = get('action').toUpperCase();
    const activity = get('activityType').toLowerCase();
    const currency = (get('currency') || 'CAD').toUpperCase();
    const { ticker, exchange } = tickerFrom(get('symbol'));
    const tradeDate = parseDate(get('tradeDate'));
    const settleDate = parseDate(get('settleDate')) || (tradeDate && defaultSettlementDate(tradeDate));
    const qtyRaw = num(get('quantity'));
    const price = num(get('price'));
    const gross = num(get('gross'));
    const commission = num(get('commission'));
    const base = {
      line, raw: r, tradeDate, settleDate, ticker, exchange, description: get('description'),
      accountNumber: get('accountNumber') || 'Questrade', accountType: accountTypeFrom(get('accountType')),
      currency, action, activity,
    };
    const skip = (reason) => out.push({ ...base, status: 'skipped', reason });

    if (!tradeDate) return skip('Could not read the date');
    let type = null;
    if (activity.includes('reinvest') || action === 'REI' || action === 'DRIP') type = 'BUY';
    else if (action === 'BUY' || action === 'BY') type = 'BUY';
    else if (action === 'SELL' || action === 'SL') type = 'SELL';
    if (!type) return skip(`Not a trade (${get('activityType') || action || 'unknown'}). Enter ROC or reinvested distributions manually.`);
    if (!ticker) return skip('No symbol');
    if (currency !== 'CAD') return skip(`${currency} trades are not supported yet`);
    if (!Number.isFinite(qtyRaw) || qtyRaw === 0) return skip('Quantity is zero or unreadable');

    const qty = Math.round(Math.abs(qtyRaw) * QTY);
    let grossCents = Number.isFinite(gross) && gross !== 0 ? Math.round(Math.abs(gross) * 100) : Math.round(Math.abs(qtyRaw * price) * 100);
    if (!grossCents && !(type === 'BUY' && price === 0)) return skip('No amount or price');
    const commissionCents = Number.isFinite(commission) ? Math.round(Math.abs(commission) * 100) : 0;
    const t = { ...base, status: 'new', type, qty, grossCents, commissionCents, source: 'import' };
    t.importHash = importHash(t);
    out.push(t);
  });
  return { rows: out };
}

/** Mark rows already imported (by hash) or repeated within the same file as duplicates. */
export function markDuplicates(rows, existingHashes) {
  const seen = new Set(existingHashes);
  for (const r of rows) {
    if (r.status !== 'new') continue;
    if (seen.has(r.importHash)) { r.status = 'duplicate'; r.reason = 'Already imported'; }
    else seen.add(r.importHash);
  }
  return rows;
}
