import { computeLedger, yearReport, checkSale, groupKeyOf, fmtMoney, fmtCur, fmtQty, QTY, REGISTERED } from './lib/engine.js';
import { fillRates, rateOn } from './lib/fx.js';
import { defaultSettlementDate, today, yearOf } from './lib/dates.js';
import { loadAll, put, putMany, del, setSetting, replaceAll, uid } from './lib/db.js';
import { parseQuestrade, parseQuestradeRows, markDuplicates } from './lib/questrade.js';
import { readXlsx } from './lib/xlsx.js';
import { toCSV } from './lib/csv.js';
import { encryptBackup, decryptBackup } from './lib/backup.js';

const app = document.getElementById('app');
const banner = document.getElementById('banner');
const state = { data: null, ledger: null, importRows: null };

const TYPE_LABEL = {
  BUY: 'Buy', SELL: 'Sell', REINVESTED_DIST: 'Reinvested distribution', ROC: 'Return of capital',
  SPLIT: 'Split / consolidation', TRANSFER_IN: 'Opening balance / transfer in',
};
const ACCT_LABEL = { NONREG: 'Non-registered', TFSA: 'TFSA', RRSP: 'RRSP / RRIF / LIRA', FHSA: 'FHSA', RESP: 'RESP' };
const BROKERS = [
  { id: 'questrade', name: 'Questrade', ready: true },
  { id: 'td', name: 'TD Direct Investing' },
  { id: 'rbc', name: 'RBC Direct Investing' },
  { id: 'wealthsimple', name: 'Wealthsimple' },
  { id: 'cibc', name: "CIBC Investor's Edge" },
  { id: 'bmo', name: 'BMO InvestorLine' },
  { id: 'scotia', name: 'Scotia iTRADE' },
  { id: 'nbdb', name: 'National Bank Direct Brokerage' },
  { id: 'ibkr', name: 'Interactive Brokers' },
];
const brokerSelectHTML = (id, selected = 'questrade') => `<select id="${id}" aria-label="Broker">${BROKERS.map((b) =>
  `<option value="${b.id}" ${b.id === selected ? 'selected' : ''}>${esc(b.name)}${b.ready ? '' : ' (coming soon)'}</option>`).join('')}</select>`;
const APP_VERSION = '2026-11-27.11';
const BACKUP_EVERY_CHANGES = 20;
const BACKUP_EVERY_DAYS = 30;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => `<span class="num ${c < 0 ? 'neg' : ''}">${fmtMoney(c)}</span>`;
const gainCell = (c) => `<span class="num ${c < 0 ? 'neg' : c > 0 ? 'pos' : ''}">${fmtMoney(c)}</span>`;
const parseMoney = (s) => { const v = Number(String(s ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(v) ? Math.round(v * 100) : NaN; };
const parseQty = (s) => { const v = Number(String(s ?? '').replace(/[,\s]/g, '')); return Number.isFinite(v) ? Math.round(v * QTY) : NaN; };
const centsToInput = (c) => (c == null ? '' : (c / 100).toFixed(2));
const qtyToInput = (q) => (q == null ? '' : String(q / QTY));
const acct = (id) => state.data.accounts.find((a) => a.id === id);
const sec = (id) => state.data.securities.find((s) => s.id === id);
const groupName = (key) => {
  const members = state.data.securities.filter((s) => (s.identicalGroupId || s.id) === key);
  return members.map((s) => s.ticker).join(' / ') || '?';
};
const groupMembers = (key) => state.data.securities.filter((s) => (s.identicalGroupId || s.id) === key);
const secCurrency = (securityId) => {
  const txs = state.data.transactions.filter((t) => t.securityId === securityId && (t.type === 'BUY' || t.type === 'SELL'));
  const last = txs.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate))[0];
  return last?.currency || (sec(securityId)?.exchange === 'US' ? 'USD' : 'CAD');
};
const groupCurrency = (key) => secCurrency(groupMembers(key)[0]?.id);
const nonRegAccounts = () => state.data.accounts.filter((a) => a.type === 'NONREG');
const inclusionRate = (year) => (state.data.settings.inclusionRates || {})[year] ?? 0.5;

function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function noteChange() {
  const n = (state.data.settings.changeCount || 0) + 1;
  await setSetting('changeCount', n);
}

async function refresh() {
  state.data = await loadAll();
  state.ledger = computeLedger(state.data);
  renderBanner();
  route();
}

function renderBanner() {
  const s = state.data.settings;
  const hasData = state.data.transactions.length > 0;
  const days = s.lastBackupAt ? (Date.now() - new Date(s.lastBackupAt)) / 86400000 : Infinity;
  const due = hasData && ((s.changeCount || 0) >= BACKUP_EVERY_CHANGES || (days > BACKUP_EVERY_DAYS && (s.changeCount || 0) > 0));
  banner.innerHTML = due
    ? `<div class="alert warn"><strong>Time for a backup.</strong> Your records live only in this browser. Clearing site data or losing this device erases them. <a href="#/settings">Back up now</a></div>`
    : '';
}

// ---------- router ----------
window.addEventListener('hashchange', route);
function route() {
  const hash = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const [, page, arg] = hash.split('/');
  const tab = { '': 'holdings', sec: 'holdings', add: 'add', edit: 'add', check: 'check', import: 'import', reports: 'reports' }[page || ''];
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  const view = { '': viewHoldings, sec: viewSecurity, add: viewForm, edit: viewForm, check: viewCheck, import: viewImport, reports: viewReports, settings: viewSettings }[page || ''] || viewHoldings;
  view(arg ? decodeURIComponent(arg) : undefined);
  window.scrollTo(0, 0);
}

// ---------- holdings ----------
function viewHoldings() {
  const { groups, errors } = state.ledger;
  if (!state.data.transactions.length) {
    app.innerHTML = `
      <div class="empty card">
        <h1>Track your ACB across every broker</h1>
        <p class="muted">Adjusted cost base for your non-registered accounts, pooled the way CRA requires, with a capital gains summary for Schedule 3. Everything stays on this device.</p>
        <form id="startimp" class="start-import">
          <label for="start-broker">Import from your broker</label>
          <div class="row">${brokerSelectHTML('start-broker')}<button type="submit">Import</button></div>
        </form>
        <p class="small muted">or <a href="#/add">add transactions by hand</a></p>
        <p class="small muted" style="margin-top:1rem">Just looking? <button class="link" id="sample">Load sample data</button></p>
      </div>
      ${disclaimer()}`;
    document.getElementById('sample').onclick = loadSample;
    document.getElementById('startimp').onsubmit = (e) => { e.preventDefault(); location.hash = `#/import?broker=${document.getElementById('start-broker').value}`; };
    return;
  }
  const list = Object.values(groups).sort((a, b) => groupName(a.key).localeCompare(groupName(b.key)));
  const held = list.filter((g) => g.shares > 0);
  const closed = list.filter((g) => g.shares === 0);
  const totalAcb = held.reduce((s, g) => s + g.acbCents, 0);
  const row = (g) => `
    <a class="holding" href="#/sec/${encodeURIComponent(g.key)}">
      <div><div class="ticker">${esc(groupName(g.key))} ${groupCurrency(g.key) !== 'CAD' ? `<span class="chip">${groupCurrency(g.key)}</span>` : ''}</div><div class="small muted">${fmtQty(g.shares)} shares</div></div>
      <div style="text-align:right"><div class="num"><strong>${fmtMoney(g.acbCents)}</strong></div>
      <div class="small muted num">${g.shares ? `${fmtMoney(Math.round(g.acbCents * QTY / g.shares))} / share` : 'closed'}</div></div>
    </a>`;
  app.innerHTML = `
    ${errors.length ? `<div class="alert bad"><strong>${errors.length} problem${errors.length > 1 ? 's' : ''} to fix</strong>${errors.map((e) => `<div>${esc(e.message)} <a href="#/edit/${e.txId}">Edit</a></div>`).join('')}
      ${errors.some((e) => /holds/.test(e.message)) ? '<p class="small" style="margin:.5rem 0 0">Usually the shares were bought before your export\'s date range. Add an <a href="#/add">opening balance</a> (Add, then "Opening balance / transfer in") dated before the sale, with the shares and ACB from your statement.</p>' : ''}</div>` : ''}
    <div class="split"><h1>Holdings</h1><span class="small muted">Non-registered, pooled</span></div>
    <p class="muted small">Total ACB ${fmtMoney(totalAcb)} across ${held.length} securit${held.length === 1 ? 'y' : 'ies'}</p>
    <div class="card tight">${held.map(row).join('') || '<p class="pad muted">No open positions.</p>'}</div>
    ${closed.length ? `<h2>Closed positions</h2><div class="card tight">${closed.map(row).join('')}</div>` : ''}
    ${disclaimer()}`;
}

// ---------- security detail ----------
function viewSecurity(key) {
  const g = state.ledger.groups[key];
  if (!g) { location.hash = '#/'; return; }
  const txById = new Map(state.data.transactions.map((t) => [t.id, t]));
  const disp = state.ledger.dispositions.filter((d) => d.groupKey === key);
  const dispByTx = new Map(disp.map((d) => [d.txId, d]));
  const otherTx = state.data.transactions.filter((t) => groupKeyOf(state.data.securities, t.securityId) === key && acct(t.accountId) && acct(t.accountId).type !== 'NONREG');
  const rows = [...g.timeline].reverse().map((e) => {
    const t = txById.get(e.txId);
    const d = dispByTx.get(e.txId);
    return `<tr>
      <td class="date">${e.date}<div class="small muted">${t && t.accountId ? esc(acct(t.accountId)?.name || '') : 'All accounts'}</div></td>
      <td>${TYPE_LABEL[e.type]} ${d && d.deniedCents ? '<span class="chip flag">Superficial loss</span>' : ''}
        <details class="explain"><summary>How</summary><p>${esc(d ? d.explanation : e.note)}</p></details></td>
      <td class="num">${fmtQty(e.shares)}</td>
      <td class="num">${fmtMoney(e.acb)}<div class="small muted">${e.deltaAcb ? `${e.deltaAcb > 0 ? '+' : ''}${fmtMoney(e.deltaAcb)}` : ''}</div></td>
      <td class="noprint">${t ? `<a href="#/edit/${t.id}">Edit</a>` : ''}</td></tr>`;
  }).join('');
  const realized = disp.reduce((s, d) => s + d.gainCents, 0);
  const txIds = new Set(g.timeline.map((e) => e.txId));
  const secWarnings = state.ledger.warnings.filter((w) => txIds.has(w.txId));
  app.innerHTML = `
    <p class="small"><a href="#/">Holdings</a></p>
    <h1>${esc(groupName(key))}</h1>
    ${secWarnings.length ? `<div class="alert warn">${secWarnings.map((w) => `<div>${esc(w.message)}</div>`).join('')}</div>` : ''}
    <p class="muted small">${esc(groupMembers(key).map((s) => s.name || s.exchange).filter(Boolean).join(' / '))}</p>
    <dl class="kv card">
      <div><dt>Shares</dt><dd>${fmtQty(g.shares)}</dd></div>
      <div><dt>Total ACB</dt><dd>${fmtMoney(g.acbCents)}</dd></div>
      <div><dt>ACB per share</dt><dd>${g.shares ? fmtMoney(Math.round(g.acbCents * QTY / g.shares)) : '-'}</dd></div>
      <div><dt>Realized gains, all years</dt><dd>${gainCell(realized)}</dd></div>
    </dl>
    <div class="row noprint"><a class="btn" href="#/add?sec=${encodeURIComponent(groupMembers(key)[0]?.id || '')}">Add transaction</a>
      <a class="btn secondary" href="#/check?sec=${encodeURIComponent(groupMembers(key)[0]?.id || '')}">Check a sale</a></div>
    <h2>ACB history</h2>
    <div class="card tight scroll"><table>
      <thead><tr><th>Date (settled)</th><th>Event</th><th class="num">Shares</th><th class="num">Total ACB</th><th class="noprint"></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${otherTx.length ? `<h2>In registered accounts</h2><p class="small muted">Not part of ACB, but counted for superficial losses.</p>
      <div class="card tight scroll"><table><thead><tr><th>Date</th><th>Account</th><th>Event</th><th class="num">Shares</th><th></th></tr></thead><tbody>
      ${otherTx.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate)).map((t) => `<tr><td>${t.settleDate || t.tradeDate}</td><td>${esc(acct(t.accountId).name)}</td><td>${TYPE_LABEL[t.type]}</td><td class="num">${t.qty ? fmtQty(t.qty) : ''}</td><td><a href="#/edit/${t.id}">Edit</a></td></tr>`).join('')}
      </tbody></table></div>` : ''}
    ${disclaimer()}`;
}

// ---------- add / edit transaction ----------
function viewForm(id) {
  if (!state.data.accounts.length) {
    app.innerHTML = `<h1>Add a transaction</h1><div class="card"><p>First, add the account the transaction belongs to.</p>${accountFormHTML()}</div>`;
    bindAccountForm(() => refresh());
    return;
  }
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const editing = id ? state.data.transactions.find((t) => t.id === id) : null;
  const t = editing || { type: 'BUY', tradeDate: today(), accountId: nonRegAccounts()[0]?.id || state.data.accounts[0].id, securityId: query.get('sec') || '' };
  const s = t.securityId ? sec(t.securityId) : null;
  const priceGuess = t.qty && t.grossCents ? (t.grossCents / 100 / (t.qty / QTY)) : '';
  app.innerHTML = `
    <h1>${editing ? 'Edit transaction' : 'Add a transaction'}</h1>
    <form id="txf" class="card stack" novalidate>
      <div><label>Type</label><div class="seg">${Object.entries(TYPE_LABEL).map(([k, v]) => `<label><input type="radio" name="type" value="${k}" ${t.type === k ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></div>
      <div class="grid2">
        <div data-for="acct"><label for="accountId">Account</label><select id="accountId" name="accountId">${state.data.accounts.map((a) => `<option value="${a.id}" ${a.id === t.accountId ? 'selected' : ''}>${esc(a.name)} (${ACCT_LABEL[a.type]})</option>`).join('')}</select></div>
        <div><label for="ticker">Security <span class="hint">ticker</span></label><input id="ticker" name="ticker" list="tickers" autocomplete="off" autocapitalize="characters" value="${esc(s ? s.ticker : '')}" required placeholder="XEQT">
          <datalist id="tickers">${state.data.securities.map((x) => `<option value="${esc(x.ticker)}">${esc(x.name || '')}</option>`).join('')}</datalist></div>
      </div>
      <div class="grid2">
        <div><label for="tradeDate"><span data-show="BUY SELL">Trade date</span><span data-show="REINVESTED_DIST ROC SPLIT TRANSFER_IN">Date</span></label><input type="date" id="tradeDate" name="tradeDate" value="${t.tradeDate}" required></div>
        <div data-show="BUY SELL"><label for="settleDate">Settlement date <span class="hint">sets the tax year</span></label><input type="date" id="settleDate" name="settleDate" value="${t.settleDate || defaultSettlementDate(t.tradeDate)}"></div>
      </div>
      <div class="grid2" data-show="BUY SELL REINVESTED_DIST ROC">
        <div><label for="currency">Currency</label><select id="currency" name="currency">${['CAD', 'USD'].map((c) => `<option ${((t.currency || (s ? secCurrency(s.id) : 'CAD')) === c) ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div data-fx><label for="fxRate">CAD per USD <span class="hint" id="fxhint">Bank of Canada, settlement date</span></label><input id="fxRate" name="fxRate" inputmode="decimal" value="${t.fxRate || ''}"></div>
      </div>
      <div class="grid2" data-show="BUY SELL TRANSFER_IN">
        <div><label for="qty">Shares</label><input id="qty" name="qty" inputmode="decimal" value="${qtyToInput(t.qty)}"></div>
        <div data-show="BUY SELL"><label for="price">Price per share <span class="hint" data-curlabel></span></label><input id="price" name="price" inputmode="decimal" value="${priceGuess ? Number(priceGuess.toFixed(6)) : ''}"></div>
      </div>
      <div class="grid2" data-show="BUY SELL">
        <div><label for="gross">Total amount <span class="hint">shares x price, before commission <span data-curlabel></span></span></label><input id="gross" name="gross" inputmode="decimal" value="${centsToInput(t.grossCents)}"></div>
        <div><label for="commission">Commission and fees</label><input id="commission" name="commission" inputmode="decimal" value="${centsToInput(t.commissionCents || 0)}"></div>
      </div>
      <div data-show="REINVESTED_DIST ROC TRANSFER_IN"><label for="amount"><span data-show="TRANSFER_IN">Total ACB of these shares</span><span data-show="REINVESTED_DIST ROC">Amount <span class="hint">from your T3 or the fund's tax breakdown <span data-curlabel></span></span></span></label><input id="amount" name="amount" inputmode="decimal" value="${centsToInput(t.amountCents)}"></div>
      <div class="grid2" data-show="SPLIT">
        <div><label for="ratioNum">New shares</label><input id="ratioNum" name="ratioNum" inputmode="numeric" value="${t.ratioNum || 2}"></div>
        <div><label for="ratioDen">for every old shares</label><input id="ratioDen" name="ratioDen" inputmode="numeric" value="${t.ratioDen || 1}"></div>
      </div>
      <div><label for="note">Note <span class="hint">optional</span></label><input id="note" name="note" value="${esc(t.note || '')}"></div>
      <div id="formerr" role="alert"></div>
      <div class="row"><button type="submit">${editing ? 'Save changes' : 'Add'}</button>
        ${editing ? '<button type="button" class="danger" id="deltx">Delete</button>' : ''}
        <button type="button" class="secondary" id="canceltx">Cancel</button></div>
    </form>`;
  const f = document.getElementById('txf');
  const typeNow = () => f.type.value;
  const sync = () => {
    const ty = typeNow();
    f.querySelectorAll('[data-show]').forEach((el) => { el.hidden = !el.dataset.show.split(' ').includes(ty); });
    f.querySelector('[data-for="acct"]').hidden = ty === 'SPLIT';
  };
  document.getElementById('canceltx').onclick = () => history.back();
  f.addEventListener('change', (e) => { if (e.target.name === 'type') sync(); });
  sync();
  let settleTouched = !!editing;
  f.settleDate.addEventListener('input', () => { settleTouched = true; });
  let fxTouched = !!(editing && editing.fxRate);
  f.fxRate.addEventListener('input', () => { fxTouched = true; });
  const syncFx = async () => {
    const usd = f.currency.value !== 'CAD' && ['BUY', 'SELL', 'REINVESTED_DIST', 'ROC'].includes(typeNow());
    f.querySelector('[data-fx]').hidden = !usd;
    f.querySelectorAll('[data-curlabel]').forEach((el) => { el.textContent = usd ? `in ${f.currency.value}` : ''; });
    if (!usd || fxTouched) return;
    const date = (['BUY', 'SELL'].includes(typeNow()) ? f.settleDate.value : f.tradeDate.value);
    if (!date) return;
    const hint = document.getElementById('fxhint');
    hint.textContent = 'looking up…';
    try {
      const r = await rateOn(f.currency.value, date);
      if (r && !fxTouched) { f.fxRate.value = r.rate; hint.textContent = `Bank of Canada, ${r.date}`; }
      else if (!r) hint.textContent = 'no rate found; enter it';
    } catch { hint.textContent = 'offline; enter the rate'; }
  };
  f.currency.addEventListener('change', () => { fxTouched = false; syncFx(); });
  f.addEventListener('change', (e) => { if (e.target.name === 'type') syncFx(); });
  f.tradeDate.addEventListener('change', () => { if (!settleTouched && f.tradeDate.value) f.settleDate.value = defaultSettlementDate(f.tradeDate.value); if (!fxTouched) syncFx(); });
  f.settleDate.addEventListener('change', () => { if (!fxTouched) syncFx(); });
  syncFx();
  const recalcGross = () => { const q = Number(f.qty.value.replace(/,/g, '')), p = Number(f.price.value.replace(/[$,]/g, '')); if (q && p) f.gross.value = (q * p).toFixed(2); };
  f.qty.addEventListener('input', recalcGross);
  f.price.addEventListener('input', recalcGross);
  if (editing) document.getElementById('deltx').onclick = async () => {
    if (!confirm('Delete this transaction? Everything after it will be recalculated.')) return;
    await del('transactions', editing.id); await noteChange(); history.back(); await refresh();
  };

  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = (m) => { document.getElementById('formerr').innerHTML = `<div class="alert bad">${esc(m)}</div>`; };
    const ty = typeNow();
    const ticker = f.ticker.value.trim().toUpperCase();
    if (!ticker) return err('Enter a ticker.');
    if (!f.tradeDate.value) return err('Enter a date.');
    let security = state.data.securities.find((x) => x.ticker === ticker);
    const newSecurity = !security;
    if (newSecurity) security = { id: uid(), ticker, exchange: '', name: '' };
    const rec = { id: editing ? editing.id : uid(), seq: editing ? editing.seq : Date.now(), type: ty, securityId: security.id,
      accountId: ty === 'SPLIT' ? null : f.accountId.value, tradeDate: f.tradeDate.value, note: f.note.value.trim(),
      source: editing ? editing.source : 'manual', importHash: editing ? editing.importHash : undefined };
    if (ty === 'BUY' || ty === 'SELL') {
      rec.settleDate = f.settleDate.value || defaultSettlementDate(rec.tradeDate);
      if (rec.settleDate < rec.tradeDate) return err('Settlement date cannot be before the trade date.');
      rec.qty = parseQty(f.qty.value); rec.grossCents = parseMoney(f.gross.value); rec.commissionCents = parseMoney(f.commission.value || '0');
      if (!(rec.qty > 0)) return err('Enter the number of shares.');
      if (!(rec.grossCents >= 0) || Number.isNaN(rec.grossCents)) return err('Enter the price or the total amount.');
      if (!(rec.commissionCents >= 0)) return err('Commission must be zero or more.');
    } else {
      rec.settleDate = rec.tradeDate;
    }
    if (['BUY', 'SELL', 'REINVESTED_DIST', 'ROC'].includes(ty) && f.currency.value !== 'CAD') {
      rec.currency = f.currency.value;
      rec.fxRate = Number(f.fxRate.value.replace(/,/g, ''));
      if (!(rec.fxRate > 0)) return err('Enter the exchange rate (CAD per USD), for example 1.3850.');
    }
    if (ty === 'REINVESTED_DIST' || ty === 'ROC' || ty === 'TRANSFER_IN') {
      rec.amountCents = parseMoney(f.amount.value);
      if (!(rec.amountCents >= 0) || Number.isNaN(rec.amountCents)) return err('Enter the amount.');
    }
    if (ty === 'TRANSFER_IN') { rec.qty = parseQty(f.qty.value); if (!(rec.qty > 0)) return err('Enter the number of shares.'); }
    if (ty === 'SPLIT') {
      rec.ratioNum = Number(f.ratioNum.value); rec.ratioDen = Number(f.ratioDen.value);
      if (!(rec.ratioNum > 0 && rec.ratioDen > 0)) return err('Enter the split ratio, for example 2 for 1.');
    }
    // Block saves that create new problems (for example selling more than held, now or later).
    const others = state.data.transactions.filter((x) => x.id !== rec.id);
    const before = new Set(computeLedger({ ...state.data, transactions: others }).errors.map((e) => e.message));
    const after = computeLedger({ ...state.data, securities: newSecurity ? [...state.data.securities, security] : state.data.securities, transactions: [...others, rec] });
    const fresh = after.errors.filter((e) => !before.has(e.message));
    if (fresh.length) return err(fresh.map((e) => e.message).join(' '));
    if (newSecurity) await put('securities', security);
    await put('transactions', rec);
    await noteChange();
    await refresh();
    location.hash = `#/sec/${encodeURIComponent(groupKeyOf(state.data.securities, security.id))}`;
  };
}

// ---------- sale check ----------
function viewCheck() {
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const accts = nonRegAccounts();
  const heldSecs = state.data.securities.filter((s) => (state.ledger.groups[s.identicalGroupId || s.id]?.shares || 0) > 0);
  if (!accts.length || !heldSecs.length) {
    app.innerHTML = `<h1>Sale check</h1><div class="card"><p class="muted">Add a non-registered holding first, then check a sale here before you place it.</p><a class="btn" href="#/add">Add a transaction</a></div>`;
    return;
  }
  const pre = query.get('sec');
  app.innerHTML = `
    <h1>Check a sale before you place it</h1>
    <p class="muted">See the gain or loss, and whether recent buys would turn a loss into a superficial loss.</p>
    <form id="cf" class="card stack">
      <div class="grid2">
        <div><label for="c-sec">Security</label><select id="c-sec">${heldSecs.map((s) => `<option value="${s.id}" ${s.id === pre ? 'selected' : ''}>${esc(s.ticker)}</option>`).join('')}</select></div>
        <div><label for="c-acct">Selling from</label><select id="c-acct">${accts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
      </div>
      <div class="grid2">
        <div><label for="c-qty">Shares to sell</label><input id="c-qty" inputmode="decimal" required></div>
        <div><label for="c-price">Expected price <span class="hint" id="c-cur"></span></label><input id="c-price" inputmode="decimal" required></div>
      </div>
      <div class="grid2">
        <div><label for="c-comm">Commission</label><input id="c-comm" inputmode="decimal" value="0.00"></div>
        <div><label for="c-date">Trade date</label><input type="date" id="c-date" value="${today()}"></div>
      </div>
      <div id="c-fxrow" hidden><label for="c-fx">CAD per USD <span class="hint" id="c-fxhint">latest Bank of Canada rate</span></label><input id="c-fx" inputmode="decimal"></div>
      <button type="submit">Check</button>
    </form>
    <div id="cres" aria-live="polite"></div>
    ${disclaimer()}`;
  const f = document.getElementById('cf');
  const syncCur = async () => {
    const cur = secCurrency(f['c-sec'].value);
    document.getElementById('c-cur').textContent = cur !== 'CAD' ? `in ${cur}` : '';
    document.getElementById('c-fxrow').hidden = cur === 'CAD';
    if (cur === 'CAD' || f['c-fx'].value) return;
    try { const r = await rateOn(cur, today()); if (r) { f['c-fx'].value = r.rate; document.getElementById('c-fxhint').textContent = `Bank of Canada, ${r.date}`; } }
    catch { document.getElementById('c-fxhint').textContent = 'offline; enter the rate'; }
  };
  f['c-sec'].onchange = () => { f['c-fx'].value = ''; syncCur(); };
  syncCur();
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const out = document.getElementById('cres');
    const qty = parseQty(f['c-qty'].value);
    const price = Number(f['c-price'].value.replace(/[$,]/g, ''));
    if (!(qty > 0) || !(price >= 0)) { out.innerHTML = '<div class="alert bad">Enter shares and price.</div>'; return; }
    const tradeDate = f['c-date'].value || today();
    const securityId = f['c-sec'].value;
    const currency = secCurrency(securityId);
    const fxRate = currency === 'CAD' ? undefined : Number(f['c-fx'].value);
    if (currency !== 'CAD' && !(fxRate > 0)) { out.innerHTML = '<div class="alert bad">Enter the exchange rate.</div>'; return; }
    const r = checkSale(state.data, { accountId: f['c-acct'].value, securityId, qty, grossCents: Math.round(qty / QTY * price * 100), commissionCents: parseMoney(f['c-comm'].value || '0'), tradeDate, settleDate: defaultSettlementDate(tradeDate), currency, fxRate });
    if (r.error) { out.innerHTML = `<div class="alert bad">${esc(r.error)}</div>`; return; }
    const d = r.disposition;
    const ticker = sec(securityId).ticker;
    const isLoss = d.gainBeforeCents < 0;
    out.innerHTML = `
      <div class="card stack">
        <dl class="kv">
          <div><dt>Proceeds after commission${d.currency !== 'CAD' ? ' (CAD)' : ''}</dt><dd>${fmtMoney(d.proceedsCents - d.outlaysCents)}</dd></div>
          <div><dt>ACB of shares sold</dt><dd>${fmtMoney(d.acbCents)}</dd></div>
          <div><dt>${isLoss ? 'Capital loss' : 'Capital gain'}</dt><dd>${gainCell(d.gainBeforeCents)}</dd></div>
          <div><dt>${isLoss ? 'Allowable loss' : 'Taxable'} at ${Math.round(inclusionRate(d.year) * 100)}%</dt><dd>${gainCell(Math.round(d.gainCents * inclusionRate(d.year)))}</dd></div>
        </dl>
        ${d.deniedCents ? `<div class="alert bad"><strong>This would be a superficial loss.</strong> ${fmtMoney(d.deniedCents)} of the loss would be denied because you bought ${esc(ticker)} within the last 30 days and would still hold shares 30 days after the sale. ${d.lostCents ? `${fmtMoney(d.lostCents)} of that would be lost for good, because the buy was in a registered account.` : 'The denied amount would be added to the ACB of the shares you keep.'}</div>` : ''}
        ${isLoss && !d.deniedCents ? `<div class="alert good"><strong>The loss is claimable on what we know today.</strong> To keep it, don't buy ${esc(ticker)} in any account (including your TFSA, RRSP, or your spouse's accounts) with a settlement date on or before ${r.safeRebuyAfter}.</div>` : ''}
        ${!isLoss ? `<p class="small muted">A gain is never superficial. Settles ${defaultSettlementDate(tradeDate)}, so it's reported for ${yearOf(defaultSettlementDate(tradeDate))}.</p>` : ''}
        ${r.recentBuys.length ? `<div><strong class="small">Buys in the 30 days before this sale</strong><ul class="small">${r.recentBuys.map((b) => `<li>${b.settleDate || b.tradeDate}: ${fmtQty(b.qty)} in ${esc(acct(b.accountId)?.name || '')}</li>`).join('')}</ul></div>` : ''}
        <details class="explain"><summary>How this was calculated</summary><p>${esc(d.explanation)}</p></details>
      </div>`;
  };
}

// ---------- import ----------
function rowsTable(title, list, open) {
  if (!list.length) return '';
  return `${title ? `<h2>${esc(title)}</h2>` : ''}<div class="card tight scroll"><table>
      <thead><tr><th>Date</th><th>Type</th><th>Symbol</th><th class="num">Shares</th><th class="num">Amount</th><th class="num">Comm.</th><th class="num">CAD rate</th>${open ? '' : '<th>Why</th>'}</tr></thead>
      <tbody>${list.map((r) => `<tr>
        <td class="date">${r.tradeDate || ''}</td><td>${r.type ? TYPE_LABEL[r.type] : esc(r.action || r.activity)}</td><td>${esc(r.ticker)}</td>
        <td class="num">${r.qty ? fmtQty(r.qty) : ''}</td><td class="num">${r.grossCents != null ? fmtCur(r.grossCents, r.currency) : ''}</td><td class="num">${r.commissionCents != null ? fmtCur(r.commissionCents, r.currency) : ''}</td><td class="num">${r.fxRate || ''}</td>
        ${open ? '' : `<td class="small muted">${esc(r.reason || '')}</td>`}</tr>`).join('')}</tbody></table></div>`;
}

function viewImport() {
  const rows = state.importRows;
  if (!rows) {
    const broker = BROKERS.find((b) => b.id === new URLSearchParams(location.hash.split('?')[1] || '').get('broker')) || BROKERS[0];
    app.innerHTML = `
      <h1>Import transactions</h1>
      <div class="card stack">
        <div><label for="imp-broker">Broker</label>${brokerSelectHTML('imp-broker', broker.id)}</div>
        ${broker.ready ? `
        <ol class="small">
          <li>In Questrade, open <strong>Reports, then Account activity</strong>, choose the accounts and date range, and export to Excel.</li>
          <li>Choose that file here (.xlsx, or .csv if you saved it that way). You'll see a preview before anything is saved.</li>
        </ol>
        <label for="qf">Questrade activity export</label>
        <input type="file" id="qf" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv">
        <div id="ierr" role="alert"></div>
        <p class="small muted">The file is read in your browser and never uploaded. Buys, sells and DRIP purchases in CAD are imported. Return of capital and reinvested (phantom) distributions aren't in this export: add them by hand from your T3 slips.</p>` : `
        <div class="alert warn"><strong>${esc(broker.name)} import is coming soon.</strong> For now, add an opening balance for each holding and enter new trades by hand.</div>
        <div><a class="btn" href="#/add">Add a transaction</a></div>`}
      </div>`;
    document.getElementById('imp-broker').onchange = (e) => { location.hash = `#/import?broker=${e.target.value}`; };
    if (!broker.ready) return;
    document.getElementById('qf').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const showErr = (m) => { document.getElementById('ierr').innerHTML = `<div class="alert bad">${esc(m)}</div>`; };
      const ext = file.name.toLowerCase().split('.').pop();
      let res;
      try {
        if (ext === 'xlsx') res = parseQuestradeRows(await readXlsx(await file.arrayBuffer()));
        else if (ext === 'csv') res = parseQuestrade(await file.text());
        else if (ext === 'pdf') return showErr('PDF statements can\'t be imported. Use the Excel export from Reports, then Account activity.');
        else if (ext === 'xls') return showErr('This is the older .xls format. Open it in Excel and save as .xlsx or .csv, then try again.');
        else return showErr('Choose an .xlsx or .csv file.');
      } catch (err) { return showErr(err.message || 'Could not read this file.'); }
      if (res.error) { document.getElementById('ierr').innerHTML = `<div class="alert bad">${esc(res.error)}</div>`; return; }
      markDuplicates(res.rows, state.data.transactions.map((t) => t.importHash).filter(Boolean));
      const foreign = res.rows.filter((r) => r.status === 'new' && r.currency !== 'CAD');
      if (foreign.length) {
        document.getElementById('ierr').innerHTML = '<p class="small muted">Getting Bank of Canada exchange rates…</p>';
        try { await fillRates(foreign); } catch { /* rows without a rate are flagged below */ }
        for (const r of foreign) if (!r.fxRate) { r.status = 'skipped'; r.reason = 'No exchange rate found. Try again online, or add this trade by hand.'; }
      }
      state.importRows = res.rows;
      viewImport();
    };
    return;
  }
  const nNew = rows.filter((r) => r.status === 'new').length;
  const counts = { new: nNew, duplicate: rows.filter((r) => r.status === 'duplicate').length, skipped: rows.filter((r) => r.status === 'skipped').length };
  const acctNums = [...new Set(rows.filter((r) => r.status === 'new').map((r) => r.accountNumber))];
  const existing = (num) => state.data.accounts.find((a) => a.externalId === num);
  app.innerHTML = `
    <h1>Import preview</h1>
    <div class="card import-bar">
      <p><strong>${counts.new} trade${counts.new === 1 ? '' : 's'} ready to import.</strong> <span class="muted">${counts.duplicate ? `${counts.duplicate} already imported. ` : ''}${counts.skipped} other rows (dividends, interest, fees) don't affect ACB.</span></p>
      <div class="row"><button id="doimport" ${nNew ? '' : 'disabled'}>Import ${nNew} transaction${nNew === 1 ? '' : 's'}</button><button class="secondary" id="cancelimp">Choose another file</button></div>
    </div>
    ${acctNums.length ? `<div class="card stack"><strong>Accounts</strong>${acctNums.map((n) => {
      const ex = existing(n); const r = rows.find((x) => x.accountNumber === n);
      return `<div class="grid2"><div><label>Account ${esc(n)} name</label><input data-acctname="${esc(n)}" value="${esc(ex ? ex.name : `Questrade ${n.slice(-4)}`)}" ${ex ? 'disabled' : ''}></div>
        <div><label>Type</label><select data-accttype="${esc(n)}" ${ex ? 'disabled' : ''}>${Object.entries(ACCT_LABEL).map(([k, v]) => `<option value="${k}" ${(ex ? ex.type : r.accountType) === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>`;
    }).join('')}</div>` : ''}
    <div id="ierr" role="alert"></div>
    ${rowsTable('Transactions to import', rows.filter((r) => r.status === 'new'), true)}
    ${rows.some((r) => r.status !== 'new') ? `<details class="card"><summary><strong>${counts.skipped + counts.duplicate} rows not imported</strong> <span class="muted small">(dividends, interest, fees, FX and rows already imported: none of these change ACB)</span></summary>
      ${rowsTable('', rows.filter((r) => r.status !== 'new'), false)}</details>` : ''}`;
  document.getElementById('cancelimp').onclick = () => { state.importRows = null; viewImport(); };
  document.getElementById('doimport').onclick = async () => {
    const btn = document.getElementById('doimport');
    btn.disabled = true; btn.textContent = 'Importing…';
    try { await doImport(); } catch (err) {
      console.error(err);
      btn.disabled = false; btn.textContent = 'Try again';
      document.getElementById('ierr').innerHTML = `<div class="alert bad"><strong>The import didn't save.</strong> ${esc(err && err.message || String(err))}</div>`;
    }
  };
  async function doImport() {
    const accounts = [...state.data.accounts];
    const newAccounts = [];
    for (const n of acctNums) {
      if (existing(n)) continue;
      const a = { id: uid(), externalId: n, broker: 'Questrade', name: document.querySelector(`[data-acctname="${CSS.escape(n)}"]`).value.trim() || `Questrade ${n}`, type: document.querySelector(`[data-accttype="${CSS.escape(n)}"]`).value };
      newAccounts.push(a); accounts.push(a);
    }
    const securities = [...state.data.securities];
    const newSecs = [];
    const txs = [];
    let seq = Date.now();
    for (const r of rows.filter((x) => x.status === 'new')) {
      let s = securities.find((x) => x.ticker === r.ticker && (x.exchange || '') === (r.exchange || ''))
        || securities.find((x) => x.ticker === r.ticker && !x.exchange);
      if (!s) { s = { id: uid(), ticker: r.ticker, exchange: r.exchange, name: r.description }; securities.push(s); newSecs.push(s); }
      const a = accounts.find((x) => x.externalId === r.accountNumber);
      txs.push({ id: uid(), seq: seq++, type: r.type, accountId: a.id, securityId: s.id, tradeDate: r.tradeDate, settleDate: r.settleDate,
        qty: r.qty, grossCents: r.grossCents, commissionCents: r.commissionCents, source: 'import', importHash: r.importHash, note: r.description,
        ...(r.currency !== 'CAD' ? { currency: r.currency, fxRate: r.fxRate } : {}) });
    }
    const check = computeLedger({ accounts, securities, transactions: [...state.data.transactions, ...txs] });
    if (check.errors.length) {
      document.getElementById('ierr').innerHTML = `<div class="alert warn"><strong>Imported with ${check.errors.length} problem(s).</strong> Usually this means shares bought before the export's date range. Add an opening balance for them.</div>`;
    }
    await putMany('accounts', newAccounts);
    await putMany('securities', newSecs);
    await putMany('transactions', txs);
    await setSetting('changeCount', (state.data.settings.changeCount || 0) + txs.length);
    try { await navigator.storage?.persist?.(); } catch { /* optional */ }
    state.importRows = null;
    await refresh();
    if (state.data.transactions.length === 0) throw new Error('The browser did not keep the saved data. Check that this site is allowed to save data (Chrome: Settings, Privacy and security, Site settings, On-device site data).');
    location.hash = '#/';
  }
}

// ---------- reports ----------
function viewReports() {
  const years = [...new Set(state.ledger.dispositions.map((d) => d.year))];
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const current = yearOf(today());
  if (!years.includes(current)) years.push(current);
  years.sort((a, b) => b - a);
  const year = Number(query.get('y')) || years[0];
  const rate = inclusionRate(year);
  const rep = yearReport(state.ledger, year, rate);
  const desc = (d) => d.kind === 'NEGATIVE_ACB' ? `${groupName(d.groupKey)} (ACB below zero)` : `${fmtQty(d.qty)} ${groupName(d.groupKey)}${d.currency && d.currency !== 'CAD' ? ` (${d.currency})` : ''}`;
  app.innerHTML = `
    <div class="split noprint"><h1>Capital gains</h1>
      <select id="yr" style="width:auto">${years.map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
    <div class="printonly"><h1>Capital gains and losses, ${year}</h1><p>Publicly traded shares, mutual fund units and other shares (Schedule 3). Prepared ${today()}.</p></div>
    <dl class="kv card">
      <div><dt>Net gain (loss)</dt><dd>${gainCell(rep.totals.netGainCents)}</dd></div>
      <div><dt>Taxable at ${Math.round(rate * 100)}%</dt><dd>${gainCell(rep.totals.taxableCents)}</dd></div>
      <div><dt>Dispositions</dt><dd>${rep.rows.length}</dd></div>
      <div><dt>Superficial losses denied</dt><dd>${fmtMoney(rep.totals.deniedCents)}</dd></div>
    </dl>
    ${rep.rows.length ? `
    <div class="card tight scroll"><table>
      <thead><tr><th>Number and description</th><th>Settled</th><th class="num">Proceeds</th><th class="num">ACB</th><th class="num">Outlays</th><th class="num">Gain (loss)</th></tr></thead>
      <tbody>${rep.rows.map((d) => `<tr><td>${esc(desc(d))}${d.deniedCents ? ` <span class="chip flag">${fmtMoney(d.deniedCents)} denied</span>` : ''}
        <details class="explain noprint"><summary>How</summary><p>${esc(d.explanation)}</p></details></td>
        <td class="date">${d.date}</td><td class="num">${fmtMoney(d.proceedsCents)}</td><td class="num">${fmtMoney(d.acbCents)}</td><td class="num">${fmtMoney(d.outlaysCents)}</td><td>${gainCell(d.gainCents)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="num">${fmtMoney(rep.totals.proceedsCents)}</td><td class="num">${fmtMoney(rep.totals.acbCents)}</td><td class="num">${fmtMoney(rep.totals.outlaysCents)}</td><td>${gainCell(rep.totals.netGainCents)}</td></tr></tfoot>
    </table></div>
    <p class="small muted">All amounts in CAD. US-dollar trades are converted at the Bank of Canada rate on each settlement date. Gain (loss) is after any superficial-loss adjustment.</p>
    <div class="row noprint"><button id="csv">Export CSV</button><button class="secondary" id="printbtn">Print or save as PDF</button></div>`
    : '<div class="card"><p class="muted">No dispositions settled in this year.</p></div>'}
    ${disclaimer()}`;
  document.getElementById('yr').onchange = (e) => { location.hash = `#/reports?y=${e.target.value}`; };
  const printBtn = document.getElementById('printbtn');
  if (printBtn) printBtn.onclick = () => window.print();
  const csvBtn = document.getElementById('csv');
  if (csvBtn) csvBtn.onclick = () => {
    const c = (x) => (x / 100).toFixed(2);
    const lines = [['Description', 'Settlement date', 'Trade date', 'Account', 'Proceeds (CAD)', 'ACB (CAD)', 'Outlays (CAD)', 'Gain (loss) (CAD)', 'Superficial loss denied', 'Currency', 'Proceeds in currency', 'Exchange rate', 'Calculation'],
      ...rep.rows.map((d) => [desc(d), d.date, d.tradeDate || '', acct(d.accountId)?.name || '', c(d.proceedsCents), c(d.acbCents), c(d.outlaysCents), c(d.gainCents), c(d.deniedCents), d.currency || 'CAD', d.proceedsForeignCents != null ? c(d.proceedsForeignCents) : '', d.fxRate || 1, d.explanation]),
      ['Total', '', '', '', c(rep.totals.proceedsCents), c(rep.totals.acbCents), c(rep.totals.outlaysCents), c(rep.totals.netGainCents), c(rep.totals.deniedCents), '', '', '', ''],
      [`Taxable at ${rate * 100}%`, '', '', '', '', '', '', c(rep.totals.taxableCents), '', '', '', '', ''],
      ['For record-keeping only; not tax advice.']];
    download(`capital-gains-${year}.csv`, toCSV(lines), 'text/csv');
  };
}

// ---------- settings ----------
function accountFormHTML() {
  return `<form id="af" class="stack">
    <div class="grid2"><div><label for="a-name">Account name</label><input id="a-name" placeholder="Questrade margin" required></div>
    <div><label for="a-type">Type</label><select id="a-type">${Object.entries(ACCT_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div></div>
    <button type="submit">Add account</button></form>`;
}
function bindAccountForm(after) {
  document.getElementById('af').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('a-name').value.trim();
    if (!name) return;
    await put('accounts', { id: uid(), name, broker: '', type: document.getElementById('a-type').value });
    await noteChange();
    after();
  };
}

function viewSettings() {
  const { accounts, securities, settings } = state.data;
  const used = (aid) => state.data.transactions.some((t) => t.accountId === aid);
  const rates = settings.inclusionRates || {};
  app.innerHTML = `
    <h1>Settings</h1>
    <h2>Accounts</h2>
    <div class="card stack">
      ${accounts.length ? `<table><tbody>${accounts.map((a) => `<tr><td>${esc(a.name)}<div class="small muted">${ACCT_LABEL[a.type]}${REGISTERED.has(a.type) ? ': counted for superficial losses only' : ''}</div></td>
        <td class="num">${used(a.id) ? '<span class="small muted">in use</span>' : `<button class="link" data-delacct="${a.id}">Remove</button>`}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No accounts yet.</p>'}
      ${accountFormHTML()}
    </div>
    <h2>Identical securities</h2>
    <div class="card stack">
      <p class="small muted">CRA pools identical property. Link two tickers only if they are the same security (for example, the same fund listed twice). Different ETFs tracking the same index are usually not identical.</p>
      ${securities.length ? `<table><tbody>${securities.map((s) => `<tr><td><strong>${esc(s.ticker)}</strong><div class="small muted">${esc(s.name || '')}</div></td>
        <td><select data-ident="${s.id}" aria-label="Same security as"><option value="">Not linked</option>${securities.filter((o) => o.id !== s.id && !o.identicalGroupId).map((o) => `<option value="${o.id}" ${s.identicalGroupId === o.id ? 'selected' : ''}>Same as ${esc(o.ticker)}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No securities yet.</p>'}
    </div>
    <h2>Inclusion rate</h2>
    <div class="card stack">
      <p class="small muted">The share of a net capital gain that is taxable. 50% applies unless you change it for a year.</p>
      <div class="row"><div class="grow"><label for="ir-y">Year</label><input id="ir-y" inputmode="numeric" value="${yearOf(today())}"></div>
      <div class="grow"><label for="ir-r">Rate (%)</label><input id="ir-r" inputmode="decimal" value="${(inclusionRate(yearOf(today())) * 100)}"></div>
      <div style="align-self:end"><button id="ir-save">Save</button></div></div>
      ${Object.keys(rates).length ? `<p class="small">Custom: ${Object.entries(rates).map(([y, r]) => `${y}: ${r * 100}%`).join(', ')}</p>` : ''}
    </div>
    <h2>Backup</h2>
    <div class="card stack">
      <p class="small">Your records exist only in this browser on this device. Back up to an encrypted file and keep it somewhere safe, like your cloud drive. ${settings.lastBackupAt ? `Last backup: ${new Date(settings.lastBackupAt).toLocaleDateString('en-CA')}.` : 'No backup yet.'}</p>
      <form id="bk" class="stack"><div class="grid2"><div><label for="bk-p">Passphrase</label><input type="password" id="bk-p" autocomplete="new-password" minlength="8" required></div>
        <div><label for="bk-p2">Repeat passphrase</label><input type="password" id="bk-p2" autocomplete="new-password" required></div></div>
        <p class="small muted">If you forget the passphrase, the backup can't be opened. Nobody can recover it.</p>
        <button type="submit">Download encrypted backup</button></form>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <form id="rs" class="stack"><label for="rs-f">Restore from a backup file <span class="hint">replaces everything on this device</span></label><input type="file" id="rs-f" accept=".json,.acbbackup,application/json" required>
        <label for="rs-p">Passphrase</label><input type="password" id="rs-p" required>
        <button type="submit" class="secondary">Restore</button></form>
      <div id="bkmsg" role="status"></div>
    </div>
    <h2>This device</h2>
    <div class="card small" id="diag">
      <div>Saved here: <strong>${state.data.transactions.length}</strong> transactions, ${state.data.accounts.length} accounts, ${state.data.securities.length} securities</div>
      <div>App version: ${APP_VERSION}</div>
      <div id="diag-storage">Storage: checking…</div>
    </div>
    <h2>Privacy</h2>
    <div class="card"><p class="small">No account, no server database, no tracking cookies. Your data is stored in this browser (IndexedDB) and is never sent anywhere. We use privacy-friendly Cloudflare Web Analytics for page counts only.</p>
      <button class="danger" id="wipe">Erase all data on this device</button></div>
    ${disclaimer()}`;

  bindAccountForm(refresh);
  (async () => {
    const el = document.getElementById('diag-storage');
    try {
      const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
      const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
      el.textContent = `Storage: working${persisted ? ', protected from automatic clearing' : ''}${est ? ` (${Math.round(est.usage / 1024)} KB used)` : ''}`;
    } catch (e) { el.textContent = `Storage: problem (${e.message})`; }
  })();
  app.querySelectorAll('[data-delacct]').forEach((b) => { b.onclick = async () => { await del('accounts', b.dataset.delacct); await refresh(); }; });
  app.querySelectorAll('[data-ident]').forEach((sel) => {
    sel.onchange = async () => {
      const s = sec(sel.dataset.ident);
      if (securities.some((o) => o.identicalGroupId === s.id) && sel.value) { alert(`Other tickers are already linked to ${s.ticker}. Unlink them first.`); sel.value = ''; return; }
      await put('securities', { ...s, identicalGroupId: sel.value || undefined });
      await noteChange(); await refresh();
    };
  });
  document.getElementById('ir-save').onclick = async () => {
    const y = Number(document.getElementById('ir-y').value), r = Number(document.getElementById('ir-r').value) / 100;
    if (!(y > 1971 && r >= 0 && r <= 1)) return;
    await setSetting('inclusionRates', { ...rates, [y]: r }); await refresh();
  };
  const msg = (cls, t) => { document.getElementById('bkmsg').innerHTML = `<div class="alert ${cls}">${esc(t)}</div>`; };
  document.getElementById('bk').onsubmit = async (e) => {
    e.preventDefault();
    const p = document.getElementById('bk-p').value, p2 = document.getElementById('bk-p2').value;
    if (p.length < 8) return msg('bad', 'Use a passphrase of at least 8 characters.');
    if (p !== p2) return msg('bad', 'The passphrases do not match.');
    const { settings: st, ...rest } = state.data;
    const { changeCount, lastBackupAt, ...keep } = st;
    download(`acb-tracker-backup-${today()}.json`, await encryptBackup({ ...rest, settings: keep, exportedAt: new Date().toISOString() }, p), 'application/json');
    await setSetting('lastBackupAt', new Date().toISOString());
    await setSetting('changeCount', 0);
    await refresh();
    msg('good', 'Backup downloaded.');
  };
  document.getElementById('rs').onsubmit = async (e) => {
    e.preventDefault();
    const file = document.getElementById('rs-f').files[0];
    if (!file) return;
    try {
      const data = await decryptBackup(await file.text(), document.getElementById('rs-p').value);
      if (!confirm(`Replace everything on this device with the backup (${data.transactions.length} transactions)?`)) return;
      await replaceAll({ ...data, settings: { ...data.settings, lastBackupAt: new Date().toISOString(), changeCount: 0 } });
      await refresh();
      location.hash = '#/';
    } catch (err) { msg('bad', err.message); }
  };
  document.getElementById('wipe').onclick = async () => {
    if (!confirm('Erase all accounts, securities and transactions on this device? This cannot be undone.')) return;
    await replaceAll({}); state.importRows = null; await refresh(); location.hash = '#/';
  };
}

const disclaimer = () => `<p class="disclaimer">For record-keeping only; not tax advice. Check results against your broker statements and T-slips, and talk to a tax professional about your situation.</p>`;

// ---------- sample data ----------
async function loadSample() {
  const a1 = { id: uid(), name: 'Questrade margin', broker: 'Questrade', type: 'NONREG' };
  const a2 = { id: uid(), name: 'TD Direct cash', broker: 'TD', type: 'NONREG' };
  const a3 = { id: uid(), name: 'Questrade TFSA', broker: 'Questrade', type: 'TFSA' };
  const x = { id: uid(), ticker: 'XEQT', exchange: 'TSX', name: 'iShares Core Equity ETF Portfolio' };
  const v = { id: uid(), ticker: 'VFV', exchange: 'TSX', name: 'Vanguard S&P 500 Index ETF' };
  const z = { id: uid(), ticker: 'ZAG', exchange: 'TSX', name: 'BMO Aggregate Bond Index ETF' };
  const us = { id: uid(), ticker: 'AAPL', exchange: 'US', name: 'Apple Inc.' };
  let seq = 1;
  const t = (type, acctObj, s, date, o = {}) => ({ id: uid(), seq: seq++, type, accountId: acctObj ? acctObj.id : null, securityId: s.id, tradeDate: date, settleDate: o.settle || (type === 'BUY' || type === 'SELL' ? defaultSettlementDate(date) : date), commissionCents: 0, source: 'manual', ...o });
  const b = (acctObj, s, date, q, p, c = 0) => t('BUY', acctObj, s, date, { qty: q * QTY, grossCents: Math.round(q * p * 100), commissionCents: Math.round(c * 100) });
  const sl = (acctObj, s, date, q, p, c = 0) => t('SELL', acctObj, s, date, { qty: q * QTY, grossCents: Math.round(q * p * 100), commissionCents: Math.round(c * 100) });
  const txs = [
    b(a1, x, '2024-03-04', 200, 27.10, 4.95), b(a2, x, '2024-09-16', 150, 30.25, 9.99),
    t('REINVESTED_DIST', a1, x, '2024-12-31', { amountCents: 1840 }), t('ROC', a1, x, '2024-12-31', { amountCents: 610 }),
    sl(a1, x, '2025-06-10', 100, 33.80, 4.95),
    b(a1, v, '2025-01-20', 40, 152.00, 4.95), sl(a1, v, '2025-04-08', 40, 128.40, 4.95), b(a3, v, '2025-04-22', 40, 134.10),
    b(a2, z, '2025-02-03', 300, 13.95, 9.99), sl(a2, z, '2026-03-16', 100, 14.40, 9.99),
    { ...b(a1, us, '2024-08-06', 20, 207.50, 4.95), currency: 'USD', fxRate: 1.3776 },
    { ...b(a1, us, '2025-03-11', 10, 220.80, 4.95), currency: 'USD', fxRate: 1.4420 },
    { ...sl(a1, us, '2026-02-10', 15, 268.20, 4.95), currency: 'USD', fxRate: 1.3655 },
  ];
  await putMany('accounts', [a1, a2, a3]);
  await putMany('securities', [x, v, z, us]);
  await putMany('transactions', txs);
  await refresh();
}

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js');
refresh().catch((e) => {
  app.innerHTML = `<div class="alert bad"><strong>This browser isn't letting the app save data.</strong> ${esc(e && e.message || e)}. In Chrome, check Settings, Privacy and security, Site settings, On-device site data, and that this isn't a private window.</div>`;
});
