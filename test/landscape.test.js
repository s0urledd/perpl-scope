import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, createLandscape } from '../src/landscape.js';

const D = 'Derivatives';
const body = { protocols: [
  { name: 'Big Perps', total24h: 900, chains: ['Arbitrum'], category: D },
  { name: 'Perpl', total24h: 60, chains: ['Monad'], category: D },
  { name: 'Other Monad', total24h: 40, chains: ['Monad'], category: D },
  { name: 'Dead', total24h: 0, chains: ['Monad'], category: D },
  { name: 'Broken', total24h: null, category: D },
  { name: 'Front-end on Big Perps', total24h: 500, chains: ['Arbitrum'], category: 'Interface' },
  { name: 'Event contracts', total24h: 700, chains: ['Off Chain'], category: 'Prediction Market' }
] };

test('ranks Perpl among venues and within its chain', () => {
  const s = summarize(body, { top: 2 });
  assert.equal(s.total_oi, 1000);
  assert.equal(s.venues, 3, 'zero and missing open interest, front-ends and prediction markets are left out');
  assert.deepEqual(s.perpl, { oi: 60, rank: 2, share_pct: 6, share_of_chain_pct: 60 });
  assert.equal(s.chain.total_oi, 100);
  assert.deepEqual(s.chain.venues.map(v => [v.name, v.self]), [['Perpl', true], ['Other Monad', false]]);
  assert.deepEqual(s.top.map(t => t.name), ['Big Perps', 'Perpl']);
  assert.throws(() => summarize({}), /LANDSCAPE_SHAPE/);
});

test('serves the cache, keeps the last good data through errors', async () => {
  let t = 0, calls = 0, fail = false;
  const fetcher = async () => { calls++; if (fail) return { ok: false, status: 502 }; return { ok: true, json: async () => body }; };
  const l = createLandscape({ fetcher, ttlMs: 1000, now: () => t });
  assert.equal((await l.get()).perpl.rank, 2);
  await l.get(); assert.equal(calls, 1, 'cached within the TTL');
  t = 2000; fail = true;
  const stale = await l.get();
  assert.equal(calls, 2); assert.equal(stale.perpl.rank, 2); assert.match(stale.error, /502/);
  const empty = createLandscape({ fetcher: async () => ({ ok: false, status: 402 }), now: () => 0 });
  await assert.rejects(empty.get(), /LANDSCAPE_UNAVAILABLE/);
});
