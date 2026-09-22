import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex, recordsFromLogs, INDEX_EVENTS } from '../src/index.js';
import { topicsFor } from '../src/abi.js';
import * as m from '../src/math.js';
import { logBuilder, ev } from './helpers/logs.js';

// BTC-like market 1: price 1 decimal, lot 5 decimals; collateral 6 decimals.
const units = new Map([[1, m.units(1, 5, 6)], [2, m.units(2, 3, 6)]]);
const notional = (price, lot, u = units.get(1)) => m.notionalCNS(price, lot, u);

// A taker (account 7) buys 0.5 BTC at 50,000 from maker (account 3); later closes.
function sampleLogs() {
  const b = logBuilder();
  b.at(100n).tx().add(...ev.increase(1, 3, 1, 499900n, 100000n, 150000n)).add(...ev.makerFill(1, 3, 500000n, 50000n, 450n)).add(...ev.open(1, 7, 0, 500000n, 50000n)).add(...ev.takerFill(500000n, 50000n, 3450n, 10n));
  b.at(101n).tx().add(...ev.deposit(7, 250000000n)).tx().add(...ev.withdrawal(3, 100000000n)).tx().add(...ev.account(9, '0x00000000000000000000000000000000000000a9'));
  b.at(150n).tx().add(...ev.decrease(1, 3, 1, 150000n, 100000n, -1000000n)).add(...ev.makerFill(1, 3, 502000n, 50000n)).add(...ev.close(1, 7, 0, 502000n, 100000000n, -5000n)).add(...ev.takerFill(502000n, 50000n));
  b.at(160n).tx().add(...ev.liquidation(1, 11, 0, 480000n, 20000n, 0n, -30000000n));
  return b.logs;
}

test('every INDEX_EVENT has a known topic', () => { assert.equal(topicsFor(INDEX_EVENTS).length, INDEX_EVENTS.length); });

test('position events take price, size and fee from the adjacent fill', () => {
  const r = recordsFromLogs(sampleLogs());
  const inc = r.find(x => x.type === 'increase');
  assert.equal(inc.role, 'maker'); assert.equal(inc.pricePNS, 500000); assert.equal(inc.entryPricePNS, 499900); assert.equal(inc.lotLNS, 50000); assert.equal(inc.feeCNS, 500);
  const open = r.find(x => x.type === 'open');
  assert.equal(open.role, 'taker'); assert.equal(open.pricePNS, 500000); assert.equal(open.lotLNS, 50000); assert.equal(open.feeCNS, 1000);
  const taker = r.filter(x => x.type === 'takerFill');
  assert.equal(taker[0].perpId, 1); assert.equal(taker[0].accountId, 7);
  const close = r.find(x => x.type === 'close');
  assert.equal(close.lotLNS, 50000, 'close size comes from the fill'); assert.equal(close.pricePNS, 502000); assert.equal(close.feeCNS, 0);
  const dec = r.find(x => x.type === 'decrease');
  assert.equal(dec.pricePNS, 502000); assert.equal(dec.lotLNS, 50000); assert.equal(dec.feeCNS, 0);
  const liq = r.find(x => x.type === 'liquidation');
  assert.equal(liq.role, undefined); assert.equal(liq.pricePNS, 480000); assert.equal(liq.lotLNS, 20000);
});

test('exact aggregates: volume from maker fills, fees from fills, flows, liquidations, realized PnL', () => {
  const index = createIndex({ windowBlocks: 1000n, bucketBlocks: 50n });
  assert.equal(index.ingest(sampleLogs(), units), 12);
  assert.equal(index.ingest(sampleLogs(), units), 0, 'duplicates ignored');
  index.markCovered(100n, 160n);
  const a = index.aggregate(100n, 160n, units);
  assert.equal(a.exact, true); assert.equal(a.partial, false);
  assert.equal(a.volumeCNS, notional(500000n, 50000n) + notional(502000n, 50000n));
  assert.equal(a.trades, 2);
  assert.equal(a.feesCNS, 450n + 3450n); assert.equal(a.makerFeesCNS, 450n); assert.equal(a.takerFeesCNS, 3450n); assert.equal(a.builderFeesCNS, 10n);
  assert.equal(a.insuranceFeesCNS, 150n); assert.equal(a.protocolFeesCNS, 1350n);
  assert.equal(a.activeAccounts, 3, 'accounts 3, 7 and 11 traded'); assert.equal(a.newAccounts, 1);
  assert.equal(a.depositsCNS, 250000000n); assert.equal(a.withdrawalsCNS, 100000000n); assert.equal(a.netFlowCNS, 150000000n);
  assert.equal(a.liquidations, 1); assert.equal(a.liquidatedCNS, notional(480000n, 20000n));
  assert.equal(a.realizedPnlCNS, -1000000n + (100000000n - 5000n) + -30000000n);
  assert.equal(a.opens, 1); assert.equal(a.closes, 1);
  assert.equal(a.takerBuyCNS, notional(500000n, 50000n)); assert.equal(a.takerSellCNS, notional(502000n, 50000n));
  assert.equal(a.markets.get(1).takerBuyCNS, a.takerBuyCNS);
  const mk = a.markets.get(1);
  assert.equal(mk.volumeCNS, a.volumeCNS); assert.equal(mk.longVolumeCNS, notional(500000n, 50000n) + notional(502000n, 50000n) + notional(480000n, 20000n) * 0n);
  assert.equal(mk.shortVolumeCNS, notional(500000n, 50000n) + notional(502000n, 50000n));
  // A window starting before coverage is partial and uses buckets.
  const w = index.aggregate(0n, 160n, units);
  assert.equal(w.exact, false); assert.equal(w.partial, true); assert.equal(w.volumeCNS, a.volumeCNS);
  const series = index.series(0n, 199n);
  assert.deepEqual(series.map(s => s.fromBlock), [100n, 150n]);
  assert.equal(index.series(0n, 260n).length, 4, 'empty hours are included up to the end of the range');
  assert.equal(series[1].liquidations, 1); assert.equal(series[0].complete, true);
});

test('coverage must stay contiguous', () => {
  const index = createIndex();
  index.markCovered(100n, 200n); index.markCovered(201n, 300n); index.markCovered(50n, 99n);
  assert.deepEqual(index.covered, { from: 50n, to: 300n });
  assert.throws(() => index.markCovered(400n, 500n), /COVERAGE_GAP/);
});

test('leaderboard sums per account', () => {
  const index = createIndex({ bucketBlocks: 50n });
  index.ingest(sampleLogs(), units);
  const stats = index.accountStats(0n, 1000n, units);
  const taker = stats.get(7);
  assert.equal(taker.trades, 2); assert.equal(taker.volumeCNS, notional(500000n, 50000n) + notional(502000n, 50000n)); assert.equal(taker.realizedCNS, 100000000n - 5000n); assert.equal(taker.feesCNS, 1000n); assert.equal(taker.depositsCNS, 250000000n);
  const liquidated = stats.get(11);
  assert.equal(liquidated.liquidations, 1); assert.equal(liquidated.realizedCNS, -30000000n);
  assert.equal(index.accountRecords(3).map(r => r.type).join(','), 'increase,withdrawal,decrease');
});

test('prune drops old records but keeps hourly aggregates', () => {
  const index = createIndex({ windowBlocks: 20n, bucketBlocks: 50n, historyBlocks: 1000n });
  index.ingest(sampleLogs(), units); index.markCovered(100n, 160n);
  assert.equal(index.prune(170n), 7);
  assert.equal(index.size, 5); assert.equal(index.covered.from, 150n);
  const a = index.aggregate(100n, 160n, units);
  assert.equal(a.exact, false); assert.equal(a.trades, 2, 'buckets survive');
  assert.equal(index.accountRecords(7).length, 1);
});

test('serialized aggregates reload and are replaced by a rebuild', () => {
  const index = createIndex({ bucketBlocks: 50n });
  index.ingest(sampleLogs(), units); index.markCovered(100n, 199n);
  index.recordSnapshot({ block: 120n, ts: 1, oiCNS: 5n, tvlCNS: 9n, markets: [{ id: 1, longCNS: 3n, shortCNS: 2n }] });
  index.recordSnapshot({ block: 110n, ts: 0, oiCNS: 1n, tvlCNS: 1n, markets: [] });
  const text = index.serialize();
  const fresh = createIndex({ bucketBlocks: 50n });
  assert.equal(fresh.load(text), 2);
  assert.equal(fresh.snapshots.get(2n).oiCNS, 5n, 'latest block wins within a bucket');
  const before = fresh.aggregate(100n, 160n);
  assert.equal(before.trades, 2); assert.equal(before.partial, false, 'loaded buckets are complete');
  assert.equal(fresh.series(0n, 200n)[0].snapshot.markets.get(1).longCNS, 3n);
  // Re-ingesting only the second transaction of block 100 replaces the loaded bucket with a rebuild.
  const logs = sampleLogs().slice(2, 4);
  fresh.startBackfill(100n);
  fresh.ingest(logs, units);
  fresh.markCovered(100n, 160n);
  const after = fresh.aggregate(100n, 160n);
  assert.equal(after.trades, 1);
  // Backfill that stops inside bucket 2 restores the loaded aggregate for it.
  const again = createIndex({ bucketBlocks: 50n });
  again.load(text); again.startBackfill(100n); again.markCovered(199n, 199n);
  again.ingest(sampleLogs().slice(-1), units); // the liquidation at block 160 lands in bucket 3
  again.ingest(logs, units); // partial rebuild of bucket 2
  again.finishBackfill({ contiguousFrom: 155n, complete: false });
  assert.equal(again.aggregate(100n, 160n).trades, 2, 'complete loaded bucket restored');
  assert.equal(again.backfill.done, true);
  assert.throws(() => createIndex({ bucketBlocks: 60n }).load(text), /INDEX_VERSION_MISMATCH/);
});
