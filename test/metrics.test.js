import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/math.js';
import { marketMetrics, liquidationLadder, liquidationMap, concentration, exchangeTotals } from '../src/metrics.js';

// A synthetic BTC-like market: price 1 decimal, lot 5 decimals, AUSD 6.
const u = m.units(1, 5, 6);
const market = { id: 1, symbol: 'BTC', markPNS: 1000000n, oraclePNS: 1001000n, maintHdths: 2500n, initHdths: 1500n, insuranceBalanceCNS: 1000000000n, positionBalanceCNS: 0n, longOpenInterestLNS: 300000n, shortOpenInterestLNS: 300000n, oiMaxLNS: 30000000n };
const position = (accountId, positionType, pricePNS, lotLNS, depositCNS, premium = 0n) => ({ accountId, positionType, pricePNS, lotLNS, depositCNS, premiumPnlCNS: premium, priceResiduePNSQ16: 0n, entryBlock: 1n, deltaPnlCNS: m.deltaPnlCNS(positionType, pricePNS * m.Q16, market.markPNS, lotLNS, u), pnlCNS: 0n, readMarkPNS: market.markPNS });
const positions = [
  position(1n, 0, 1000000n, 100000n, 10000000000n), // long 1 BTC at 100k, 10x => liq 94k (600 bps)
  position(2n, 0, 1000000n, 200000n, 50000000000n), // long 2 BTC, 4x => liq 79k? deposit 50k, mmr 8k => liq = 100k + (8k-50k)/2 = 79k (2100 bps)
  position(3n, 1, 1000000n, 100000n, 10000000000n), // short 1 BTC 10x => liq 106k (600 bps)
  position(4n, 1, 1000000n, 200000n, 3000000000n)   // short 2 BTC 66x: mmr 8k, deposit 3k => liq = 100k - (8k-3k)/2 = 97.5k => already liquidatable
];

test('market metrics reconcile OI and classify positions', () => {
  const x = marketMetrics(market, positions, u);
  assert.equal(x.oi.reconciled, true);
  assert.equal(x.oi.longLNS, 300000n);
  assert.equal(x.oi.totalNotionalCNS, 600000000000n);
  assert.equal(x.long.count, 2);
  assert.equal(x.short.liquidatable, 1);
  const p4 = x.positions.find(p => p.accountId === 4n);
  assert.equal(p4.status, 'liquidatable');
  assert.equal(p4.liquidationMicroPNS, 975000n * m.MICRO);
  assert.equal(p4.liquidationDistanceBps, -250n);
  const p1 = x.positions.find(p => p.accountId === 1n);
  assert.equal(p1.liquidationDistanceBps, 600n);
  assert.equal(p1.leverageBps, 100000n);
  assert.equal(x.validation.pnlAgreement.agree, 4);
  // A stale contract value read at an older mark still agrees when checked at that mark.
  const stale = marketMetrics({ ...market, markPNS: 1100000n }, positions, u);
  assert.equal(stale.validation.pnlAgreement.agree, 4);
  assert.equal(marketMetrics(market, positions.map(p => ({ ...p, readMarkPNS: undefined })), u).validation.pnlAgreement.checked, 0);
  assert.equal(x.basisBps, -10n); // floor of -9.99
  assert.equal(x.oi.utilisationBps, 100n);
});

test('liquidation ladder accumulates exposure and shortfall by shock', () => {
  const enriched = marketMetrics(market, positions, u).positions;
  const ladder = liquidationLadder(enriched, market, u, [100n, 500n, 1000n, 3000n]);
  assert.equal(ladder[0].short.count, 1); // account 4 already past liquidation
  assert.equal(ladder[0].long.count, 0);
  assert.equal(ladder[1].long.count, 0); // 600 bps needed
  assert.equal(ladder[2].long.count, 1);
  assert.equal(ladder[2].short.count, 2);
  assert.equal(ladder[3].long.count, 2);
  assert.equal(ladder[2].long.pricePNS, 900000n);
  assert.equal(ladder[2].short.pricePNS, 1100000n);
  // At -30 % account 1 (bankrupt at 90k) is 10k underwater on 1 BTC at 70k: fmv = 10k + (70k-100k) = -20k
  assert.equal(ladder[3].long.shortfallCNS, 20000000000n + 0n + (50000000000n - 60000000000n < 0n ? 10000000000n : 0n));
  // Longs need a fall and shorts a rise: the row reports the worse direction.
  assert.equal(ladder[3].worstShortfallCNS, ladder[3].long.shortfallCNS > ladder[3].short.shortfallCNS ? ladder[3].long.shortfallCNS : ladder[3].short.shortfallCNS);
  assert.equal(ladder[3].insuranceCoverageBps, m.floorDiv(1000000000n * 10000n, ladder[3].worstShortfallCNS));
  assert.equal(ladder[3].long.insuranceCoverageBps, m.floorDiv(1000000000n * 10000n, ladder[3].long.shortfallCNS));
  assert.equal(ladder[2].worstNotionalCNS, ladder[2].long.notionalCNS > ladder[2].short.notionalCNS ? ladder[2].long.notionalCNS : ladder[2].short.notionalCNS);
  assert.equal(ladder[0].insuranceCoverageBps, null);
});

test('liquidation map bins by signed distance and keeps tails', () => {
  const enriched = marketMetrics(market, positions, u).positions;
  const map = liquidationMap(enriched, market, { binBps: 100n, rangeBps: 1000n });
  const bins = Object.fromEntries(map.bins.map(b => [b.fromBps.toString(), b]));
  assert.equal(bins['-600'].longNotionalCNS, 100000000000n);
  assert.equal(bins['600'].shortNotionalCNS, 100000000000n);
  assert.equal(bins['-300'].shortNotionalCNS, 200000000000n); // short liq at 97.5k => -250 bps
  assert.equal(map.tails.below.count, 1); // long liq at 79k is beyond -1000 bps
});

test('concentration and totals', () => {
  const x = marketMetrics(market, positions, u);
  assert.equal(x.concentration.all.top1Bps, 3333n);
  assert.equal(x.concentration.all.largest.accountId, 2n);
  assert.equal(x.concentration.long.positions, 2);
  const totals = exchangeTotals([x, x]);
  assert.equal(totals.positions, 8);
  assert.equal(totals.liquidatable, 2);
  assert.equal(totals.notionalCNS, 1200000000000n);
  assert.equal(totals.allReconciled, true);
  assert.equal(concentration([]).top1Bps, null);
});
