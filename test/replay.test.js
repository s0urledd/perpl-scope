import test from 'node:test';
import assert from 'node:assert/strict';
import { applySizeEvent, canonicalSizes } from '../src/replay-core.js';
test('comparison ignores object property insertion order', () => {
  assert.equal(canonicalSizes(new Map([['1:1', { lot: 5n, side: 0 }]])), canonicalSizes(new Map([['1:1', { side: 0, lot: 5n }]])));
});
test('open increase partial close and full close maintain exact quantity', () => {
  const s = new Map(), a = { perpId: 1n, accountId: 2n, positionType: 1 };
  applySizeEvent(s, 'PositionOpenedV2', { ...a, lotLNS: 10n });
  applySizeEvent(s, 'PositionIncreasedV2', { ...a, startLotLNS: 10n, endLotLNS: 15n });
  applySizeEvent(s, 'PositionDecreased', { ...a, startLotLNS: 15n, endLotLNS: 4n });
  assert.deepEqual(s.get('1:2'), { side: 1, lot: 4n });
  assert.throws(() => applySizeEvent(s, 'PositionDecreased', { ...a, startLotLNS: 15n, endLotLNS: 4n }), /START_SIZE/);
  applySizeEvent(s, 'PositionClosed', a);
  assert.equal(s.size, 0);
});
test('inversion and partial liquidation use post-event direction and size', () => {
  const s = new Map([['1:2', { side: 0, lot: 10n }]]);
  applySizeEvent(s, 'PositionInverted', { perpId: 1n, accountId: 2n, positionType: 1, startLotLNS: 10n, endLotLNS: 3n });
  applySizeEvent(s, 'PositionLiquidated', { perpId: 1n, posAccountId: 2n, positionType: 1, posLotLNS: 1n });
  assert.deepEqual(s.get('1:2'), { side: 1, lot: 1n });
  applySizeEvent(s, 'PositionUnwoundV2', { perpId: 1n, accountId: 2n, positionType: 1 });
  assert.equal(s.size, 0);
});
