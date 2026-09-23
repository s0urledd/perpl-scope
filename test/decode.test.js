import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsFromLogs, decodeFast, ingestTopics } from '../src/decode.js';
import { decodeLog } from '../src/abi.js';
import * as m from '../src/math.js';
import { FLAG } from '../src/schema.js';
import { logBuilder, ev, makeLog, BLOCK_TS } from './helpers/logs.js';

// BTC-like market 1: price 1 decimal, lot 5 decimals; collateral 6 decimals.
const units = new Map([[1, m.units(1, 5, 6)], [2, m.units(2, 3, 6)]]);
const unitsOf = id => units.get(id) ?? null;
const LONG = 0, SHORT = 1;
const byKind = (rows, kind) => rows.filter(r => r.kind === kind);

test('fast decoder agrees with the generic decoder on every ingest topic it handles', () => {
  const b = logBuilder();
  b.tx().add(...ev.open(1, 5, LONG, 1000000n, 100000n)).add(...ev.makerFill(1, 5, 1000000n, 100000n, 1000n)).add(...ev.takerFill(1000000n, 100000n, 1000n, 7n));
  b.tx().add(...ev.invert(1, 5, SHORT, 990000n, 100000n, 50000n, -1000000n)).add(...ev.liquidation(1, 9, LONG, 900000n, 1000n, 0n, -5n)).add(...ev.deposit(5, 7n)).add(...ev.account(5, '0x00000000000000000000000000000000000000aa'));
  for (const log of b.logs) {
    const fast = decodeFast(log), slow = decodeLog(log);
    assert.equal(fast.name, slow.name);
    for (const [k, v] of Object.entries(slow.args)) assert.equal(String(fast.args[k]).toLowerCase(), String(v).toLowerCase(), `${slow.name}.${k}`);
  }
  assert.ok(ingestTopics.length > 40);
});

test('a match links each position event to its fill: maker then taker', () => {
  const b = logBuilder().at(200);
  // Maker 7 decreases a long by 0.5 BTC; taker 5 opens a long of 0.5 BTC at 100,000.
  b.tx()
    .add(...ev.decrease(1, 7, LONG, 100000n, 50000n, 2500000n))
    .add(...ev.makerFill(1, 7, 1000000n, 50000n, 0n))
    .add(...ev.open(1, 5, LONG, 1000000n, 50000n, { insFeeCNS: 2500000n, protFeeCNS: 22500000n }))
    .add(...ev.takerFill(1000000n, 50000n, 25000000n, 1000n));
  const out = rowsFromLogs(b.logs, { unitsOf });
  assert.deepEqual({ linked: out.stats.linked, unlinked: out.stats.unlinked, feeChecked: out.stats.feeChecked, feeMismatch: out.stats.feeMismatch, lotMismatch: out.stats.lotMismatch }, { linked: 2, unlinked: 0, feeChecked: 1, feeMismatch: 0, lotMismatch: 0 });
  const [maker] = byKind(out.ev, 'decrease'), [taker] = byKind(out.ev, 'open');
  assert.equal(maker.role, 'maker'); assert.equal(maker.buy, 0, 'reducing a long sells');
  assert.equal(taker.role, 'taker'); assert.equal(taker.buy, 1);
  assert.equal(taker.notional, 50000000000n, '0.5 BTC at 100,000 = 50,000 USD in 6-decimal units');
  assert.equal(taker.fee, 25000000n); assert.equal(taker.builder_fee, 1000n);
  const [fill] = byKind(out.ev, 'maker_fill');
  assert.equal(fill.notional, 50000000000n, 'volume counts the maker fill once');
  const [tfill] = byKind(out.ev, 'taker_fill');
  assert.equal(tfill.account, 5); assert.equal(tfill.market, 1);
  // Open interest: maker long -0.5, taker long +0.5 (net zero on the long side).
  assert.equal(out.ev.reduce((a, r) => a + r.oi_long, 0n), 0n);
  assert.equal(taker.ts, BLOCK_TS(200));
});

test('PositionInverted carries the new side: the old side shrinks by startLot, the new side grows by endLot', () => {
  const b = logBuilder();
  b.tx().add(...ev.invert(1, 5, SHORT, 1000000n, 30000n, 20000n, -700000n)).add(...ev.takerFill(1000000n, 50000n, 100n));
  const out = rowsFromLogs(b.logs, { unitsOf });
  const [row] = byKind(out.ev, 'invert');
  assert.equal(row.side, SHORT);
  assert.equal(row.buy, 0, 'flipping long to short sells');
  assert.equal(row.oi_long, -30000n);
  assert.equal(row.oi_short, 20000n);
  assert.equal(row.lot, 50000n);
  assert.equal(out.stats.lotMismatch, 0);
});

test('a close takes its size from the fill; a missing fill is flagged, not guessed', () => {
  const b = logBuilder();
  b.tx().add(...ev.close(1, 5, SHORT, 1000000n, 1234n)).add(...ev.takerFill(1000000n, 40000n, 0n));
  b.tx().add(...ev.close(1, 6, LONG, 1000000n, 0n));
  const out = rowsFromLogs(b.logs, { unitsOf });
  const [linked, orphan] = byKind(out.ev, 'close');
  assert.equal(linked.lot, 40000n); assert.equal(linked.oi_short, -40000n); assert.equal(linked.buy, 1);
  assert.equal(orphan.flags & FLAG.UNLINKED, FLAG.UNLINKED);
  assert.equal(orphan.oi_long, 0n);
  assert.equal(out.stats.unlinked, 1);
});

test('a liquidation on the book is the taker of the fill reported just before it', () => {
  const b = logBuilder();
  b.tx()
    .add(...ev.increase(1, 7, SHORT, 1000000n, 10000n, 12000n))
    .add(...ev.makerFill(1, 7, 1000000n, 2000n, 0n))
    .add(...ev.takerFill(1000000n, 2000n, 0n))
    .add(...ev.liquidation(1, 9, SHORT, 1000000n, 2000n, 0n, -40000n));
  const out = rowsFromLogs(b.logs, { unitsOf });
  assert.equal(out.stats.forcedLinked, 1);
  assert.equal(out.stats.takerFillsUnlinked, 0);
  const [liq] = byKind(out.ev, 'liquidation');
  assert.equal(liq.role, 'taker'); assert.equal(liq.buy, 1, 'closing a short buys');
  assert.equal(liq.oi_short, -2000n);
  const [tfill] = byKind(out.ev, 'taker_fill');
  assert.equal(tfill.account, 9);
});

test('rows for unknown markets are reported, and ContractAdded in the batch supplies decimals', () => {
  const b = logBuilder();
  b.tx().add(...ev.open(3, 5, LONG, 100n, 10n)).add(...ev.takerFill(100n, 10n, 1n));
  const missing = rowsFromLogs(b.logs, { unitsOf });
  assert.deepEqual([...missing.missingMarkets], [3]);
  const added = makeLog('ContractAddedV2', { perpId: 3n, name: 'Test Perp', symbol: 'TST', status: 4, basePricePNS: 100n, priceDecimals: 2n, lotDecimals: 1n, initMarginFracHdths: 1000n, maintMarginFracHdths: 2000n, maxOpenInterestLNS: 10n ** 9n, unityDescentThreshHdths: 0n, overColDescentThreshHdths: 0n, dcpBorrowThreshHdths: 0n, priceTolPer100K: 0n, marginTol: 0n, marginTolDecimals: 0n, refPriceMaxAgeSec: 60n, absFundingClampPctPer100K: 0n, permCancelMinOrders: 0n, permCancelSegment: 0n, insAmtPer100K: 0n, liqInsAmtPer100K: 0n, liqUserAmtPer100K: 0n, btlRestrictBuyers: false, btlPriceThreshPer100K: 0n, btlInsAmtPer100K: 0n, btlUserAmtPer100K: 0n, btlBuyerAmtPer100K: 0n, numPerpetuals: 3n, perpFeeSchedId: 0n }, { block: 99, tx: 99, logIndex: 0 });
  const out = rowsFromLogs([added, ...b.logs], { unitsOf });
  assert.equal(out.missingMarkets.size, 0);
  assert.equal(out.markets[0].symbol, 'TST');
  assert.equal(byKind(out.ev, 'open')[0].notional, 1000000n, '1.0 lot at 1.00 = 1 USD in 6-decimal units');
});

test('flows, accounts and funding go to their own rows', () => {
  const b = logBuilder();
  b.tx().add(...ev.account(5, '0x00000000000000000000000000000000000000AA')).add(...ev.deposit(5, 5000000n));
  b.tx().add(...ev.withdrawal(5, 2000000n));
  b.tx().add('FundingEventCompleted', { perpId: 1n, fundingEventBlock: 8571n, specifiedRatePct100k: 5n, actualRatePct100k: -4n, fundingPricePNS: 1000000n, fundingPaymentPNS: -3n, fundingSumPNS: -99n, allowOverwrite: false });
  const out = rowsFromLogs(b.logs, { unitsOf });
  assert.equal(out.accounts[0].address, '0x00000000000000000000000000000000000000aa');
  assert.deepEqual(out.ev.filter(r => r.kind === 'deposit' || r.kind === 'withdrawal').map(r => [r.kind, r.amount]), [['deposit', 5000000n], ['withdrawal', 2000000n]]);
  assert.equal(out.funding[0].actual_rate, -4n);
  assert.equal(out.funding[0].sum, -99n);
});

test('increases carry the funding the contract settles when the lot changes', () => {
  const b = logBuilder();
  b.tx().add(...ev.increase(1, 7, LONG, 1000000n, 10000n, 12000n, { premiumPnlSettledCNS: -2500000n })).add(...ev.takerFill(1000000n, 2000n, 0n));
  const [inc] = byKind(rowsFromLogs(b.logs, { unitsOf }).ev, 'increase');
  assert.equal(inc.funding, -2500000n, 'funding paid is realized at the increase');
  assert.equal(inc.pnl, 0n);
});

test('a liquidation keeps the returned share of the margin; the rest is its fee', () => {
  // ZEC liquidation at block 107,162,461: deposit 266.804273, loss 157.104665,
  // 80 % of the 109.699608 left returned to the trader.
  const b = logBuilder();
  b.tx().add(...ev.takerFill(1000000n, 2000n, 0n))
    .add(...ev.liquidation(1, 9, SHORT, 1000000n, 2000n, 0n, -157104665n, { posAmountCNS: -266804273n, accAmountCNS: 87759686n }));
  const [liq] = byKind(rowsFromLogs(b.logs, { unitsOf }).ev, 'liquidation');
  assert.equal(liq.pnl, -157104665n);
  assert.equal(liq.fee, 21939922n);
  assert.equal(liq.pnl + liq.funding - liq.fee, 87759686n - 266804273n, 'net = amount returned - deposit removed');
});

test('a liquidation past bankruptcy loses the deposit, not more', () => {
  const b = logBuilder();
  b.tx().add(...ev.liquidation(1, 9, LONG, 1000000n, 2000n, 0n, -300000000n, { fundingCNS: -1000000n, posAmountCNS: -200000000n, accAmountCNS: 0n }));
  const [liq] = byKind(rowsFromLogs(b.logs, { unitsOf }).ev, 'liquidation');
  assert.equal(liq.pnl + liq.funding, -200000000n);
  assert.equal(liq.fee, 0n);
});
