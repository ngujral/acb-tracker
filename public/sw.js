// Offline support. Network first, so a new deploy is used right away;
// the saved copy is only a fallback when offline.
// Notes:
//  - Page loads (mode "navigate") are fetched as-is: adding fetch options to a navigation
//    request throws, which previously forced every launch onto the stale saved copy.
//  - Only "/" is saved for pages (never "/index.html", which the host redirects), and saved
//    responses are rebuilt without redirect info: Safari refuses to show a redirected
//    response from a service worker, which broke relaunches of the iPhone home-screen app.
const VERSION = 'acb-v12';
const ASSETS = ['/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg', '/favicon.ico',
  '/lib/engine.js', '/lib/dates.js', '/lib/db.js', '/lib/csv.js', '/lib/questrade.js', '/lib/backup.js', '/lib/xlsx.js', '/lib/fx.js'];

async function clean(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const page = await fetch('/', { cache: 'no-cache' });
    if (page.ok) await cache.put('/', await clean(page));
    await Promise.all(ASSETS.map(async (u) => {
      const r = await fetch(u, { cache: 'no-cache' });
      if (r.ok) await cache.put(u, await clean(r));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && url.pathname === '/') (await caches.open(VERSION)).put('/', await clean(res.clone()));
        return res;
      } catch {
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    try {
      const res = await fetch(url.href, { cache: 'no-cache' });
      if (res.ok) (await caches.open(VERSION)).put(url.pathname, await clean(res.clone()));
      return res;
    } catch {
      return (await caches.match(url.pathname)) || Response.error();
    }
  })());
});
