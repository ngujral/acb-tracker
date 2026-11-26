// Bank of Canada exchange rates via this site's /api/fx endpoint.
// rateOn() returns the rate for a date, or the latest earlier business day's rate
// (the Bank publishes no rate on weekends and holidays).

import { addDays } from './dates.js';

const cache = new Map(); // cur -> { [date]: rate }

export async function loadRates(cur, start, end) {
  const res = await fetch(`/api/fx?cur=${encodeURIComponent(cur)}&start=${start}&end=${end}`);
  if (!res.ok) throw new Error('Could not get Bank of Canada exchange rates. Check your connection, or enter the rate yourself.');
  const { rates } = await res.json();
  cache.set(cur, { ...(cache.get(cur) || {}), ...rates });
  return rates;
}

export function rateFrom(rates, date) {
  for (let d = date, i = 0; i < 10; i++, d = addDays(d, -1)) {
    if (rates[d]) return { rate: rates[d], date: d };
  }
  return null;
}

export async function rateOn(cur, date) {
  const known = cache.get(cur);
  const hit = known && rateFrom(known, date);
  if (hit) return hit;
  const rates = await loadRates(cur, addDays(date, -7), date);
  return rateFrom(rates, date);
}

/** Fill fxRate for every foreign-currency row (mutates), one request per currency. */
export async function fillRates(rows) {
  const byCur = new Map();
  for (const r of rows) {
    if (!r.currency || r.currency === 'CAD' || r.fxRate) continue;
    if (!byCur.has(r.currency)) byCur.set(r.currency, []);
    byCur.get(r.currency).push(r);
  }
  for (const [cur, list] of byCur) {
    const dates = list.map((r) => r.settleDate || r.tradeDate).sort();
    const rates = await loadRates(cur, addDays(dates[0], -7), dates[dates.length - 1]);
    for (const r of list) {
      const hit = rateFrom(rates, r.settleDate || r.tradeDate);
      if (hit) r.fxRate = hit.rate;
    }
  }
  return rows;
}
