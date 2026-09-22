import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/math.js';

const u = m.units(1, 5, 6); // BTC: price 0.1, lot 0.00001, AUSD 6

test('effective entry price follows SDK rounding rules', () => {
  const pc = m.units(4, 0, 6);
  assert.equal(m.entryPriceQ16(m.LONG, 1n, 0n), 1n * m.Q16);
  assert.equal(m.entryPriceQ16(m.LONG, 1n, 1n), 1n); // (1-1) + 1/65536
  assert.equal(m.entryPriceQ16(m.LONG, 10001n, 8n), 10000n * m.Q16 + 8n);
  assert.equal(m.entryPriceQ16(m.LONG, 10000n, 65535n), 9999n * m.Q16 + 65535n);
  assert.equal(m.entryPriceQ16(m.SHORT, 0n, 1n), 1n);
  assert.equal(m.entryPriceQ16(m.SHORT, 10000n, 8n), 10000n * m.Q16 + 8n);
  assert.equal(m.entryPriceQ16(m.SHORT, 9999n, 65535n), 9999n * m.Q16 + 65535n);
  assert.throws(() => m.entryPriceQ16(m.LONG, 1n, 65536n), /INVALID_RESIDUE/);
  assert.throws(() => m.entryPriceQ16(2, 1n, 5n), /INVALID_SIDE/);
  assert.equal(pc.price, 10000n);
});

test('notional and delta pnl are exact integers', () => {
  // 0.00179 BTC at 69742.2 => 124.838538 AUSD
  const entry = m.entryPriceQ16(m.LONG, 697422n, 0n);
  assert.equal(m.entryNotionalCNS(entry, 179n, u), 124838538n);
  // mark 85913.8 => delta = (85913.8 - 69742.2) * 0.00179 = 28.947164
  assert.equal(m.deltaPnlCNS(m.LONG, entry, 859138n, 179n, u), 28947164n);
  assert.equal(m.deltaPnlCNS(m.SHORT, entry, 859138n, 179n, u), -28947164n);
  assert.equal(m.notionalCNS(859138n, 179n, u), 153785702n);
});

test('liquidation and bankruptcy prices match the documented BTC example', () => {
  // $100k BTC long at 10x: deposit 10k, size 1 BTC, MMF 25 (4 %) => liq 94k, bankrupt 90k
  const units = m.units(1, 5, 6);
  const entry = m.entryPriceQ16(m.LONG, 1000000n, 0n);
  const lot = 100000n, deposit = 10000000000n;
  const mmr = m.maintenanceMarginCNS(entry, lot, 2500n, units);
  assert.equal(mmr, 4000000000n);
  assert.equal(m.liquidationPriceMicroPNS(m.LONG, entry, lot, deposit, 0n, mmr, units), 940000n * m.MICRO);
  assert.equal(m.bankruptcyPriceMicroPNS(m.LONG, entry, lot, deposit, 0n, units), 900000n * m.MICRO);
  // Same short: liq 106k, bankrupt 110k
  assert.equal(m.liquidationPriceMicroPNS(m.SHORT, entry, lot, deposit, 0n, mmr, units), 1060000n * m.MICRO);
  assert.equal(m.bankruptcyPriceMicroPNS(m.SHORT, entry, lot, deposit, 0n, units), 1100000n * m.MICRO);
  // Positive premium (received funding) moves the long liquidation lower
  assert.ok(m.liquidationPriceMicroPNS(m.LONG, entry, lot, deposit, 1000000000n, mmr, units) < 940000n * m.MICRO);
  // Clamped at zero for an over-collateralised long
  assert.equal(m.liquidationPriceMicroPNS(m.LONG, entry, lot, 500000000000n, 0n, mmr, units), 0n);
});

test('health classification follows 0 < FMV <= MMR', () => {
  assert.equal(m.classify(100n, 100n), 'liquidatable');
  assert.equal(m.classify(101n, 100n), 'healthy');
  assert.equal(m.classify(0n, 100n), 'bankrupt');
  assert.equal(m.classify(-5n, 100n), 'bankrupt');
  assert.equal(m.healthBps(150n, 100n), 15000n);
  assert.equal(m.healthBps(1n, 0n), null);
});

test('distance and shocks are side aware', () => {
  // long at mark 100.0 with liq 94.0 => 600 bps away; short with liq 106.0 => 600 bps
  assert.equal(m.distanceBps(m.LONG, 1000n, 940n * m.MICRO), 600n);
  assert.equal(m.distanceBps(m.SHORT, 1000n, 1060n * m.MICRO), 600n);
  assert.equal(m.distanceBps(m.LONG, 1000n, 1010n * m.MICRO), -100n);
  assert.equal(m.shockedPricePNS(m.LONG, 1000n, 1000n), 900n);
  assert.equal(m.shockedPricePNS(m.SHORT, 1000n, 1000n), 1100n);
  assert.equal(m.distanceBps(m.LONG, 0n, 1n), null);
});

test('funding conversions follow SDK sign and scaling', () => {
  // BTC payment -34 PNS (-3.4 USD per BTC): long gains 0.00179 * 3.4 = 0.006086
  assert.equal(m.fundingPremiumDeltaCNS(m.LONG, -34n, 179n, 0n, u), 6086n);
  assert.equal(m.fundingPremiumDeltaCNS(m.SHORT, -34n, 179n, 0n, u), -6086n);
  // MON: exp 2, price decimals 6, lot decimals 0
  const mon = m.units(6, 0, 6);
  assert.equal(m.fundingPremiumDeltaCNS(m.SHORT, 51n, 1000n, 2n, mon), 510n); // 51e-8 AUSD/MON * 1000 MON = 0.00051 AUSD
  assert.equal(m.fundingPremiumDeltaCNS(m.SHORT, 51n, 1000000n, 2n, mon), 510000n);
  assert.equal(m.fundingPremiumDeltaCNS(m.LONG, 51n, 1000n, 2n, mon), -510n);
  assert.equal(m.fundingRateFraction(-4n), -0.00004);
  assert.equal(m.nextFundingBlock(106774167n, 8571n), 106777518n);
  assert.equal(m.nextFundingBlock(8571n, 8571n), 17142n);
  assert.equal(m.nextFundingBlock(5n, 0n), 5n);
});

test('decimal rendering is exact', () => {
  assert.equal(m.toDecimalString(124838538n, 6), '124.838538');
  assert.equal(m.toDecimalString(-5n, 6), '-0.000005');
  assert.equal(m.toDecimalString(7n, 0), '7');
  assert.equal(m.floorDiv(-7n, 2n), -4n);
  assert.equal(m.floorDiv(7n, 2n), 3n);
  assert.equal(m.floorDiv(-8n, 2n), -4n);
});
