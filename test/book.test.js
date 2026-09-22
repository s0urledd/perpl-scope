import test from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '../src/exchange.js';
import { readDepth, depthWithin, absorption } from '../src/book.js';
import { marketMetrics, stressAt, adlQueue } from '../src/metrics.js';
import * as m from '../src/math.js';
import { createFakeExchange, EXCHANGE } from './helpers/fake-exchange.js';

const u = m.units(1, 5, 6);

test('depth walk reads levels per side within range and flags truncation', async () => {
  const fake = createFakeExchange();
  fake.setBook(1, [[999000n, 100000n], [995000n, 50000n], [900000n, 1n], [700000n, 5n]], [[1001000n, 20000n], [1010000n, 70000n]]);
  const reader = createReader({ rpc: fake.rpc, exchange: EXCHANGE });
  const depth = await readDepth(reader, [{ id: 1, markPNS: 1000000n, basePricePNS: 0n, maxBidPriceONS: 999000n, minAskPriceONS: 1001000n }], 1000n, { levels: 10, rangeBps: 1500n });
  const book = depth.get(1);
  assert.deepEqual(book.bids.map(l => l.pricePNS), [999000n, 995000n, 900000n]); // 700000 is beyond 15 %
  assert.deepEqual(book.asks.map(l => l.pricePNS), [1001000n, 1010000n]);
  assert.equal(book.truncated.bids, false);
  const within1 = depthWithin(book.bids, 'bids', 1000000n, 100n, u);
  assert.equal(within1.lotLNS, 150000n);
  assert.equal(within1.notionalCNS, m.notionalCNS(999000n, 100000n, u) + m.notionalCNS(995000n, 50000n, u));
  assert.equal(depthWithin(book.asks, 'asks', 1000000n, 5n, u).lotLNS, 0n); // 1001000 is 10 bps above the mark
  // Truncation when the walk limit is hit with levels still in range
  const short = await readDepth(reader, [{ id: 1, markPNS: 1000000n, basePricePNS: 0n, maxBidPriceONS: 999000n, minAskPriceONS: 1001000n }], 1000n, { levels: 1, rangeBps: 1500n });
  assert.equal(short.get(1).truncated.bids, true);
});

test('absorption compares liquidation demand with resting depth per side', () => {
  const market = { id: 1, symbol: 'BTC', markPNS: 1000000n, oraclePNS: 1000000n, maintHdths: 2500n, initHdths: 1500n, insuranceBalanceCNS: 1000000000n, positionBalanceCNS: 0n, longOpenInterestLNS: 100000n, shortOpenInterestLNS: 100000n, oiMaxLNS: 30000000n,
    book: { bids: [{ pricePNS: 950000n, lotLNS: 50000n, expiringLNS: 0n }], asks: [{ pricePNS: 1050000n, lotLNS: 200000n, expiringLNS: 0n }], truncated: { bids: false, asks: false }, block: 1n, at: 0 } };
  const position = (accountId, positionType, depositCNS) => ({ accountId, positionType, pricePNS: 1000000n, lotLNS: 100000n, depositCNS, premiumPnlCNS: 0n, priceResiduePNSQ16: 0n, entryBlock: 1n, deltaPnlCNS: 0n, pnlCNS: 0n, readMarkPNS: 1000000n });
  const x = marketMetrics(market, [position(1n, 0, 10000000000n), position(2n, 1, 10000000000n)], u); // both liquidate at 6 %
  const row = x.liquidity.absorption.find(r => r.bps === 1000n);
  assert.equal(row.long.demandCNS, 100000000000n);
  assert.equal(row.long.depthCNS, m.notionalCNS(950000n, 50000n, u));
  assert.equal(row.long.coverageBps, 4750n); // 47.5 % of the long demand is absorbed by bids
  assert.equal(row.short.coverageBps, 21000n);
  assert.equal(x.liquidity.depth.bids[500n].levels, 1);
  assert.equal(x.liquidity.depth.bids[100n].levels, 0);
  const stress = stressAt(x.positions, market, u, -1000n);
  assert.equal(stress.side, 'long');
  assert.equal(stress.count, 1);
  assert.equal(stress.absorptionBps, 4750n);
  assert.equal(stress.hit[0].accountId, 1n);
  assert.equal(stressAt(x.positions, market, u, 300n).count, 0);
  assert.equal(absorption(x.ladder, null, market.markPNS, u), null);
});

test('ADL queue ranks profitable opposing positions by return on deposit', () => {
  const market = { id: 1, symbol: 'BTC', markPNS: 1100000n, oraclePNS: 1100000n, maintHdths: 2500n, initHdths: 1500n, insuranceBalanceCNS: 0n, positionBalanceCNS: 0n, longOpenInterestLNS: 300000n, shortOpenInterestLNS: 300000n };
  const position = (accountId, positionType, pricePNS, lotLNS, depositCNS) => ({ accountId, positionType, pricePNS, lotLNS, depositCNS, premiumPnlCNS: 0n, priceResiduePNSQ16: 0n, entryBlock: 1n, deltaPnlCNS: 0n, pnlCNS: 0n });
  const x = marketMetrics(market, [position(1n, 0, 1000000n, 100000n, 20000000000n), position(2n, 0, 1000000n, 100000n, 5000000000n), position(3n, 0, 1200000n, 100000n, 5000000000n), position(4n, 1, 1000000n, 300000n, 90000000000n)], u);
  assert.deepEqual(x.adl.long.map(p => p.accountId), [2n, 1n]); // account 3 is losing and excluded
  assert.equal(x.adl.long[0].roeBps, 20000n);
  assert.equal(x.adl.short.length, 0);
  assert.equal(adlQueue([]).long.length, 0);
});
