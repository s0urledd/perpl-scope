import test from 'node:test';
import assert from 'node:assert/strict';
import { bitmapIds, accountMarkets, reconcile } from '../src/snapshot-core.js';
test('account bitmap excludes reserved bits and uses packed bank offsets', () => {
  assert.deepEqual(accountMarkets({ bank1: (1n << 255n) | 2n, bank2: 1n, bank3: 1n, bank4: 1n }), [1, 253, 509, 765]);
});
test('discovery preserves bank boundaries and top bits', () => {
  assert.deepEqual(bitmapIds([2n, 1n << 255n, 0n, 1n]), [1, 511, 768]);
});
test('OI sums sides separately without floating point', () => {
  const large = 9007199254740993n;
  const p = [{ accountId: 1n, lotLNS: large, positionType: 0 }, { accountId: 2n, lotLNS: 2n, positionType: 1 }];
  assert.equal(reconcile(p, large, 2n).matches, true);
  assert.equal(reconcile(p, large + 1n, 2n).matches, false);
  assert.throws(() => reconcile([...p, p[0]], large, 2n), /DUPLICATE/);
});
