import test from 'node:test';
import assert from 'node:assert/strict';
import { tradesFor, performance, observations } from '../src/analytics.js';
import { recordsFromLogs } from '../src/index.js';
import * as m from '../src/math.js';
import { logBuilder, ev } from './helpers/logs.js';

const units = new Map([[1, m.units(1, 5, 6)], [2, m.units(2, 3, 6)]]);
const records = logs => recordsFromLogs(logs).filter(r => r.accountId === 7 && r.type !== 'takerFill');

function history() {
  const b = logBuilder();
  // Trip 1 (BTC long): open 0.5 @ 50,000, add 0.5 @ 51,000, sell 0.5 @ 52,000 (+1,000), close @ 53,000 (+1,000) -> +2,000
  b.at(100n).tx().add(...ev.open(1, 7, 0, 500000n, 50000n)).add(...ev.takerFill(500000n, 50000n, 1000n));
  b.at(120n).tx().add(...ev.increase(1, 7, 0, 505000n, 50000n, 100000n)).add(...ev.takerFill(510000n, 50000n, 500n));
  b.at(140n).tx().add(...ev.decrease(1, 7, 0, 100000n, 50000n, 1000000000n)).add(...ev.takerFill(520000n, 50000n));
  b.at(200n).tx().add(...ev.close(1, 7, 0, 530000n, 1000000000n, -1000000n)).add(...ev.takerFill(530000n, 50000n));
  // Trip 2 (BTC short): open @ 53,000, liquidated fully @ 60,000 -> -3,500
  b.at(300n).tx().add(...ev.open(1, 7, 1, 530000n, 50000n)).add(...ev.takerFill(530000n, 50000n, 1000n));
  b.at(400n).tx().add(...ev.liquidation(1, 7, 1, 600000n, 50000n, 0n, -3500000000n));
  // Trip 3 (ETH long): open, invert to short (+100), later close short (-50)
  b.at(500n).tx().add(...ev.open(2, 7, 0, 300000n, 1000n)).add(...ev.takerFill(300000n, 1000n, 100n));
  b.at(600n).tx().add(...ev.invert(2, 7, 0, 310000n, 1000n, 2000n, 100000000n)).add(...ev.takerFill(310000n, 3000n, 300n));
  b.at(700n).tx().add(...ev.close(2, 7, 1, 315000n, -50000000n)).add(...ev.takerFill(315000n, 2000n));
  return b.logs;
}

test('round trips are grouped per market and side', () => {
  const t = tradesFor(records(history()), units);
  assert.equal(t.trips.length, 4);
  const [btcLong, btcShort, ethLong, ethShort] = t.trips;
  assert.equal(btcLong.realizedCNS, 1999000000n); assert.equal(btcLong.openBlock, 100n); assert.equal(btcLong.closeBlock, 200n); assert.equal(btcLong.feesCNS, 1500n); assert.equal(btcLong.maxLotLNS, 100000n);
  assert.equal(btcLong.entryNotionalCNS, m.notionalCNS(500000n, 50000n, units.get(1)) + m.notionalCNS(510000n, 50000n, units.get(1)));
  assert.equal(btcShort.liquidated, true); assert.equal(btcShort.realizedCNS, -3500000000n);
  assert.equal(ethLong.side, 0); assert.equal(ethLong.realizedCNS, 100000000n); assert.equal(ethLong.closeBlock, 600n);
  assert.equal(ethShort.side, 1); assert.equal(ethShort.openBlock, 600n); assert.equal(ethShort.realizedCNS, -50000000n); assert.equal(ethShort.complete, true);
  assert.equal(t.openTrips.length, 0);
  assert.equal(t.realizedCNS, 1999000000n - 3500000000n + 100000000n - 50000000n);
  assert.equal(t.events.length, 9); assert.equal(t.events[0].role, 'taker');
  assert.equal(t.fundingCNS, -1000000n);
});

test('a trip that started before the window is incomplete', () => {
  const t = tradesFor(records(history().slice(2)), units); // starts at the increase
  assert.equal(t.trips[0].complete, false); assert.equal(t.trips[0].openBlock, 120n);
  const p = performance(t.trips, { blockTimeMs: 1000 });
  assert.equal(p.closedTrips, 4);
  assert.equal(p.averageHoldMs, Math.round((100000 + 100000 + 100000) / 3), 'incomplete trip excluded from hold time');
});

test('performance statistics', () => {
  const t = tradesFor(records(history()), units);
  const p = performance(t.trips, { blockTimeMs: 1000 });
  assert.equal(p.wins, 2); assert.equal(p.losses, 2); assert.equal(p.winRateBps, 5000n);
  assert.equal(p.grossProfitCNS, 2099000000n); assert.equal(p.grossLossCNS, 3550000000n);
  assert.equal(p.profitFactorBps, 2099000000n * 10000n / 3550000000n);
  assert.equal(p.realizedCNS, -1451000000n);
  assert.equal(p.maxDrawdownCNS, 3500000000n, 'peak after trip 1, trough right after the liquidation');
  assert.equal(p.bestStreak, 1); assert.equal(p.worstStreak, 1); assert.equal(p.currentStreak, -1);
  assert.equal(p.longShareBps, 5000n); assert.equal(p.liquidatedTrips, 1);
  assert.equal(p.largestWinCNS, 1999000000n); assert.equal(p.largestLossCNS, -3500000000n);
  assert.equal(p.bestMarket.perpId, 2); assert.equal(p.worstMarket.perpId, 1);
  assert.equal(p.medianHoldMs, 100000); assert.equal(p.curve.length, 4); assert.equal(p.curve.at(-1).equityCNS, p.realizedCNS);
  assert.equal(p.averageWinCNS, 2099000000n / 2n); assert.equal(p.averageLossCNS, 3550000000n / 2n);
});

test('observations are plain sentences derived from the numbers', () => {
  const t = tradesFor(records(history()), units);
  const p = performance(t.trips, { blockTimeMs: 1000 });
  const notes = observations(p, t.trips, new Map([[1, 'BTC'], [2, 'ETH']]));
  assert.ok(notes.some(n => n.startsWith('Trades both directions')));
  assert.ok(notes.some(n => n.startsWith('Losses exceed gains')));
  assert.ok(notes.includes('Best market ETH, worst BTC.'));
  assert.ok(notes.some(n => n.includes('ended in liquidation')));
  assert.deepEqual(observations(performance([]), []), []);
});
