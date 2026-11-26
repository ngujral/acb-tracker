// ACB engine: a pure function from transactions to ACB timelines and dispositions.
//
// Units
//   money    integer cents (Number)
//   quantity integer micro-shares (Number): 1 share = 1_000_000
//
// Transaction shape
//   { id, seq, accountId, securityId, type, tradeDate, settleDate,
//     qty, grossCents, commissionCents, amountCents, ratioNum, ratioDen, note }
//   type: BUY | SELL | REINVESTED_DIST | ROC | SPLIT | TRANSFER_IN
//   BUY/SELL: qty, grossCents (qty x price), commissionCents
//   REINVESTED_DIST / ROC: amountCents (accountId identifies the holding)
//   TRANSFER_IN: qty, amountCents (ACB carried in)
//   SPLIT: ratioNum/ratioDen new shares per old share (2-for-1 => 2/1); applies to every account
//
// Dates: ordering and superficial-loss windows use the settlement date (the date the
// acquisition or disposition happens for tax purposes); trade date breaks ties.

import { addDays, yearOf } from './dates.js';

export const QTY = 1_000_000;
export const REGISTERED = new Set(['TFSA', 'RRSP', 'FHSA', 'RESP']);

const TYPE_ORDER = { SPLIT: 0, TRANSFER_IN: 1, BUY: 2, REINVESTED_DIST: 3, ROC: 4, SELL: 5 };

// round(a * b / c), half away from zero, exact for large values
export function mulDiv(a, b, c) {
  if (c === 0) throw new Error('division by zero');
  const neg = (a < 0) !== (b < 0) !== (c < 0);
  const A = BigInt(Math.abs(a)), B = BigInt(Math.abs(b)), C = BigInt(Math.abs(c));
  const q = (A * B * 2n + C) / (C * 2n);
  const r = Number(q);
  return neg ? -r : r;
}

export const fmtMoney = (cents) => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-CA')}.${String(abs % 100).padStart(2, '0')}`;
};

export const fmtQty = (q) => {
  const v = q / QTY;
  return Number.isInteger(v) ? v.toLocaleString('en-CA') : v.toLocaleString('en-CA', { maximumFractionDigits: 6 });
};

export function groupKeyOf(securities, securityId) {
  const s = securities.find((x) => x.id === securityId);
  return (s && s.identicalGroupId) || securityId;
}

function sortEvents(list) {
  return [...list].sort((a, b) =>
    (a.settleDate || a.tradeDate).localeCompare(b.settleDate || b.tradeDate) ||
    a.tradeDate.localeCompare(b.tradeDate) ||
    TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
    (a.seq ?? 0) - (b.seq ?? 0));
}

const dateOf = (t) => t.settleDate || t.tradeDate;

/**
 * Run the engine.
 * @returns {{ groups: Object, dispositions: Array, errors: Array, warnings: Array }}
 */
export function computeLedger({ accounts, securities, transactions }) {
  const acctType = new Map(accounts.map((a) => [a.id, a.type]));
  const isNonReg = (accountId) => acctType.get(accountId) === 'NONREG';
  const errors = [];
  const warnings = [];
  const dispositions = [];
  const groups = {};

  const byGroup = new Map();
  for (const t of transactions) {
    const k = groupKeyOf(securities, t.securityId);
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(t);
  }

  for (const [key, list] of byGroup) {
    const events = sortEvents(list);

    // Pass 1: quantities per account (all account types), for validation and
    // for "shares held at the end of the superficial-loss window".
    const perAcct = new Map();
    const qtyTimeline = []; // { date, total } after each event
    for (const e of events) {
      if (e.type === 'SPLIT') {
        for (const [a, q] of perAcct) perAcct.set(a, mulDiv(q, e.ratioNum, e.ratioDen));
      } else if (e.type === 'BUY' || e.type === 'TRANSFER_IN') {
        perAcct.set(e.accountId, (perAcct.get(e.accountId) || 0) + e.qty);
      } else if (e.type === 'SELL') {
        const held = perAcct.get(e.accountId) || 0;
        if (e.qty > held) {
          errors.push({ txId: e.id, message: `Sells ${fmtQty(e.qty)} shares but the account holds ${fmtQty(held)} on ${dateOf(e)}.` });
        }
        perAcct.set(e.accountId, held - e.qty);
      }
      let total = 0;
      for (const q of perAcct.values()) total += q;
      qtyTimeline.push({ date: dateOf(e), total });
    }
    const heldAtEndOf = (date) => {
      let total = 0;
      for (const p of qtyTimeline) { if (p.date <= date) total = p.total; else break; }
      return total;
    };

    // Pass 2: the pooled ACB across non-registered accounts.
    let shares = 0;
    let acb = 0;
    const timeline = [];
    const push = (e, deltaAcb, note) => timeline.push({ txId: e.id, date: dateOf(e), type: e.type, shares, acb, deltaAcb, note });

    for (const e of events) {
      const nonreg = e.type === 'SPLIT' || isNonReg(e.accountId);
      if (!nonreg) continue; // registered holdings only matter for superficial losses

      switch (e.type) {
        case 'BUY': {
          const cost = e.grossCents + (e.commissionCents || 0);
          shares += e.qty; acb += cost;
          push(e, cost, `Bought ${fmtQty(e.qty)} for ${fmtMoney(e.grossCents)} + ${fmtMoney(e.commissionCents || 0)} commission`);
          break;
        }
        case 'TRANSFER_IN': {
          shares += e.qty; acb += e.amountCents;
          push(e, e.amountCents, `Opening balance / transfer in: ${fmtQty(e.qty)} shares at ACB ${fmtMoney(e.amountCents)}`);
          break;
        }
        case 'REINVESTED_DIST': {
          acb += e.amountCents;
          if (shares === 0) warnings.push({ txId: e.id, message: 'Reinvested distribution recorded while holding no shares.' });
          push(e, e.amountCents, `Reinvested distribution ${fmtMoney(e.amountCents)} added to ACB`);
          break;
        }
        case 'ROC': {
          acb -= e.amountCents;
          let note = `Return of capital ${fmtMoney(e.amountCents)} subtracted from ACB`;
          if (shares === 0) warnings.push({ txId: e.id, message: 'Return of capital recorded while holding no shares.' });
          if (acb < 0) {
            const gain = -acb;
            dispositions.push({
              kind: 'NEGATIVE_ACB', txId: e.id, groupKey: key, securityId: e.securityId, accountId: e.accountId,
              date: dateOf(e), year: yearOf(dateOf(e)), qty: 0, proceedsCents: 0, outlaysCents: 0,
              acbCents: 0, gainCents: gain, deniedCents: 0, lostCents: 0,
              explanation: `ACB went below zero by ${fmtMoney(gain)}. That amount is a capital gain in ${yearOf(dateOf(e))} and the ACB resets to $0.00.`,
            });
            note += `; ACB below zero by ${fmtMoney(gain)}: reported as a gain, ACB reset to $0.00`;
            acb = 0;
          }
          push(e, -e.amountCents, note);
          break;
        }
        case 'SPLIT': {
          const before = shares;
          shares = mulDiv(shares, e.ratioNum, e.ratioDen);
          push(e, 0, `Split ${e.ratioNum}:${e.ratioDen}: ${fmtQty(before)} shares became ${fmtQty(shares)}; total ACB unchanged`);
          break;
        }
        case 'SELL': {
          if (e.qty > shares) { push(e, 0, 'Skipped: sells more shares than held'); break; }
          const acbSold = e.qty === shares ? acb : mulDiv(acb, e.qty, shares);
          const proceeds = e.grossCents;
          const outlays = e.commissionCents || 0;
          let gain = proceeds - outlays - acbSold;
          shares -= e.qty; acb -= acbSold;
          const lossBefore = gain;
          let denied = 0, lost = 0, superficialNote = '';

          if (gain < 0) {
            const start = addDays(dateOf(e), -30);
            const end = addDays(dateOf(e), 30);
            let acquired = 0, acquiredNonReg = 0;
            for (const x of events) {
              if ((x.type === 'BUY' || x.type === 'TRANSFER_IN') && dateOf(x) >= start && dateOf(x) <= end && x !== e) {
                acquired += x.qty;
                if (isNonReg(x.accountId)) acquiredNonReg += x.qty;
              }
            }
            const heldEnd = heldAtEndOf(end);
            const n = Math.min(e.qty, acquired, heldEnd);
            if (n > 0) {
              denied = mulDiv(-gain, n, e.qty);
              const toPool = mulDiv(denied, acquiredNonReg, acquired);
              lost = denied - toPool;
              gain += denied;
              acb += toPool;
              superficialNote = ` Superficial loss: ${fmtMoney(denied)} of the ${fmtMoney(-lossBefore)} loss is denied ` +
                `(${fmtMoney(-lossBefore)} x ${fmtQty(n)} / ${fmtQty(e.qty)}; ${fmtQty(acquired)} bought between ${start} and ${end}, ${fmtQty(heldEnd)} held on ${end}).` +
                (toPool ? ` ${fmtMoney(toPool)} is added to the ACB of the shares you still hold.` : '') +
                (lost ? ` ${fmtMoney(lost)} is permanently lost because the re-purchase was in a registered account.` : '');
              if (lost) warnings.push({ txId: e.id, message: `Loss of ${fmtMoney(lost)} permanently lost: identical shares were bought in a registered account within 30 days.` });
            }
          }

          const explanation = `Proceeds ${fmtMoney(proceeds)} - outlays ${fmtMoney(outlays)} - ACB of shares sold ${fmtMoney(acbSold)}` +
            ` (${fmtQty(e.qty)} / ${fmtQty(e.qty + shares)} of pool ACB) = ${fmtMoney(lossBefore)}.` + superficialNote;
          dispositions.push({
            kind: 'SALE', txId: e.id, groupKey: key, securityId: e.securityId, accountId: e.accountId,
            date: dateOf(e), tradeDate: e.tradeDate, year: yearOf(dateOf(e)), qty: e.qty,
            proceedsCents: proceeds, outlaysCents: outlays, acbCents: acbSold,
            gainBeforeCents: lossBefore, gainCents: gain, deniedCents: denied, lostCents: lost, explanation,
          });
          push(e, -acbSold + (denied - lost), `Sold ${fmtQty(e.qty)}: gain ${fmtMoney(gain)}${denied ? ` (after ${fmtMoney(denied)} superficial loss denied)` : ''}`);
          break;
        }
        default:
          warnings.push({ txId: e.id, message: `Unknown transaction type ${e.type}` });
      }
    }

    groups[key] = { key, shares, acbCents: acb, timeline };
  }

  return { groups, dispositions, errors, warnings };
}

/** Year report shaped like Schedule 3 (Part 3: publicly traded shares, units and other shares). */
export function yearReport(ledger, year, inclusionRate = 0.5) {
  const rows = ledger.dispositions.filter((d) => d.year === year);
  const sum = (f) => rows.reduce((s, r) => s + r[f], 0);
  const net = sum('gainCents');
  return {
    year,
    rows,
    totals: {
      proceedsCents: sum('proceedsCents'),
      acbCents: sum('acbCents'),
      outlaysCents: sum('outlaysCents'),
      netGainCents: net,
      taxableCents: Math.round(net * inclusionRate),
      deniedCents: sum('deniedCents'),
      lostCents: sum('lostCents'),
    },
    inclusionRate,
  };
}

/**
 * Check a planned sale before placing it. Adds a hypothetical SELL and runs the engine.
 * Returns the expected disposition, buys in the past 30 days, and the first safe re-buy date.
 */
export function checkSale(data, { accountId, securityId, qty, grossCents, commissionCents = 0, tradeDate, settleDate }) {
  const probe = { id: '__probe__', seq: Number.MAX_SAFE_INTEGER, accountId, securityId, type: 'SELL', tradeDate, settleDate, qty, grossCents, commissionCents };
  const ledger = computeLedger({ ...data, transactions: [...data.transactions, probe] });
  const error = ledger.errors.find((x) => x.txId === '__probe__');
  const disposition = ledger.dispositions.find((d) => d.txId === '__probe__');
  const key = groupKeyOf(data.securities, securityId);
  const start = addDays(settleDate, -30);
  const recentBuys = data.transactions.filter((t) =>
    (t.type === 'BUY' || t.type === 'TRANSFER_IN') && groupKeyOf(data.securities, t.securityId) === key &&
    dateOf(t) >= start && dateOf(t) <= settleDate);
  return {
    error: error && error.message,
    disposition,
    recentBuys,
    safeRebuyAfter: addDays(settleDate, 30), // re-buys settling after this date are outside the window
  };
}
