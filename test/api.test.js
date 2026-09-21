import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector, collectorOptions } from '../src/collector.js';
import { createApi } from '../src/api.js';
import { createReference } from '../src/reference.js';
import { createFakeExchange, EXCHANGE } from './helpers/fake-exchange.js';

const config = { url: 'https://example.invalid', chain: '143', exchange: EXCHANGE };

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'perpl-api-'));
  const webDir = join(dir, 'web'); await mkdir(webDir); await writeFile(join(webDir, 'index.html'), '<!doctype html><title>PerplScope</title>');
  const fake = createFakeExchange();
  fake.open(1, 5n, 0, 100000n, 10000000000n); fake.open(1, 6n, 1, 100000n, 3000000000n); fake.open(20, 7n, 0, 5000n); fake.open(20, 8n, 1, 5000n);
  fake.emit('PositionLiquidated', { perpId: 1n, posAccountId: 99n, positionType: 0, markPricePNS: 990000n, liqPricePNS: 989900n, liqLotLNS: 1000n, posLotLNS: 0n, deltaPnlCNS: -5000000n, fundingCNS: 0n, posAmountCNS: 1000n, posDepositCNS: 0n, accAmountCNS: 800n, accBalanceCNS: 1800n, onOrderBook: true }, 990n);
  const collector = createCollector({ config, options: { ...collectorOptions({ BACKFILL_BLOCKS: 100, FUNDING_HISTORY_EVENTS: 1 }), checkpointPath: join(dir, 'cp.json') }, rpc: fake.rpc });
  const reference = createReference({ fetcher: async () => new Response(JSON.stringify({ chain: { chain_id: 143 }, markets: [{ perpetual_id: 1, name: 'BTC', config: { is_open: true, price_decimals: 1, size_decimals: 5, initial_margin: 1500, maintenance_margin: 2500 }, state: { mrk: 1000000, oi: 100000, at: { b: 1000 } }, funding: { rate: -40, sum: -35673, feb: 999 } }] })) });
  await reference.refresh();
  const api = createApi({ collector, reference, webDir, version: 'test' });
  const server = createServer((req, res) => api.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  return { fake, collector, api, base, get: async path => { const r = await fetch(base + path); return { status: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; } };
}

test('API reports syncing before bootstrap and serves snapshot-pinned data after', async t => {
  const { collector, get } = await setup(t);
  const early = await get('/api/v1/overview');
  assert.equal(early.status, 503);
  assert.equal(early.body.snapshot.status, 'syncing');
  assert.equal((await get('/api/v1/health')).status, 200);
  await collector.bootstrap('test');
  await collector.backfillHistory();
  const overview = await get('/api/v1/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.headers.get('x-snapshot-block'), '1000');
  assert.equal(overview.body.snapshot.status, 'fresh');
  assert.equal(overview.body.totals.positions, 4);
  assert.equal(overview.body.totals.all_reconciled, true);
  assert.equal(overview.body.totals.total_notional, '210000.000000'); // 2 x 1 BTC at 100k + 2 x 0.05 ETH at 100k
  const btc = overview.body.markets.find(x => x.id === 1);
  assert.equal(btc.open_interest.reconciled, true);
  assert.equal(btc.margin.maintenance_margin_pct, 4);
  assert.equal(btc.funding.direction, 'shorts pay longs');
  assert.equal(btc.reference.found, true);
  assert.equal(btc.reference.marginFractionsMatch, true);
  assert.equal(btc.reference.fundingRateMatch, true);
});

test('market detail, positions, ladder, funding and liquidations endpoints', async t => {
  const { collector, get } = await setup(t);
  await collector.bootstrap('test');
  await collector.backfillHistory();
  const detail = await get('/api/v1/markets/1?limit=1');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.market.top_positions.length, 1);
  assert.equal(detail.body.market.ladder.length, 11);
  assert.ok(detail.body.market.liquidation_map.bins.length >= 1);
  assert.equal(detail.body.market.recent_liquidations.length, 1);
  assert.equal(detail.body.market.recent_liquidations[0].account_id, '99');
  const short = detail.body.market.top_positions[0];
  assert.equal(short.side, 'long');
  assert.equal(short.liquidation_price, '94000.0000000');
  const positions = await get('/api/v1/markets/1/positions?sort=risk&limit=10');
  assert.equal(positions.body.positions[0].account_id, '6'); // 3k deposit on 100k => closest to liquidation
  assert.equal((await get('/api/v1/markets/1/positions?sort=bogus')).status, 400);
  assert.equal((await get('/api/v1/markets/77')).status, 404);
  const ladder = await get('/api/v1/markets/1/ladder');
  assert.equal(ladder.body.ladder[0].shock_pct, 0.5);
  const funding = await get('/api/v1/markets/1/funding');
  assert.equal(funding.body.current.interval_blocks, '8571');
  const liquidations = await get('/api/v1/liquidations?market=1');
  assert.equal(liquidations.body.total, 1);
  const validation = await get('/api/v1/validation');
  assert.equal(validation.body.reconciliation.ok, true);
  assert.equal(validation.body.metrics.delta_pnl.status, 'validated');
  const reference = await get('/api/v1/reference');
  assert.equal(reference.body.enabled, true);
  const events = await get('/api/v1/events');
  assert.equal(events.status, 200);
});

test('static dashboard is served and traversal is rejected', async t => {
  const { get } = await setup(t);
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /PerplScope/);
  assert.equal((await get('/../package.json')).status, 404);
  assert.equal((await get('/nope.js')).status, 404);
  assert.equal((await get('/api/v1/nothing')).status, 404);
});
