// Wallet analytics derived from the event index: trade list, realized PnL,
// win rate, profit factor, drawdown, streaks, hold time and market breakdown.
// Amounts in CNS (BigInt); ratios in basis points. Round trips are grouped
// per (market, side): an open starts one, increases add to it, decreases
// realize part of it, and a close, inversion, full liquidation or full
// deleveraging ends it. A trip that started before the indexed window is
// marked incomplete and excluded from hold-time statistics.
import * as m from './math.js';
import { TRADE_TYPES, REALIZING, B } from './index.js';

const notionalOf = (r, u) => u && r.pricePNS !== undefined && r.lotLNS !== undefined ? m.notionalCNS(B(r.pricePNS), B(r.lotLNS), u) : 0n;
const opt = v => v === undefined || v === null ? null : B(v);

export function tradesFor(records, units) {
  const open = new Map(); // `${perpId}:${side}` -> trip
  const trips = [], events = [];
  let realizedCNS = 0n, feesCNS = 0n, volumeCNS = 0n, fundingCNS = 0n;
  const newTrip = (r, complete) => ({ perpId: r.perpId, side: r.side, openBlock: BigInt(r.block), closeBlock: null, entryNotionalCNS: 0n, maxLotLNS: 0n, realizedCNS: 0n, fundingCNS: 0n, feesCNS: 0n, events: 0, complete, liquidated: false, deleveraged: false });
  for (const r of records) {
    if (!TRADE_TYPES.includes(r.type)) continue;
    const u = units.get(r.perpId);
    const notional = notionalOf(r, u);
    const realized = REALIZING.has(r.type) ? B(r.pnlCNS) + B(r.fundingCNS) : 0n;
    const fee = B(r.feeCNS);
    realizedCNS += realized; feesCNS += fee; volumeCNS += notional; if (REALIZING.has(r.type)) fundingCNS += B(r.fundingCNS);
    events.push({ block: BigInt(r.block), tx: r.tx, logIndex: r.logIndex, type: r.type, role: r.role ?? null, perpId: r.perpId, side: r.side, pricePNS: opt(r.pricePNS), lotLNS: opt(r.lotLNS), endLotLNS: opt(r.endLotLNS), notionalCNS: notional, realizedCNS: realized, pnlCNS: B(r.pnlCNS), fundingCNS: B(r.fundingCNS), feeCNS: fee, leverageHdths: opt(r.leverageHdths), depositCNS: opt(r.depositCNS) });
    const key = `${r.perpId}:${r.side}`;
    let trip = open.get(key);
    if (r.type === 'open' || !trip) { trip = newTrip(r, r.type === 'open'); open.set(key, trip); }
    trip.events++;
    if (r.type === 'open' || r.type === 'increase') { trip.entryNotionalCNS += notional; trip.feesCNS += fee; }
    else { trip.realizedCNS += realized; trip.fundingCNS += B(r.fundingCNS); trip.feesCNS += fee; if (r.type === 'liquidation') trip.liquidated = true; if (r.type === 'deleverage') trip.deleveraged = true; if (r.type === 'invert') trip.entryNotionalCNS += u ? m.notionalCNS(B(r.pricePNS), B(r.startLotLNS), u) : 0n; }
    if (r.endLotLNS !== undefined && B(r.endLotLNS) > trip.maxLotLNS) trip.maxLotLNS = B(r.endLotLNS);
    const ended = r.type === 'close' || r.type === 'invert' || (r.endLotLNS === 0 && r.type !== 'open');
    if (!ended) continue;
    trip.closeBlock = BigInt(r.block); trips.push(trip); open.delete(key);
    if (r.type === 'invert') { const flipped = newTrip({ ...r, side: r.side === m.LONG ? m.SHORT : m.LONG }, true); flipped.entryNotionalCNS = u ? m.notionalCNS(B(r.pricePNS), B(r.endLotLNS), u) : 0n; flipped.maxLotLNS = B(r.endLotLNS); flipped.events = 1; open.set(`${r.perpId}:${flipped.side}`, flipped); }
  }
  return { trips, openTrips: [...open.values()], events, realizedCNS, feesCNS, volumeCNS, fundingCNS };
}

export function performance(trips, { blockTimeMs = 300 } = {}) {
  const closed = trips.filter(t => t.closeBlock !== null);
  const wins = closed.filter(t => t.realizedCNS > 0n), losses = closed.filter(t => t.realizedCNS < 0n);
  const grossProfit = wins.reduce((a, t) => a + t.realizedCNS, 0n), grossLoss = -losses.reduce((a, t) => a + t.realizedCNS, 0n);
  let equity = 0n, peak = 0n, maxDrawdown = 0n;
  const curve = [];
  for (const t of closed) { equity += t.realizedCNS; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDrawdown) maxDrawdown = dd; curve.push({ block: t.closeBlock, equityCNS: equity }); }
  let streak = 0, bestStreak = 0, worstStreak = 0;
  for (const t of closed) { if (t.realizedCNS > 0n) { streak = streak > 0 ? streak + 1 : 1; bestStreak = Math.max(bestStreak, streak); } else if (t.realizedCNS < 0n) { streak = streak < 0 ? streak - 1 : -1; worstStreak = Math.min(worstStreak, streak); } }
  const holds = closed.filter(t => t.complete).map(t => Number(t.closeBlock - t.openBlock) * blockTimeMs).sort((a, b) => a - b);
  const byMarket = new Map();
  for (const t of closed) { const x = byMarket.get(t.perpId) ?? { perpId: t.perpId, trips: 0, wins: 0, realizedCNS: 0n, feesCNS: 0n, volumeCNS: 0n }; x.trips++; x.realizedCNS += t.realizedCNS; x.feesCNS += t.feesCNS; x.volumeCNS += t.entryNotionalCNS; if (t.realizedCNS > 0n) x.wins++; byMarket.set(t.perpId, x); }
  const markets = [...byMarket.values()].sort((a, b) => (b.realizedCNS > a.realizedCNS ? 1 : b.realizedCNS < a.realizedCNS ? -1 : 0));
  const longs = closed.filter(t => t.side === m.LONG).length;
  const sum = list => list.reduce((a, t) => a + t.realizedCNS, 0n);
  return {
    closedTrips: closed.length, wins: wins.length, losses: losses.length, winRateBps: closed.length ? BigInt(Math.round(wins.length / closed.length * 10000)) : null,
    grossProfitCNS: grossProfit, grossLossCNS: grossLoss, profitFactorBps: grossLoss > 0n ? m.floorDiv(grossProfit * 10000n, grossLoss) : null,
    realizedCNS: sum(closed), maxDrawdownCNS: maxDrawdown, curve,
    averageWinCNS: wins.length ? grossProfit / BigInt(wins.length) : null, averageLossCNS: losses.length ? grossLoss / BigInt(losses.length) : null,
    bestStreak, worstStreak: -worstStreak, currentStreak: streak,
    averageHoldMs: holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : null, medianHoldMs: holds.length ? holds[Math.floor(holds.length / 2)] : null,
    longShareBps: closed.length ? BigInt(Math.round(longs / closed.length * 10000)) : null,
    liquidatedTrips: closed.filter(t => t.liquidated).length, deleveragedTrips: closed.filter(t => t.deleveraged).length,
    largestWinCNS: wins.length ? wins.reduce((a, t) => (t.realizedCNS > a ? t.realizedCNS : a), 0n) : 0n,
    largestLossCNS: losses.length ? losses.reduce((a, t) => (t.realizedCNS < a ? t.realizedCNS : a), 0n) : 0n,
    bestMarket: markets[0] ?? null, worstMarket: markets.length > 1 ? markets.at(-1) : null, markets
  };
}

// Plain-language observations derived from the numbers (rule-based, no model).
export function observations(perf, trips, symbols = new Map()) {
  const out = [];
  if (!perf.closedTrips) return out;
  const name = id => symbols.get(id) ?? `#${id}`;
  if (perf.longShareBps !== null) out.push(perf.longShareBps >= 7000n ? 'Strong long bias: most round trips are longs.' : perf.longShareBps <= 3000n ? 'Strong short bias: most round trips are shorts.' : 'Trades both directions.');
  if (perf.profitFactorBps !== null) out.push(perf.profitFactorBps >= 15000n ? 'Profitable: gross gains exceed gross losses by more than half.' : perf.profitFactorBps < 10000n ? 'Losses exceed gains over the indexed window.' : 'Roughly break-even over the indexed window.');
  else if (perf.losses === 0 && perf.wins > 0) out.push('No losing round trip in the indexed window.');
  if (perf.averageHoldMs !== null) out.push(perf.averageHoldMs < 15 * 60000 ? 'Scalper: positions are held for minutes.' : perf.averageHoldMs < 6 * 3600000 ? 'Intraday: positions are held for hours.' : 'Swing trader: positions are held for many hours or days.');
  if (perf.bestMarket && perf.worstMarket) out.push(`Best market ${name(perf.bestMarket.perpId)}, worst ${name(perf.worstMarket.perpId)}.`);
  if (perf.liquidatedTrips) out.push(`${perf.liquidatedTrips} of ${perf.closedTrips} round trips ended in liquidation.`);
  if (perf.worstStreak >= 4) out.push(`Longest losing streak: ${perf.worstStreak} round trips.`);
  if (perf.averageWinCNS !== null && perf.averageLossCNS !== null && perf.averageLossCNS > perf.averageWinCNS * 2n) out.push('Average loss is more than twice the average win: losers are held longer than winners.');
  return out;
}
