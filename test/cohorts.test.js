import test from 'node:test';
import assert from 'node:assert/strict';
import { cohortTable } from '../src/cohorts.js';

const positions = [
  { account: 1, market: 1, symbol: 'BTC', side: 'long', notional: 150000, upnl: 500 },
  { account: 1, market: 20, symbol: 'ETH', side: 'short', notional: 30000, upnl: -100 },
  { account: 2, market: 1, symbol: 'BTC', side: 'short', notional: 20000, upnl: -50 },
  { account: 3, market: 1, symbol: 'BTC', side: 'long', notional: 500, upnl: 5 },
  { account: 4, market: 10, symbol: 'MON', side: 'short', notional: 2000, upnl: 10 }
];
const pnl = new Map([[1, 25000], [2, -12000], [3, 50]]); // account 4 has no indexed trades yet

test('size cohorts by total open notional, with sides and profit', () => {
  const t = cohortTable(positions, id => pnl.get(id));
  assert.equal(t.accounts, 4);
  const [whale, dolphin, fish, shrimp] = t.by_size;
  assert.equal(whale.accounts, 1);
  assert.equal(whale.long_notional, 150000); assert.equal(whale.short_notional, 30000);
  assert.equal(whale.net_long_accounts, 1); assert.equal(whale.unrealized_pnl, 400); assert.equal(whale.in_profit, 1);
  assert.deepEqual(whale.markets.map(m => m.symbol), ['BTC', 'ETH']);
  assert.equal(dolphin.accounts, 1); assert.equal(dolphin.net_short_accounts, 1);
  assert.equal(fish.accounts, 1); assert.equal(shrimp.accounts, 1);
  assert.equal(t.by_size.reduce((a, c) => a + c.accounts, 0), 4, 'every account in exactly one size cohort');
});

test('track-record cohorts by net PnL; accounts without history are counted apart', () => {
  const t = cohortTable(positions, id => pnl.get(id));
  const byKey = Object.fromEntries(t.by_pnl.map(c => [c.key, c.accounts]));
  assert.deepEqual(byKey, { top: 1, winner: 1, loser: 0, rekt: 1 });
  assert.equal(t.unranked, 1);
  assert.equal(t.by_pnl[0].top[0].account, 1);
  assert.equal(t.by_pnl[0].long_share_pct, 83.33);
});
