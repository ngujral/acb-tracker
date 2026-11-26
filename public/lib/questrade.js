// Questrade activity export parser.
// Questrade's account activity export is an Excel (.xlsx) file; parseQuestradeRows takes its rows
// (from readXlsx) and parseQuestrade takes the same data saved as CSV. Expected columns (matched case-insensitively, order does not matter):
//   Transaction Date, Settlement Date, Action, Symbol, Description, Quantity, Price,
//   Gross Amount, Commission, Net Amount, Currency, Account #, Activity Type, Account Type
//
// Output rows are engine-ready transactions without accountId/securityId; the import screen
// maps accountNumber and ticker to stored accounts and securities.

import { parseCSV } from './csv.js';
import { QTY } from './engine.js';
import { defaultSettlementDate } from './dates.js';

// Header names are compared after lowercasing and dropping punctuation ("Trans. date" -> "trans date").
const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
const COLS = {
  tradeDate: ['transaction date', 'trans date', 'trade date', 'date'],
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
  accountNumber: ['account #', 'account', 'account number', 'account no'],
  activityType: ['activity type'],
  accountType: ['account type'],
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// order: 'DMY' (Questrade Canada default) or 'MDY', for ambiguous n/n/yyyy dates
export function detectDateOrder(values) {
  let dmy = 0, mdy = 0;
  for (const v of values) {
    const m = String(v ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/\d{4}/);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy++;
    else if (Number(m[2]) > 12) mdy++;
  }
  return mdy > dmy ? 'MDY' : 'DMY';
}

export function parseDate(s, order = 'DMY') {
  if (s == null || s === '') return null;
  s = String(s).trim();
  if (/^\d{5}(\.\d+)?$/.test(s)) { // Excel serial date (days since 1899-12-30)
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // D/M/YYYY (Questrade) or M/D/YYYY
  if (m) {
    let [d, mo] = order === 'MDY' ? [m[2], m[1]] : [m[1], m[2]];
    if (Number(mo) > 12 && Number(d) <= 12) [d, mo] = [mo, d];
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
    return `${m[3]}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
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
  return parseQuestradeRows(parseCSV(text));
}

export function parseQuestradeRows(allRows) {
  if (!allRows.length) return { error: 'The file is empty.', rows: [] };
  // Skip any title rows above the column headers
  const h = allRows.findIndex((r) => r.some((c) => norm(c) === 'symbol') && r.some((c) => norm(c) === 'action'));
  const rows = h > 0 ? allRows.slice(h) : allRows;
  const header = rows[0].map(norm);
  const idx = {};
  for (const [k, names] of Object.entries(COLS)) {
    idx[k] = -1;
    for (const n of names) { const i = header.indexOf(norm(n)); if (i >= 0) { idx[k] = i; break; } }
  }
  const missing = ['tradeDate', 'action', 'symbol', 'quantity'].filter((k) => idx[k] < 0);
  const LABEL = { tradeDate: 'Transaction date', action: 'Action', symbol: 'Symbol', quantity: 'Quantity' };
  if (missing.length) return { error: `This doesn't look like a Questrade activity export. Couldn't find the column(s): ${missing.map((k) => LABEL[k]).join(', ')}. Found: ${rows[0].filter(Boolean).join(', ')}.`, rows: [] };
  const order = detectDateOrder(rows.slice(1).flatMap((r) => [r[idx.tradeDate], idx.settleDate >= 0 ? r[idx.settleDate] : '']));

  const out = [];
  rows.slice(1).forEach((r, i) => {
    const get = (k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '');
    const line = i + 2;
    const action = get('action').toUpperCase();
    const activity = get('activityType').toLowerCase();
    const currency = (get('currency') || 'CAD').toUpperCase();
    const { ticker, exchange } = tickerFrom(get('symbol'));
    const tradeDate = parseDate(get('tradeDate'), order);
    const settleDate = parseDate(get('settleDate'), order) || (tradeDate && defaultSettlementDate(tradeDate));
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
    if (currency !== 'CAD' && currency !== 'USD') return skip(`${currency} trades are not supported yet`);
    if (!Number.isFinite(qtyRaw) || qtyRaw === 0) return skip('Quantity is zero or unreadable');

    const qty = Math.round(Math.abs(qtyRaw) * QTY);
    let grossCents = Number.isFinite(gross) && gross !== 0 ? Math.round(Math.abs(gross) * 100) : Math.round(Math.abs(qtyRaw * price) * 100);
    if (!grossCents && !(type === 'BUY' && price === 0)) return skip('No amount or price');
    const commissionCents = Number.isFinite(commission) ? Math.round(Math.abs(commission) * 100) : 0;
    const t = { ...base, status: 'new', type, qty, grossCents, commissionCents, source: 'import' };
    if (currency === 'USD' && !t.exchange) t.exchange = 'US';
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
