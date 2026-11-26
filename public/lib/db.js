// IndexedDB storage. Nothing leaves the device.
const DB_NAME = 'acb-tracker';
const STORES = ['accounts', 'securities', 'transactions', 'settings'];
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function getAll(store) {
  const db = await open();
  return req2p(db.transaction(store).objectStore(store).getAll());
}

export function put(store, obj) {
  return tx([store], 'readwrite', (t) => { t.objectStore(store).put(obj); });
}

export function putMany(store, list) {
  return tx([store], 'readwrite', (t) => { const s = t.objectStore(store); for (const o of list) s.put(o); });
}

export function del(store, id) {
  return tx([store], 'readwrite', (t) => { t.objectStore(store).delete(id); });
}

export async function loadAll() {
  const [accounts, securities, transactions, settingsRows] = await Promise.all(STORES.map(getAll));
  const settings = Object.fromEntries(settingsRows.map((r) => [r.id, r.value]));
  return { accounts, securities, transactions, settings };
}

export function setSetting(id, value) {
  return put('settings', { id, value });
}

export function replaceAll(data) {
  return tx(STORES, 'readwrite', (t) => {
    for (const s of STORES) t.objectStore(s).clear();
    for (const a of data.accounts || []) t.objectStore('accounts').put(a);
    for (const s of data.securities || []) t.objectStore('securities').put(s);
    for (const x of data.transactions || []) t.objectStore('transactions').put(x);
    for (const [id, value] of Object.entries(data.settings || {})) t.objectStore('settings').put({ id, value });
  });
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
