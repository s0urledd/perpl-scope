import test from 'node:test';
import assert from 'node:assert/strict';
import { roundTrips, performance, insights, activityGrid } from '../src/analytics.js';

const LONG = 0, SHORT = 1;
let seq = 0;
const row = (kind, market, side, o = {}) => ({ kind, market, side, role: 'taker', block: ++seq, log_index: 0, ts: 1790000000 + seq * 600, lot: 0n, start_lot: 0n, end_lot: 0n, notional: 0n, fee: 0n, builder_fee: 0n, pnl: 0n, funding: 0n, leverage: 1000, ...o });

test('a position is one round trip per market; a flip closes one side and opens the other', () => {
  seq = 0;
  const rows = [
    row('open', 1, LONG, { lot: 10n, end_lot: 10n, notional: 1000n, fee: 1n }),
    row('increase', 1, LONG, { lot: 10n, start_lot: 10n, end_lot: 20n, notional: 1000n, fee: 1n }),
    row('decrease', 1, LONG, { lot: 5n, start_lot: 20n, end_lot: 15n, notional: 600n, pnl: 50n }),
    row('invert', 1, SHORT, { lot: 25n, start_lot: 15n, end_lot: 10n, notional: 2500n, pnl: 120n, fee: 3n }),
    row('close', 1, SHORT, { lot: 10n, start_lot: 10n, notional: 900n, pnl: 80n, funding: -5n }),
    row('open', 2, SHORT, { lot: 4n, end_lot: 4n, notional: 400n }),
    row('liquidation', 2, SHORT, { lot: 4n, start_lot: 4n, notional: 450n, pnl: -390n })
  ];
  const { trips, openTrips, totals } = roundTrips(rows);
  assert.equal(openTrips.length, 0);
  assert.deepEqual(trips.map(t => [t.market, t.side, t.realized, t.net, t.liquidated]), [[1, LONG, 170n, 168n, false], [1, SHORT, 75n, 72n, false], [2, SHORT, -390n, -390n, true]]);
  assert.equal(trips[1].entryNotional, 1000n, 'the new side is entered with the part of the flip fill that opened it');
  assert.equal(totals.trades, 7);
});

test('events before the first open form an incomplete trip without a hold time', () => {
  seq = 0;
  const { trips } = roundTrips([row('decrease', 1, LONG, { start_lot: 10n, end_lot: 5n, pnl: 10n }), row('close', 1, LONG, { lot: 5n, pnl: 5n })]);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].complete, false);
  assert.equal(trips[0].maxLot, 10n);
  assert.equal(performance(trips).averageHold, null);
});

test('win rate, profit factor, drawdown, streaks and behaviour notes', () => {
  seq = 0;
  const rows = [];
  for (const pnl of [100n, -40n, -30n, 80n, 60n, -200n, 10n]) rows.push(row('open', 1, LONG, { lot: 1n, end_lot: 1n, notional: 1000n }), row('close', 1, LONG, { lot: 1n, pnl }));
  const perf = performance(roundTrips(rows).trips);
  assert.equal(perf.closedTrips, 7);
  assert.equal(perf.wins, 4);
  assert.equal(Math.round(perf.winRate * 100), 57);
  assert.equal(perf.profitFactor, 0.9259, 'gross wins 250 / gross losses 270');
  assert.equal(perf.maxDrawdown, 200n, 'peak 170 after trip 5, trough -30 after trip 6');
  assert.equal(perf.bestStreak, 2);
  assert.equal(perf.worstStreak, 2);
  assert.equal(perf.largestLoss, -200n);
  const notes = insights(perf, rows);
  assert.ok(notes.some(n => n.tag === 'bias' && /Long bias/.test(n.text)));
  assert.ok(notes.some(n => n.tag === 'result'));
  const grid = activityGrid(rows);
  assert.equal(grid.flat().reduce((a, b) => a + b, 0), 14);
});
