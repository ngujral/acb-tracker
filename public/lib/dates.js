// Date helpers. All dates are ISO strings "YYYY-MM-DD" in local calendar terms (no time zones).

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISO(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

export function yearOf(iso) {
  return Number(iso.slice(0, 4));
}

function ymd(y, m, d) {
  return toISO(new Date(Date.UTC(y, m - 1, d)));
}

// nth weekday (0=Sun..6=Sat) of a month; n=-1 for last
function nthWeekday(y, m, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return ymd(y, m, day);
  }
  const lastDate = new Date(Date.UTC(y, m, 0));
  const diff = (lastDate.getUTCDay() - weekday + 7) % 7;
  return ymd(y, m, lastDate.getUTCDate() - diff);
}

// Monday before May 25 (Victoria Day)
function victoriaDay(y) {
  const may24 = new Date(Date.UTC(y, 4, 24));
  const diff = (may24.getUTCDay() - 1 + 7) % 7;
  return ymd(y, 5, 24 - diff);
}

// Anonymous Gregorian algorithm
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
}

// Fixed-date holiday falling on a weekend moves to Monday
function observed(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = dt.getUTCDay();
  if (wd === 6) dt.setUTCDate(dt.getUTCDate() + 2);
  else if (wd === 0) dt.setUTCDate(dt.getUTCDate() + 1);
  return toISO(dt);
}

const holidayCache = new Map();

// Canadian market (TSX / CDS settlement) holidays
export function marketHolidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const set = new Set([
    observed(y, 1, 1),
    nthWeekday(y, 2, 1, 3), // Family Day
    addDays(easter(y), -2), // Good Friday
    victoriaDay(y),
    observed(y, 7, 1),
    nthWeekday(y, 8, 1, 1), // Civic Holiday
    nthWeekday(y, 9, 1, 1), // Labour Day
    nthWeekday(y, 10, 1, 2), // Thanksgiving
  ]);
  // Christmas and Boxing Day with weekend shifting
  const xmas = new Date(Date.UTC(y, 11, 25)).getUTCDay();
  if (xmas === 6) { set.add(ymd(y, 12, 27)); set.add(ymd(y, 12, 28)); }
  else if (xmas === 0) { set.add(ymd(y, 12, 26)); set.add(ymd(y, 12, 27)); }
  else if (xmas === 5) { set.add(ymd(y, 12, 25)); set.add(ymd(y, 12, 28)); }
  else { set.add(ymd(y, 12, 25)); set.add(ymd(y, 12, 26)); }
  holidayCache.set(y, set);
  return set;
}

export function isBusinessDay(iso) {
  const wd = parseISO(iso).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !marketHolidays(yearOf(iso)).has(iso);
}

export function addBusinessDays(iso, n) {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isBusinessDay(d)) left--;
  }
  return d;
}

// Canada moved from T+2 to T+1 on 2024-05-27 (first T+1 trade date)
export function defaultSettlementDate(tradeDate) {
  return addBusinessDays(tradeDate, tradeDate >= '2024-05-27' ? 1 : 2);
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
