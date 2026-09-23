import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as s from '../src/state.js';
import { saveCheckpoint, loadCheckpoint } from '../src/checkpoint.js';

const target = { chain: '143', exchange: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F' };
const info = { name: 'BTC Perp', symbol: 'BTC', priceDecimals: 1n, lotDecimals: 5n, status: 4, markPNS: 859138n, markTimestamp: 1790001259n, lastPNS: 859121n, lastTimestamp: 1790001257n, oraclePNS: 859220n, oracleTimestampSec: 1790001258n, ignOracle: false, refPriceMaxAgeSec: 60n, longOpenInterestLNS: 300n, shortOpenInterestLNS: 300n, positionBalanceCNS: 1n, insuranceBalanceCNS: 174525733924n, fundingStartBlock: 55077246n, fundingRatePct100k: -4, absFundingClampPctPer100K: 10n, fundingSumScalingExp: 0n, numOrders: 108n, basePricePNS: 0n };
const read = { id: 1, info, margins: { initHdths: 1500n, maintHdths: 2500n, dynamicInitHdths: 1500n, oiMaxLNS: 30000000n, unityDescentHdths: 90n, overColDescentHdths: 95n }, liquidation: { liqInsAmtPer100K: 10000n, liqUserAmtPer100K: 80000n, liqProtocolAmtPer100K: 10000n, btlPriceThreshPer100K: 95000n, btlRestrictBuyers: true }, unwind: { status: 4, sumPositiveFmvCNS: 0n, initPositionBalanceCNS: 0n } };
const exchange = { balanceCNS: 1n, protocolBalanceCNS: 2n, recycleBalanceCNS: 3n, collateralDecimals: 6, collateralToken: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', numberOfAccounts: 5311n, fundingInterval: 8571n, version: '1.7.4', halted: false };
const position = (accountId, positionType, lotLNS) => ({ accountId, positionType, depositCNS: 41612829n, pricePNS: 697422n, lotLNS, entryBlock: 55355560n, pnlCNS: 0n, deltaPnlCNS: 0n, premiumPnlCNS: 6385467n, priceResiduePNSQ16: 0n, nextNodeId: 0n, prevNodeId: 0n });

function bootstrap() {
  const state = s.createState(target);
  s.setBlock(state, { number: 106773861n, hash: '0x' + 'ab'.repeat(32), timestamp: 1790001300 });
  s.applyExchange(state, exchange);
  s.applyMarkets(state, [read]);
  s.replaceMarketPositions(state, 1, [position(6n, 0, 179n), position(88n, 0, 121n), position(9n, 1, 300n)]);
  return state;
}

test('state reconciles stored positions against contract OI', () => {
  const state = bootstrap();
  assert.equal(s.reconcile(state).ok, true);
  s.applyPositionReads(state, [{ perpId: 1, accountId: 88n, position: position(88n, 0, 0n) }]);
  assert.equal(state.markets.get(1).positions.size, 2);
  const result = s.reconcile(state);
  assert.equal(result.ok, false);
  assert.equal(result.mismatches[0].longLNS, 179n);
  assert.equal(result.mismatches[0].contractLongLNS, 300n);
});

test('metrics are cached per block hash and recomputed after updates', () => {
  const state = bootstrap();
  const first = s.metrics(state);
  assert.equal(first.markets[0].metrics.positions.length, 3);
  assert.equal(s.metrics(state), first);
  s.applyPositionReads(state, [{ perpId: 1, accountId: 500n, position: position(500n, 1, 50n) }]);
  assert.notEqual(s.metrics(state), first);
  assert.equal(s.metrics(state).markets[0].metrics.positions.length, 4);
  assert.equal(s.metrics(state).totals.positions, 4);
});

test('history is bounded and status transitions are validated', () => {
  const state = bootstrap();
  s.appendHistory(state, { liquidations: Array.from({ length: s.HISTORY_LIMITS.liquidations + 5 }, (_, i) => ({ block: BigInt(i) })) });
  assert.equal(state.history.liquidations.length, s.HISTORY_LIMITS.liquidations);
  assert.equal(state.history.liquidations[0].block, 5n);
  assert.throws(() => s.setStatus(state, 'weird'), /INVALID_STATUS/);
  s.setStatus(state, 'fresh', null);
  assert.equal(state.status, 'fresh');
});

test('checkpoint round trip preserves BigInt state exactly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plumb-'));
  try {
    const state = bootstrap();
    s.appendHistory(state, { funding: [{ block: 1n, perpId: 1, fundingPaymentPNS: -34n, fundingSumPNS: -35673n, allowOverwrite: false }] });
    const path = join(dir, 'nested', 'checkpoint.json');
    await saveCheckpoint(path, state);
    const restored = await loadCheckpoint(path, target);
    assert.equal(restored.block.number, 106773861n);
    assert.equal(restored.markets.get(1).positions.get('6').premiumPnlCNS, 6385467n);
    assert.equal(restored.markets.get(1).maintHdths, 2500n);
    assert.equal(restored.history.funding[0].fundingPaymentPNS, -34n);
    assert.equal(restored.exchangeInfo.fundingInterval, 8571n);
    assert.deepEqual(s.metrics(restored).totals, s.metrics(state).totals);
    assert.equal(await loadCheckpoint(join(dir, 'missing.json'), target), null);
    await assert.rejects(loadCheckpoint(path, { chain: '10143', exchange: target.exchange }), /CHECKPOINT_TARGET_MISMATCH/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('history appended twice for the same logs keeps one copy', async () => {
  const { createState, appendHistory } = await import('../src/state.js');
  const state = createState({ chain: '143', exchange: '0x0' });
  const f = { perpId: 1, block: 10n, tx: '0xab', logIndex: 3, fundingEventBlock: 10n };
  appendHistory(state, { funding: [f] });
  appendHistory(state, { funding: [{ ...f }, { ...f, logIndex: 4 }] });
  assert.equal(state.history.funding.length, 2);
});
