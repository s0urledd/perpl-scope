// Wallet trader analytics from an account's event rows (ev_account order):
// round trips, realized PnL, win rate, profit factor, drawdown, streaks, hold
// time, per-market and per-side results and rule-based behaviour notes.
//
// Perpl keeps one position per account and market, so a round trip is the
// life of that position: it starts when the size leaves zero (open, or the
// new side of an inversion) and ends when it returns to zero (close, the old
// side of an inversion, a full liquidation, deleveraging or unwind). A trip
// already open when the history window starts is marked incomplete and left
// out of hold-time statistics. PnL is realized (delta PnL + funding) net of
// the fees paid on the trip's fills.
const B = v => (typeof v === 'bigint' ? v : BigInt(v ?? 0));
const LONG = 0, SHORT = 1;
const USER = new Set(['open', 'increase', 'decrease', 'close', 'invert']);
const REALIZING = new Set(['decrease', 'close', 'invert', 'liquidation', 'deleverage']);
const ENDING = new Set(['close', 'invert', 'liquidation', 'deleverage', 'unwind']);

function newTrip(r, side, complete) {
  return { market: Number(r.market), side, openTs: complete ? Number(r.ts) : null, firstTs: Number(r.ts), openBlock: Number(r.block), closeTs: null, closeBlock: null, entryNotional: 0n, exitNotional: 0n, maxLot: 0n, realized: 0n, funding: 0n, fees: 0n, events: 0, complete, liquidated: false, deleveraged: false, maxLeverage: 0 };
}

export function roundTrips(rows) {
  const open = new Map(); // market -> trip
  const trips = [];
  const totals = { realized: 0n, fees: 0n, funding: 0n, volume: 0n, trades: 0, liquidations: 0 };
  for (const r of rows) {
    const kind = r.kind;
    if (!USER.has(kind) && !ENDING.has(kind)) continue;
    const market = Number(r.market), side = Number(r.side);
    const notional = B(r.notional), fee = B(r.fee) + B(r.builder_fee);
    const realized = REALIZING.has(kind) ? B(r.pnl) + B(r.funding) : 0n;
    if (USER.has(kind) || (kind === 'liquidation' && r.role === 'taker')) { totals.volume += notional; totals.trades++; totals.fees += fee; }
    if (kind === 'liquidation') totals.liquidations++;
    totals.realized += realized; if (REALIZING.has(kind)) totals.funding += B(r.funding);

    let trip = open.get(market);
    if (kind === 'open') {
      if (trip) { trip.closeTs = Number(r.ts); trip.closeBlock = Number(r.block); trips.push(trip); } // defensive: missed close
      trip = newTrip(r, side, true); open.set(market, trip);
    }
    const oldSide = kind === 'invert' ? 1 - side : side;
    if (!trip) { trip = newTrip(r, oldSide, false); open.set(market, trip); }
    trip.events++;
    if (Number(r.leverage) > trip.maxLeverage) trip.maxLeverage = Number(r.leverage);
    if (kind === 'open' || kind === 'increase') { trip.entryNotional += notional; trip.fees += fee; if (B(r.end_lot) > trip.maxLot) trip.maxLot = B(r.end_lot); continue; }
    // Reducing events: realize on the current trip.
    trip.realized += realized; trip.funding += REALIZING.has(kind) ? B(r.funding) : 0n;
    if (kind === 'invert') {
      // The fill closes start_lot and opens end_lot on the other side; its fee
      // is charged for building the new position.
      const lot = B(r.lot), start = B(r.start_lot), end = B(r.end_lot);
      const closing = lot > 0n ? notional * start / lot : 0n;
      trip.exitNotional += closing;
      if (!trip.complete && trip.maxLot < start) trip.maxLot = start;
      trip.closeTs = Number(r.ts); trip.closeBlock = Number(r.block); trips.push(trip);
      const next = newTrip(r, side, true);
      next.entryNotional = notional - closing; next.fees = fee; next.maxLot = end; next.events = 1; next.maxLeverage = Number(r.leverage);
      open.set(market, next);
      continue;
    }
    trip.fees += fee;
    trip.exitNotional += notional;
    if (!trip.complete && trip.maxLot < B(r.start_lot)) trip.maxLot = B(r.start_lot);
    if (kind === 'liquidation') trip.liquidated = true;
    if (kind === 'deleverage') trip.deleveraged = true;
    const ended = kind === 'close' || kind === 'unwind' || B(r.end_lot) === 0n;
    if (ended) { trip.closeTs = Number(r.ts); trip.closeBlock = Number(r.block); trips.push(trip); open.delete(market); }
  }
  for (const t of trips) t.net = t.realized - t.fees;
  const openTrips = [...open.values()].map(t => ({ ...t, net: t.realized - t.fees }));
  return { trips, openTrips, totals };
}

const median = sorted => (sorted.length ? sorted[Math.floor(sorted.length / 2)] : null);

export function performance(trips) {
  const closed = trips.filter(t => t.closeTs !== null).sort((a, b) => a.closeBlock - b.closeBlock);
  const wins = closed.filter(t => t.net > 0n), losses = closed.filter(t => t.net < 0n);
  const grossProfit = wins.reduce((a, t) => a + t.net, 0n), grossLoss = -losses.reduce((a, t) => a + t.net, 0n);
  let equity = 0n, peak = 0n, maxDrawdown = 0n, drawdownStart = null, worstFrom = null, worstTo = null;
  const curve = [];
  for (const t of closed) {
    equity += t.net;
    if (equity > peak) { peak = equity; drawdownStart = t.closeTs; }
    const dd = peak - equity;
    if (dd > maxDrawdown) { maxDrawdown = dd; worstFrom = drawdownStart; worstTo = t.closeTs; }
    curve.push({ ts: t.closeTs, equity });
  }
  let streak = 0, bestStreak = 0, worstStreak = 0;
  for (const t of closed) {
    if (t.net > 0n) { streak = streak > 0 ? streak + 1 : 1; bestStreak = Math.max(bestStreak, streak); }
    else if (t.net < 0n) { streak = streak < 0 ? streak - 1 : -1; worstStreak = Math.min(worstStreak, streak); }
  }
  const holds = closed.filter(t => t.complete).map(t => t.closeTs - t.openTs).sort((a, b) => a - b);
  const winHolds = wins.filter(t => t.complete).map(t => t.closeTs - t.openTs).sort((a, b) => a - b);
  const lossHolds = losses.filter(t => t.complete).map(t => t.closeTs - t.openTs).sort((a, b) => a - b);
  const byMarket = new Map();
  for (const t of closed) {
    const x = byMarket.get(t.market) ?? { market: t.market, trips: 0, wins: 0, net: 0n, realized: 0n, fees: 0n, volume: 0n, longs: 0, shorts: 0 };
    x.trips++; x.net += t.net; x.realized += t.realized; x.fees += t.fees; x.volume += t.entryNotional + t.exitNotional;
    if (t.net > 0n) x.wins++; if (t.side === LONG) x.longs++; else x.shorts++;
    byMarket.set(t.market, x);
  }
  const markets = [...byMarket.values()].sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0));
  const sideStats = side => { const list = closed.filter(t => t.side === side); const w = list.filter(t => t.net > 0n).length; return { trips: list.length, wins: w, win_rate: list.length ? w / list.length : null, net: list.reduce((a, t) => a + t.net, 0n) }; };
  const sum = list => list.reduce((a, t) => a + t.net, 0n);
  return {
    closedTrips: closed.length, wins: wins.length, losses: losses.length, breakeven: closed.length - wins.length - losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    grossProfit, grossLoss, profitFactor: grossLoss > 0n ? Number(grossProfit * 10000n / grossLoss) / 10000 : null,
    net: sum(closed), realized: closed.reduce((a, t) => a + t.realized, 0n), fees: closed.reduce((a, t) => a + t.fees, 0n),
    averageWin: wins.length ? grossProfit / BigInt(wins.length) : null, averageLoss: losses.length ? grossLoss / BigInt(losses.length) : null,
    expectancy: closed.length ? sum(closed) / BigInt(closed.length) : null,
    largestWin: wins.length ? wins.reduce((a, t) => (t.net > a ? t.net : a), 0n) : null, largestLoss: losses.length ? losses.reduce((a, t) => (t.net < a ? t.net : a), 0n) : null,
    maxDrawdown, drawdownFrom: worstFrom, drawdownTo: worstTo, curve,
    bestStreak, worstStreak: -worstStreak, currentStreak: streak,
    averageHold: holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : null, medianHold: median(holds),
    medianWinHold: median(winHolds), medianLossHold: median(lossHolds),
    long: sideStats(LONG), short: sideStats(SHORT),
    liquidatedTrips: closed.filter(t => t.liquidated).length, deleveragedTrips: closed.filter(t => t.deleveraged).length,
    bestMarket: markets[0] ?? null, worstMarket: markets.length > 1 ? markets.at(-1) : null, markets
  };
}

// Rule-based behaviour notes (no model): each states the evidence it rests on.
export function insights(perf, rows, { symbol = id => `#${id}` } = {}) {
  const out = [];
  if (!perf.closedTrips) return out;
  const pct = x => `${Math.round(x * 100)}%`;
  const dur = s => (s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);
  if (perf.long.trips + perf.short.trips >= 5) {
    const share = perf.long.trips / (perf.long.trips + perf.short.trips);
    if (share >= 0.7) out.push({ tag: 'bias', text: `Long bias: ${pct(share)} of round trips are longs.` });
    else if (share <= 0.3) out.push({ tag: 'bias', text: `Short bias: ${pct(1 - share)} of round trips are shorts.` });
    if (perf.long.win_rate !== null && perf.short.win_rate !== null && perf.long.trips >= 5 && perf.short.trips >= 5 && Math.abs(perf.long.win_rate - perf.short.win_rate) >= 0.15)
      out.push({ tag: 'edge', text: `Wins more often ${perf.long.win_rate > perf.short.win_rate ? 'long' : 'short'} (${pct(Math.max(perf.long.win_rate, perf.short.win_rate))} vs ${pct(Math.min(perf.long.win_rate, perf.short.win_rate))}).` });
  }
  if (perf.medianHold !== null) out.push({ tag: 'style', text: perf.medianHold < 900 ? `Scalper: median hold ${dur(perf.medianHold)}.` : perf.medianHold < 6 * 3600 ? `Intraday: median hold ${dur(perf.medianHold)}.` : `Swing: median hold ${dur(perf.medianHold)}.` });
  if (perf.medianWinHold !== null && perf.medianLossHold !== null && perf.losses >= 3 && perf.wins >= 3 && perf.medianLossHold > perf.medianWinHold * 2)
    out.push({ tag: 'discipline', text: `Holds losers longer than winners (median ${dur(perf.medianLossHold)} vs ${dur(perf.medianWinHold)}).` });
  if (perf.averageWin !== null && perf.averageLoss !== null && perf.averageLoss > perf.averageWin * 2n && perf.winRate !== null && perf.winRate > 0.5)
    out.push({ tag: 'risk', text: 'High win rate but average loss is more than twice the average win.' });
  if (perf.profitFactor !== null) out.push({ tag: 'result', text: perf.profitFactor >= 1.5 ? `Profitable: profit factor ${perf.profitFactor.toFixed(2)}.` : perf.profitFactor < 1 ? `Net losing: profit factor ${perf.profitFactor.toFixed(2)}.` : `Around break-even: profit factor ${perf.profitFactor.toFixed(2)}.` });
  if (perf.bestMarket && perf.worstMarket && perf.bestMarket.net > 0n && perf.worstMarket.net < 0n) out.push({ tag: 'markets', text: `Best market ${symbol(perf.bestMarket.market)}, worst ${symbol(perf.worstMarket.market)}.` });
  if (perf.liquidatedTrips) out.push({ tag: 'risk', text: `${perf.liquidatedTrips} of ${perf.closedTrips} round trips ended in liquidation.` });
  if (perf.worstStreak >= 5) out.push({ tag: 'streak', text: `Longest losing streak: ${perf.worstStreak} trips in a row.` });
  const levs = rows.filter(r => (r.kind === 'open' || r.kind === 'increase') && Number(r.leverage) > 0).map(r => Number(r.leverage) / 100);
  if (levs.length >= 5) { levs.sort((a, b) => a - b); const med = levs[Math.floor(levs.length / 2)]; out.push({ tag: 'leverage', text: `Median leverage on entries: ${med.toFixed(1)}x${med >= 20 ? ' (aggressive)' : ''}.` }); }
  const hours = new Array(24).fill(0); let n = 0;
  for (const r of rows) if (USER.has(r.kind)) { hours[new Date(Number(r.ts) * 1000).getUTCHours()]++; n++; }
  if (n >= 30) { const top = hours.map((c, h) => [h, c]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h).sort((a, b) => a - b); out.push({ tag: 'timing', text: `Most active around ${top.map(h => `${String(h).padStart(2, '0')}:00`).join(', ')} UTC.` }); }
  return out;
}

// Trades per UTC weekday and hour (activity heatmap).
export function activityGrid(rows) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of rows) if (USER.has(r.kind)) { const d = new Date(Number(r.ts) * 1000); grid[d.getUTCDay()][d.getUTCHours()]++; }
  return grid;
}
