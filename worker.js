// Cloudflare Worker: serves the static app and one small API.
//   GET /api/fx?cur=USD&start=YYYY-MM-DD&end=YYYY-MM-DD
//   -> { cur, rates: { "YYYY-MM-DD": 1.3712, ... } }  (Bank of Canada daily rates, CAD per unit)
// Only dates go out, never user data. Responses are cached at the edge.

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function shift(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
});

async function fx(request, ctx) {
  const url = new URL(request.url);
  const cur = (url.searchParams.get('cur') || 'USD').toUpperCase();
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end') || start;
  if (!/^[A-Z]{3}$/.test(cur) || !ISO.test(start || '') || !ISO.test(end) || start > end) {
    return json({ error: 'Use ?cur=USD&start=YYYY-MM-DD&end=YYYY-MM-DD' }, 400);
  }
  if ((new Date(end) - new Date(start)) / 86400000 > 3700) return json({ error: 'Range too long (max ~10 years).' }, 400);

  const cache = caches.default;
  const key = new Request(`https://fx-cache/${cur}/${start}/${end}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  // Start a week early so a weekend or holiday at the start still has a prior rate.
  const series = `FX${cur}CAD`;
  const boc = `https://www.bankofcanada.ca/valet/observations/${series}/json?start_date=${shift(start, -7)}&end_date=${end}`;
  const res = await fetch(boc, { headers: { accept: 'application/json' } });
  if (!res.ok) return json({ error: `Bank of Canada returned ${res.status}` }, 502);
  const data = await res.json();
  const rates = {};
  for (const o of data.observations || []) {
    const v = o[series] && Number(o[series].v);
    if (o.d && v > 0) rates[o.d] = v;
  }
  const today = new Date().toISOString().slice(0, 10);
  const out = json({ cur, source: 'Bank of Canada', rates }, 200, {
    // Past rates never change; recent ranges may still gain today's rate.
    'cache-control': end < shift(today, -3) ? 'public, max-age=2592000' : 'public, max-age=3600',
  });
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/fx') {
      try { return await fx(request, ctx); } catch (e) { return json({ error: 'Rate lookup failed' }, 502); }
    }
    return env.ASSETS.fetch(request);
  },
};
