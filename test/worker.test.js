import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.caches = { default: { match: async (k) => store.get(k.url)?.clone(), put: async (k, v) => { store.set(k.url, v); } } };
let calls = [];
globalThis.fetch = async (url) => {
  calls.push(url);
  return new Response(JSON.stringify({ observations: [
    { d: '2026-01-02', FXUSDCAD: { v: '1.3710' } },
    { d: '2026-01-05', FXUSDCAD: { v: '1.3801' } },
  ] }), { headers: { 'content-type': 'application/json' } });
};
const worker = (await import('../worker.js')).default;
const ctx = { waitUntil: (p) => p };
const env = { ASSETS: { fetch: async () => new Response('asset') } };

test('fx endpoint returns Bank of Canada rates and caches them', async () => {
  const r = await worker.fetch(new Request('https://x/api/fx?cur=USD&start=2026-01-03&end=2026-01-05'), env, ctx);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.rates['2026-01-05'], 1.3801);
  assert.match(calls[0], /FXUSDCAD\/json\?start_date=2025-12-27&end_date=2026-01-05/);
  await new Promise((res) => setTimeout(res, 0));
  await worker.fetch(new Request('https://x/api/fx?cur=USD&start=2026-01-03&end=2026-01-05'), env, ctx);
  assert.equal(calls.length, 1);
});

test('fx endpoint validates input', async () => {
  const r = await worker.fetch(new Request('https://x/api/fx?cur=US&start=bad'), env, ctx);
  assert.equal(r.status, 400);
});

test('other paths go to static assets', async () => {
  const r = await worker.fetch(new Request('https://x/index.html'), env, ctx);
  assert.equal(await r.text(), 'asset');
});

test('rateFrom falls back to the prior business day', async () => {
  const { rateFrom } = await import('../public/lib/fx.js');
  assert.deepEqual(rateFrom({ '2026-01-02': 1.371 }, '2026-01-04'), { rate: 1.371, date: '2026-01-02' });
});
