import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters } from 'viem';
import { eventsAbi, decodeLog, topicsFor } from '../src/abi.js';
import { processLogs, watchedTopics, WATCHED_EVENTS } from '../src/events.js';

function makeLog(name, values, { block = 100n, tx = '0x' + '11'.repeat(32), logIndex = 0 } = {}) {
  const item = eventsAbi.find(e => e.name === name);
  const indexed = item.inputs.filter(i => i.indexed), plain = item.inputs.filter(i => !i.indexed);
  const topics = encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(indexed.map(i => [i.name, values[i.name]])) });
  const data = encodeAbiParameters(plain, plain.map(i => values[i.name]));
  return { address: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F', blockNumber: '0x' + block.toString(16), blockHash: '0x' + 'aa'.repeat(32), transactionHash: tx, transactionIndex: '0x1', logIndex: '0x' + logIndex.toString(16), topics, data, removed: false };
}

test('watched topic list covers every watched event and decodes round-trip', () => {
  assert.equal(new Set(watchedTopics).size, watchedTopics.length);
  assert.ok(watchedTopics.length >= WATCHED_EVENTS.length);
  const log = makeLog('FundingEventCompleted', { perpId: 1n, fundingEventBlock: 106768947n, specifiedRatePct100k: -4n, actualRatePct100k: -4n, fundingPricePNS: 851968n, fundingPaymentPNS: -34n, fundingSumPNS: -35673n, allowOverwrite: false });
  const decoded = decodeLog(log);
  assert.equal(decoded.name, 'FundingEventCompleted');
  assert.equal(BigInt(decoded.args.fundingPaymentPNS), -34n);
  assert.equal(decodeLog({ topics: ['0x' + '00'.repeat(32)], data: '0x' }), null);
  assert.throws(() => topicsFor(['NoSuchEvent']), /UNKNOWN_EVENT/);
});

test('logs produce dirty positions, funding and liquidation history', () => {
  const liquidation = makeLog('PositionLiquidated', { perpId: 1n, posAccountId: 42n, positionType: 0, markPricePNS: 850000n, liqPricePNS: 849900n, liqLotLNS: 100n, posLotLNS: 0n, deltaPnlCNS: -5000000n, fundingCNS: 10n, posAmountCNS: 1000n, posDepositCNS: 0n, accAmountCNS: 800n, accBalanceCNS: 1800n, onOrderBook: true }, { logIndex: 3 });
  const opened = makeLog('PositionOpenedV2', { perpId: 20n, accountId: 7n, positionType: 1, leverageHdths: 500n, depositCNS: 1000000n, pnlCollateralizedCNS: 0n, pricePNS: 273600n, lotLNS: 10n, insFeeCNS: 0n, protFeeCNS: 0n, priceResiduePNSQ16: 5n }, { logIndex: 4 });
  const funding = makeLog('FundingEventCompleted', { perpId: 1n, fundingEventBlock: 106768947n, specifiedRatePct100k: -4n, actualRatePct100k: -4n, fundingPricePNS: 851968n, fundingPaymentPNS: -34n, fundingSumPNS: -35673n, allowOverwrite: false }, { logIndex: 5 });
  const diagnostic = makeLog('CantLiquidatePosAboveMMR', { perpId: 1n, posAccountId: 9n, positionType: 1, markPricePNS: 850000n, liqPricePNS: 900000n }, { logIndex: 6 });
  const margin = makeLog('MaintenanceMarginFractionUpdated', { perpId: 1n, maintMarginFracHdths: 2600n }, { logIndex: 7 });
  const seen = new Set();
  const out = processLogs([liquidation, opened, funding, diagnostic, margin], { seen });
  assert.deepEqual([...out.dirty.keys()].sort(), ['1:42', '20:7']);
  assert.deepEqual([...out.markets].sort(), [1, 20]);
  assert.equal(out.liquidations.length, 1);
  assert.equal(out.liquidations[0].exitPricePNS, 849900n);
  assert.equal(out.liquidations[0].remainingLotLNS, 0n);
  assert.equal(out.funding[0].fundingSumPNS, -35673n);
  assert.equal(out.validation[0].liqPricePNS, 900000n);
  assert.equal(out.params[0].name, 'MaintenanceMarginFractionUpdated');
  assert.equal(out.params[0].args.maintMarginFracHdths, '2600');
  assert.equal(out.decoded, 5);
  // Replaying the same logs is deduplicated by identity.
  const again = processLogs([liquidation], { seen });
  assert.equal(again.duplicates, 1);
  assert.equal(again.liquidations.length, 0);
});
