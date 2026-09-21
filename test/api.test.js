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
  const collector = createCollector({ config, options: { ...collectorOptions({ BACKFILL_BLOCKS: 100, FUNDING_HISTORY_EVENTS: 1 }), checkpointPath: join(dir, 'cp.json'), indexPath: join(dir, 'index.json'), indexBlocks: 500n, indexBucketBlocks: 100n, indexLogRange: 100n }, rpc: fake.rpc });
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

test('stress, book, account lookup, series and CSV endpoints', async t => {
  const { fake, collector, get, base } = await setup(t);
  fake.setBook(1, [[990000n, 100000n], [960000n, 300000n]], [[1010000n, 100000n], [1040000n, 300000n]]);
  await collector.bootstrap('test');
  await collector.refreshBook(true);
  collector.sample();
  const stress = await get('/api/v1/markets/1/stress?move_pct=-10');
  assert.equal(stress.status, 200);
  assert.equal(stress.body.side, 'long');
  assert.equal(stress.body.liquidated.count, 1); // account 5: 10x long liquidates at 6 %
  assert.equal(stress.body.liquidity.levels, 2);
  assert.equal((await get('/api/v1/markets/1/stress?move_pct=0')).status, 400);
  assert.equal((await get('/api/v1/markets/1/stress?move_pct=abc')).status, 400);
  const book = await get('/api/v1/markets/1/book');
  assert.equal(book.status, 200);
  assert.equal(book.body.bids.length, 2);
  assert.equal(book.body.liquidity.depth.bids['5'].levels, 2);
  const summary = (await get('/api/v1/markets/1')).body.market;
  assert.equal(summary.liquidity.cover_at_10pct.long_pct > 0, true);
  assert.equal(summary.adl_queue.short.length, 0); // account 6 short sits at its entry price: zero PnL, excluded
  const account = await get('/api/v1/accounts/5');
  assert.equal(account.status, 200);
  assert.equal(account.body.positions.length, 1);
  assert.equal(account.body.closest_liquidation.symbol, 'BTC');
  const byAddress = await get('/api/v1/accounts/0x0000000000000000000000000000000000000005');
  assert.equal(byAddress.body.account.id, '5');
  assert.equal((await get('/api/v1/accounts/999999')).status, 404);
  assert.equal((await get('/api/v1/accounts/zz')).status, 400);
  const series = await get('/api/v1/series?hours=24');
  assert.equal(series.body.points.length, 1);
  assert.equal(series.body.points[0].positions, 4);
  const marketSeries = await get('/api/v1/series?market=1');
  assert.equal(marketSeries.body.points[0].bid_depth_2pct, '99000.000000');
  const csv = await fetch(base + '/api/v1/markets/1/positions?format=csv');
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  const text = await csv.text();
  assert.match(text.split('\r\n')[0], /^account_id,side,size/);
  assert.equal(text.trim().split('\r\n').length, 3);
  const liqCsv = await fetch(base + '/api/v1/liquidations?format=csv');
  assert.equal(liqCsv.headers.get('content-disposition')?.startsWith('attachment'), true);
});

test('audit fixes: address case, cached account record, csv headers, sort validation, headers', async t => {
  const { fake, collector, get, base } = await setup(t);
  fake.setBook(1, [[990000n, 100000n]], [[1010000n, 100000n]]);
  await collector.bootstrap('test');
  await collector.refreshBook(true);
  // Mixed-case (non-checksummed) addresses are accepted by lowercasing before ABI encoding.
  fake.state.accounts = 200n; // account 0xab = 171 exists in the fake
  const upper = await get('/api/v1/accounts/' + '0x00000000000000000000000000000000000000ab'.toUpperCase().replace('0X', '0x'));
  assert.equal(upper.status, 200);
  // Unknown accounts are cached as misses: a second lookup makes no further RPC call.
  await get('/api/v1/accounts/777777');
  const before = fake.stats.requests;
  assert.equal((await get('/api/v1/accounts/777777')).status, 404);
  assert.equal(fake.stats.requests, before);
  // Positions are rebuilt from the current snapshot even when the account record is cached.
  const first = await get('/api/v1/accounts/5');
  assert.equal(first.body.positions.length, 1);
  fake.advance(); fake.close(1, 5n);
  await collector.poll();
  const second = await get('/api/v1/accounts/5');
  assert.equal(second.body.positions.length, 0);
  assert.equal(second.body.account_read_block, first.body.account_read_block);
  // CSV keeps its header when there are no rows and escapes formula-leading cells.
  const empty = await fetch(base + '/api/v1/markets/20/positions?format=csv');
  assert.match((await empty.text()).split('\r\n')[0], /^account_id,side/);
  assert.equal((await fetch(base + '/api/v1/liquidations?format=csv')).headers.get('x-content-type-options'), 'nosniff');
  const { toCsv } = await import('../src/api.js');
  assert.equal(toCsv([{ a: '=SUM(1)', b: '-5.25', c: 'x,y' }]), "a,b,c\r\n'=SUM(1),-5.25,\"x,y\"\r\n");
  // Sort and side are validated against an allowlist.
  assert.equal((await get('/api/v1/markets/1/positions?sort=__proto__')).status, 400);
  assert.equal((await get('/api/v1/markets/1/positions?side=up')).status, 400);
  // Stress responses carry the block and decimals the dashboard needs; moves beyond the walked range have no depth.
  const stress = await get('/api/v1/markets/1/stress?move_pct=-30');
  assert.equal(stress.body.price_decimals, 1);
  assert.equal(stress.body.liquidity, null);
  const book = await get('/api/v1/markets/1/book');
  assert.equal(book.body.liquidity.absorption.find(r => r.shock_pct === 30).beyond_range, true);
  assert.equal(book.body.liquidity.absorption.find(r => r.shock_pct === 10).beyond_range, false);
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
});

test('stats windows, series, leaderboard, index status and wallet analytics', async t => {
  const { fake, collector, get } = await setup(t);
  fake.chain.head = 700n; fake.emit('CollateralDeposit', { accountId: 5n, amountCNS: 400000000n, balanceCNS: 400000000n }); fake.chain.head = 1000n;
  await collector.bootstrap('test');
  await collector.backfillIndex();
  fake.advance(); fake.emit('CollateralWithdrawal', { accountId: 5n, amountCNS: 100000000n, balanceCNS: 300000000n }); fake.close(1, 5n);
  await collector.poll();
  const stats = await get('/api/v1/stats?window=24h');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.window, '24h');
  assert.equal(stats.body.coverage.partial, true, 'the fake chain is younger than the window');
  assert.equal(stats.body.activity.opens, 4); assert.equal(stats.body.activity.closes, 1);
  assert.equal(stats.body.activity.active_traders, 5, 'four openers plus the liquidated account');
  assert.equal(stats.body.flows.deposits, '400.000000'); assert.equal(stats.body.flows.withdrawals, '100.000000'); assert.equal(stats.body.flows.net, '300.000000');
  assert.equal(stats.body.liquidations.count, 1);
  assert.equal(stats.body.current.tvl, '0.000000'); assert.equal(stats.body.current.accounts, '8');
  assert.equal(stats.body.current.withdrawal_limit.allowance, '250000.000000');
  assert.ok(stats.body.markets.length === 2 && stats.body.markets[0].skew.long_positions !== undefined);
  assert.equal(stats.body.activity.taker_buy, '0.000000', 'fake fills are not linked to takers');
  assert.equal(stats.body.venue.note.startsWith('Perpl API'), true);
  assert.equal((await get('/api/v1/stats?window=1y')).status, 400);
  const all = await get('/api/v1/stats?window=all');
  assert.equal(all.body.coverage.partial, true);
  const series = await get('/api/v1/stats/series?window=all');
  assert.equal(series.status, 200);
  assert.ok(series.body.points.length >= 5);
  assert.equal(series.body.points.at(-1).open_interest !== null, true, 'snapshot joined to the bucket');
  assert.equal(series.body.points.reduce((a, p) => a + p.liquidations, 0), 1);
  const market = await get('/api/v1/stats/series?window=all&market=1');
  assert.equal(market.body.market_id, 1); assert.equal(market.body.points.at(-1).mark, '100000.0');
  const board = await get('/api/v1/leaderboard?window=all&by=liquidated&limit=5');
  assert.equal(board.status, 200);
  assert.equal(board.body.rows[0].account_id, '99'); assert.equal(board.body.rows[0].liquidations, 1);
  assert.equal((await get('/api/v1/leaderboard?by=nope')).status, 400);
  const byFlow = await get('/api/v1/leaderboard?window=all&by=deposits');
  assert.equal(byFlow.body.rows[0].account_id, '5'); assert.equal(byFlow.body.rows[0].net_flow, '300.000000');
  const index = await get('/api/v1/index');
  assert.equal(index.body.backfill.done, true); assert.equal(index.body.covered_from_block, '500');
  const account = await get('/api/v1/accounts/5');
  assert.equal(account.status, 200);
  assert.equal(account.body.summary.deposits, '400.000000'); assert.equal(account.body.summary.withdrawals, '100.000000');
  assert.equal(account.body.history.length, 2, 'open and close');
  assert.equal(account.body.history[0].type, 'close'); assert.equal(account.body.history[0].symbol, 'BTC');
  assert.equal(account.body.performance.closed_trips, 1);
  assert.equal(account.body.trips[0].complete, true); assert.equal(account.body.flows.length, 2);
  assert.equal(typeof account.body.totals.account_value, 'string');
  assert.ok(Array.isArray(account.body.observations));
  const csv = await get('/api/v1/accounts/5/trades?format=csv');
  assert.equal(csv.status, 200);
  assert.equal(csv.body.split('\r\n')[0], 'block,timestamp,tx,type,role,market_id,symbol,side,price,size,notional,realized_pnl,delta_pnl,funding,fee,leverage');
  assert.equal(csv.body.split('\r\n').filter(Boolean).length, 3);
  const trades = await get('/api/v1/accounts/5/trades');
  assert.equal(trades.body.trades.length, 2);
});
