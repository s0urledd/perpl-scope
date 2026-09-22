// Protocol statistics, time series, leaderboards and wallet analytics built on
// the event index. Every window is a block range on the collector's current
// snapshot block; exact sums come from raw records, longer windows from hourly
// aggregates, and each response says which and how much of the range the
// index actually covers.
import * as m from './math.js';
import { tradesFor, performance, observations } from './analytics.js';
import { metrics as computeMetrics } from './state.js';
import { B } from './index.js';

export const WINDOWS = { '1h': 3600, '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, all: null };
export const TRADE_COLUMNS = ['block', 'timestamp', 'tx', 'type', 'role', 'market_id', 'symbol', 'side', 'price', 'size', 'notional', 'realized_pnl', 'delta_pnl', 'funding', 'fee', 'leverage'];
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function createStats({ collector, reference = null, now = () => Date.now() }) {
  const { state, index } = collector;
  const cd = () => state.exchangeInfo?.collateralDecimals ?? 6;
  const dec = (value, decimals = cd()) => value === null || value === undefined ? null : m.toDecimalString(value, decimals);
  const pct = bps => bps === null || bps === undefined ? null : Number(bps) / 100;
  const ratio = (a, b) => b > 0n ? Number(a * 1000000n / b) / 10000 : null; // percent with 4 decimals
  const blockTimeMs = () => state.stats.blockTimeMs || 300;
  const tsOf = block => state.block ? Math.round(state.block.timestamp - Number(state.block.number - BigInt(block)) * blockTimeMs() / 1000) : null;
  const unitsMap = () => new Map([...state.markets.values()].map(mk => [mk.id, m.units(mk.priceDecimals, mk.lotDecimals, cd())]));
  const symbols = () => new Map([...state.markets.values()].map(mk => [mk.id, mk.symbol]));
  const cache = new Map();
  function cached(key, compute) {
    const k = `${state.block?.hash}:${key}`;
    if (cache.has(k)) return cache.get(k);
    if (cache.size > 32) cache.clear();
    const value = compute(); cache.set(k, value); return value;
  }

  function windowOf(query) { const w = query.get('window') || '24h'; if (!Object.hasOwn(WINDOWS, w)) throw bad('INVALID_WINDOW'); return w; }
  function rangeFor(window) {
    const to = state.block.number;
    if (WINDOWS[window] === null) return { from: 0n, to };
    const blocks = BigInt(Math.round(WINDOWS[window] * 1000 / blockTimeMs()));
    return { from: to > blocks ? to - blocks : 0n, to };
  }
  function coverageView(agg) {
    return { exact: agg.exact, partial: agg.partial, covered_from_block: agg.coveredFrom?.toString() ?? null, covered_from_ts: agg.coveredFrom === null ? null : tsOf(agg.coveredFrom), covered_to_block: agg.coveredTo?.toString() ?? null, backfill: backfillView() };
  }
  function backfillView() { const b = index.backfill; return { done: b.done, complete: b.complete, target_block: b.target?.toString() ?? null, reached_block: b.contiguousFrom?.toString() ?? null, error: b.error, running: collector.backfilling }; }
  // Snapshot closest to `block` from below (window start), or the earliest above it.
  function snapshotNear(block) {
    let best = null;
    for (const s of index.snapshots.values()) { if (s.block <= block && (!best || s.block > best.block)) best = s; }
    if (!best) for (const s of index.snapshots.values()) { if (s.block > block && (!best || s.block < best.block)) best = s; }
    return best;
  }

  function stats(query) {
    const window = windowOf(query);
    return cached(`stats:${window}`, () => {
      const { from, to } = rangeFor(window);
      const units = unitsMap(), c = cd();
      const agg = index.aggregate(from, to, units);
      const computed = computeMetrics(state), t = computed.totals;
      const start = snapshotNear(from);
      const info = state.exchangeInfo;
      const longCNS = computed.markets.reduce((a, x) => a + x.metrics.oi.longNotionalCNS, 0n), shortCNS = computed.markets.reduce((a, x) => a + x.metrics.oi.shortNotionalCNS, 0n);
      const venue = reference?.last ? { fetched_at: reference.last.at, volume_24h: dec(reference.last.markets.reduce((a, x) => a + (x.dailyVolume === null ? 0n : BigInt(x.dailyVolume)), 0n), c) } : null;
      const day = window === '24h' ? agg : index.aggregate(rangeFor('24h').from, to, units);
      const allowance = info.withdrawAllowance;
      const markets = computed.markets.map(({ market, metrics: x }) => {
        const mk = agg.markets.get(market.id);
        const ref = reference?.last?.markets.find(r => r.id === market.id) ?? null;
        const oi = x.oi.longNotionalCNS + x.oi.shortNotionalCNS;
        return {
          id: market.id, symbol: market.symbol, name: market.name, active: market.status === 4, mark: dec(market.markPNS, market.priceDecimals), price_decimals: market.priceDecimals,
          volume: dec(mk?.volumeCNS ?? 0n, c), trades: mk?.trades ?? 0, fees: dec(mk?.feesCNS ?? 0n, c), long_volume: dec(mk?.longVolumeCNS ?? 0n, c), short_volume: dec(mk?.shortVolumeCNS ?? 0n, c),
          liquidations: mk?.liquidations ?? 0, liquidated_notional: dec(mk?.liquidatedCNS ?? 0n, c), realized_pnl: dec(mk?.realizedPnlCNS ?? 0n, c),
          open_interest: dec(oi, c), long_open_interest: dec(x.oi.longNotionalCNS, c), short_open_interest: dec(x.oi.shortNotionalCNS, c), positions: x.positions.length, max_leverage: Number(market.initHdths) / 100,
          // Perpl's long and short open interest are equal by construction; skew lives in who holds it and who is aggressing.
          skew: { long_positions: x.long.count, short_positions: x.short.count, long_position_share_pct: ratio(BigInt(x.long.count), BigInt(x.long.count + x.short.count)), long_deposit: dec(x.long.depositCNS, c), short_deposit: dec(x.short.depositCNS, c), long_average_leverage: x.long.averageLeverageBps === null ? null : Number(x.long.averageLeverageBps) / 10000, short_average_leverage: x.short.averageLeverageBps === null ? null : Number(x.short.averageLeverageBps) / 10000, taker_buy: dec(mk?.takerBuyCNS ?? 0n, c), taker_sell: dec(mk?.takerSellCNS ?? 0n, c), taker_buy_share_pct: ratio(mk?.takerBuyCNS ?? 0n, (mk?.takerBuyCNS ?? 0n) + (mk?.takerSellCNS ?? 0n)) },
          oi_cap_utilisation_pct: pct(x.oi.utilisationBps), funding_rate_pct: m.fundingRateFraction(market.fundingRatePct100k) * 100, insurance: dec(market.insuranceBalanceCNS, c),
          venue_volume_24h: ref?.dailyVolume === null || ref?.dailyVolume === undefined ? null : dec(BigInt(ref.dailyVolume), c), chain_volume_24h: dec(day.markets.get(market.id)?.volumeCNS ?? 0n, c),
          volume_share_pct: ratio(mk?.volumeCNS ?? 0n, agg.volumeCNS)
        };
      }).sort((a, b) => Number(b.volume) - Number(a.volume));
      return {
        window, from_block: from.toString(), to_block: to.toString(), from_ts: tsOf(from), to_ts: state.block.timestamp, coverage: coverageView(agg),
        activity: { volume: dec(agg.volumeCNS, c), trades: agg.trades, taker_buy: dec(agg.takerBuyCNS, c), taker_sell: dec(agg.takerSellCNS, c), taker_buy_share_pct: ratio(agg.takerBuyCNS, agg.takerBuyCNS + agg.takerSellCNS), position_changes: agg.positionChanges, opens: agg.opens, closes: agg.closes, active_traders: agg.activeAccounts, new_accounts: agg.newAccounts, realized_pnl: dec(agg.realizedPnlCNS, c) },
        fees: { total: dec(agg.feesCNS, c), maker: dec(agg.makerFeesCNS, c), taker: dec(agg.takerFeesCNS, c), builder: dec(agg.builderFeesCNS, c), insurance: dec(agg.insuranceFeesCNS, c), protocol: dec(agg.protocolFeesCNS, c), take_rate_bps: agg.volumeCNS > 0n ? Number(agg.feesCNS * 1000000n / agg.volumeCNS) / 100 : null },
        flows: { deposits: dec(agg.depositsCNS, c), withdrawals: dec(agg.withdrawalsCNS, c), net: dec(agg.netFlowCNS, c), deposit_count: agg.deposits, withdrawal_count: agg.withdrawals },
        liquidations: { count: agg.liquidations, notional: dec(agg.liquidatedCNS, c), deleverages: agg.deleverages, share_of_volume_pct: ratio(agg.liquidatedCNS, agg.volumeCNS) },
        current: { open_interest: dec(t.notionalCNS, c), long_open_interest: dec(longCNS, c), short_open_interest: dec(shortCNS, c), long_positions: computed.markets.reduce((a, x) => a + x.metrics.long.count, 0), short_positions: computed.markets.reduce((a, x) => a + x.metrics.short.count, 0), tvl: dec(info.balanceCNS, c), insurance: dec(t.insuranceCNS, c), protocol_balance: dec(info.protocolBalanceCNS, c), accounts: info.numberOfAccounts.toString(), positions: t.positions, markets: t.markets, liquidatable: t.liquidatable,
          withdrawal_limit: allowance ? { allowance: dec(allowance.allowanceCNS, c), refill_per_hour: dec(allowance.cnsPerBlock * BigInt(Math.round(3600000 / blockTimeMs())), c), expiry_block: allowance.expiryBlock.toString(), expires_in_seconds: allowance.expiryBlock > to ? Math.round(Number(allowance.expiryBlock - to) * blockTimeMs() / 1000) : 0, share_of_tvl_pct: ratio(allowance.allowanceCNS, info.balanceCNS) } : null },
        change: start ? { since_block: start.block.toString(), since_ts: start.ts, open_interest: dec(start.oiCNS, c), open_interest_pct: start.oiCNS > 0n ? Number((t.notionalCNS - start.oiCNS) * 10000n / start.oiCNS) / 100 : null, tvl: dec(start.tvlCNS, c), tvl_pct: start.tvlCNS > 0n ? Number((info.balanceCNS - start.tvlCNS) * 10000n / start.tvlCNS) / 100 : null, accounts: start.accounts === undefined ? null : (info.numberOfAccounts - BigInt(start.accounts)).toString() } : null,
        venue: venue ? { ...venue, chain_volume_24h: dec(day.volumeCNS, c), delta_pct: venue.volume_24h !== null && Number(venue.volume_24h) > 0 ? (Number(dec(day.volumeCNS, c)) / Number(venue.volume_24h) - 1) * 100 : null, note: 'Perpl API dva per market, reference only' } : null,
        markets
      };
    });
  }

  function series(query) {
    const window = windowOf(query);
    const marketId = /^\d{1,6}$/.test(query.get('market') ?? '') ? Number(query.get('market')) : null;
    return cached(`series:${window}:${marketId}`, () => {
      const { from, to } = rangeFor(window);
      const c = cd(), pd = marketId === null ? null : state.markets.get(marketId)?.priceDecimals ?? 0;
      let cumulative = 0n;
      const points = index.series(from, to).map(b => {
        const mk = marketId === null ? null : b.markets.get(marketId);
        const volume = marketId === null ? b.volumeCNS : mk?.volumeCNS ?? 0n;
        cumulative += volume;
        const snap = b.snapshot, sm = snap && marketId !== null ? snap.markets.get(marketId) ?? null : null;
        return {
          block: b.fromBlock.toString(), to_block: b.toBlock.toString(), ts: b.ts ?? tsOf(b.fromBlock), complete: b.complete,
          volume: dec(volume, c), cumulative_volume: dec(cumulative, c), trades: marketId === null ? b.trades : mk?.trades ?? 0, fees: dec(marketId === null ? b.feesCNS : mk?.feesCNS ?? 0n, c), taker_buy: dec(marketId === null ? b.takerBuyCNS : mk?.takerBuyCNS ?? 0n, c), taker_sell: dec(marketId === null ? b.takerSellCNS : mk?.takerSellCNS ?? 0n, c),
          active_traders: b.activeAccounts, new_accounts: b.newAccounts, deposits: dec(b.depositsCNS, c), withdrawals: dec(b.withdrawalsCNS, c), net_flow: dec(b.depositsCNS - b.withdrawalsCNS, c),
          liquidations: marketId === null ? b.liquidations : mk?.liquidations ?? 0, liquidated_notional: dec(marketId === null ? b.liquidatedCNS : mk?.liquidatedCNS ?? 0n, c), realized_pnl: dec(marketId === null ? b.realizedPnlCNS : mk?.realizedPnlCNS ?? 0n, c),
          open_interest: snap ? dec(marketId === null ? snap.oiCNS : sm ? sm.longCNS + sm.shortCNS : null, c) : null, long_open_interest: snap ? dec(marketId === null ? snap.longCNS : sm?.longCNS ?? null, c) : null, short_open_interest: snap ? dec(marketId === null ? snap.shortCNS : sm?.shortCNS ?? null, c) : null,
          tvl: snap ? dec(snap.tvlCNS, c) : null, insurance: snap ? dec(marketId === null ? snap.insuranceCNS : sm?.insuranceCNS ?? null, c) : null, accounts: snap?.accounts?.toString() ?? null,
          mark: sm ? dec(sm.markPNS, pd) : null, funding_rate_pct: sm ? m.fundingRateFraction(sm.fundingRatePct100k) * 100 : null, snapshot_block: snap?.block?.toString() ?? null
        };
      });
      return { window, market_id: marketId, from_block: from.toString(), to_block: to.toString(), bucket_blocks: index.bucketBlocks.toString(), bucket_seconds: Math.round(Number(index.bucketBlocks) * blockTimeMs() / 1000), coverage: coverageView(index.aggregate(from, to, null)), points };
    });
  }

  const SORTS = { pnl: (a, b) => b.realizedCNS - a.realizedCNS, loss: (a, b) => a.realizedCNS - b.realizedCNS, volume: (a, b) => b.volumeCNS - a.volumeCNS, liquidated: (a, b) => b.liquidatedCNS - a.liquidatedCNS, fees: (a, b) => b.feesCNS - a.feesCNS, trades: (a, b) => BigInt(b.trades - a.trades), deposits: (a, b) => b.depositsCNS - a.depositsCNS, withdrawals: (a, b) => b.withdrawalsCNS - a.withdrawalsCNS };
  function leaderboard(query) {
    const window = windowOf(query);
    const by = query.get('by') || 'pnl';
    if (!Object.hasOwn(SORTS, by)) throw bad('INVALID_SORT');
    const limit = Math.min(Math.max(Number(query.get('limit')) || 25, 1), 100);
    const { from, to } = rangeFor(window);
    const rows = cached(`leaderboard:${window}:${by}`, () => {
      const list = [...index.accountStats(from, to, unitsMap()).values()];
      const cmp = SORTS[by];
      return list.sort((a, b) => { const d = cmp(a, b); return d > 0n ? 1 : d < 0n ? -1 : 0; });
    });
    const c = cd();
    const openOf = id => { let notional = 0n, count = 0; for (const { market, metrics: x } of computeMetrics(state).markets) { const p = x.positions.find(q => q.accountId === id); if (p) { count++; notional += p.markNotionalCNS; } } return { count, notional }; };
    return { window, by, from_block: from.toString(), to_block: to.toString(), coverage: coverageView(index.aggregate(from, to, null)), accounts: rows.length, rows: rows.slice(0, limit).map((r, i) => { const open = openOf(r.accountId); return { rank: i + 1, account_id: r.accountId.toString(), realized_pnl: dec(r.realizedCNS, c), volume: dec(r.volumeCNS, c), trades: r.trades, fees: dec(r.feesCNS, c), liquidations: r.liquidations, liquidated_notional: dec(r.liquidatedCNS, c), deposits: dec(r.depositsCNS, c), withdrawals: dec(r.withdrawalsCNS, c), net_flow: dec(r.depositsCNS - r.withdrawalsCNS, c), markets: [...r.markets].map(id => symbols().get(id) ?? `#${id}`), last_block: r.lastBlock.toString(), last_ts: tsOf(r.lastBlock), open_positions: open.count, open_notional: dec(open.notional, c) }; }) };
  }

  // Trade history, round trips, performance and observations for one account.
  function account(accountId, { limit = 200 } = {}) {
    const records = index.accountRecords(accountId);
    const units = unitsMap(), c = cd(), names = symbols();
    const trades = tradesFor(records, units);
    const perf = performance(trades.trips, { blockTimeMs: blockTimeMs() });
    const market = id => state.markets.get(id);
    const event = e => { const mk = market(e.perpId); return { block: e.block.toString(), timestamp: tsOf(e.block), tx: e.tx, type: e.type, role: e.role, market_id: e.perpId, symbol: mk?.symbol ?? null, side: e.side === m.LONG ? 'long' : 'short', price: mk && e.pricePNS !== null ? dec(e.pricePNS, mk.priceDecimals) : null, size: mk && e.lotLNS !== null ? dec(e.lotLNS, mk.lotDecimals) : null, notional: dec(e.notionalCNS, c), realized_pnl: dec(e.realizedCNS, c), delta_pnl: dec(e.pnlCNS, c), funding: dec(e.fundingCNS, c), fee: dec(e.feeCNS, c), leverage: e.leverageHdths === null ? null : Number(e.leverageHdths) / 100 }; };
    const trip = t => ({ market_id: t.perpId, symbol: market(t.perpId)?.symbol ?? null, side: t.side === m.LONG ? 'long' : 'short', open_block: t.openBlock.toString(), open_ts: tsOf(t.openBlock), close_block: t.closeBlock?.toString() ?? null, close_ts: t.closeBlock === null ? null : tsOf(t.closeBlock), hold_seconds: t.closeBlock === null || !t.complete ? null : Math.round(Number(t.closeBlock - t.openBlock) * blockTimeMs() / 1000), entry_notional: dec(t.entryNotionalCNS, c), max_size: market(t.perpId) ? dec(t.maxLotLNS, market(t.perpId).lotDecimals) : null, realized_pnl: dec(t.realizedCNS, c), funding: dec(t.fundingCNS, c), fees: dec(t.feesCNS, c), return_on_notional_pct: t.entryNotionalCNS > 0n ? Number(t.realizedCNS * 1000000n / t.entryNotionalCNS) / 10000 : null, events: t.events, complete: t.complete, liquidated: t.liquidated, deleveraged: t.deleveraged });
    const flows = records.filter(r => r.type === 'deposit' || r.type === 'withdrawal').map(r => ({ block: String(r.block), timestamp: tsOf(r.block), tx: r.tx, type: r.type, amount: dec(B(r.amountCNS), c), balance_after: dec(B(r.balanceCNS), c) }));
    const deposits = records.filter(r => r.type === 'deposit').reduce((a, r) => a + B(r.amountCNS), 0n), withdrawals = records.filter(r => r.type === 'withdrawal').reduce((a, r) => a + B(r.amountCNS), 0n);
    const ms = v => v === null ? null : Math.round(v / 1000);
    return {
      coverage: { from_block: index.covered.from?.toString() ?? null, from_ts: index.covered.from === null ? null : tsOf(index.covered.from), to_block: index.covered.to?.toString() ?? null, records: records.length, backfill: backfillView() },
      summary: { trades: trades.events.length, volume: dec(trades.volumeCNS, c), realized_pnl: dec(trades.realizedCNS, c), fees: dec(trades.feesCNS, c), funding: dec(trades.fundingCNS, c), net_pnl: dec(trades.realizedCNS - trades.feesCNS, c), deposits: dec(deposits, c), withdrawals: dec(withdrawals, c), net_flow: dec(deposits - withdrawals, c), open_trips: trades.openTrips.length },
      performance: { closed_trips: perf.closedTrips, wins: perf.wins, losses: perf.losses, win_rate_pct: pct(perf.winRateBps), profit_factor: perf.profitFactorBps === null ? null : Number(perf.profitFactorBps) / 10000, gross_profit: dec(perf.grossProfitCNS, c), gross_loss: dec(perf.grossLossCNS, c), realized_pnl: dec(perf.realizedCNS, c), max_drawdown: dec(perf.maxDrawdownCNS, c), average_win: dec(perf.averageWinCNS, c), average_loss: dec(perf.averageLossCNS, c), largest_win: dec(perf.largestWinCNS, c), largest_loss: dec(perf.largestLossCNS, c), best_streak: perf.bestStreak, worst_streak: perf.worstStreak, current_streak: perf.currentStreak, average_hold_seconds: ms(perf.averageHoldMs), median_hold_seconds: ms(perf.medianHoldMs), long_share_pct: pct(perf.longShareBps), liquidated_trips: perf.liquidatedTrips, deleveraged_trips: perf.deleveragedTrips, best_market: perf.bestMarket ? { market_id: perf.bestMarket.perpId, symbol: names.get(perf.bestMarket.perpId) ?? null, realized_pnl: dec(perf.bestMarket.realizedCNS, c), trips: perf.bestMarket.trips } : null, worst_market: perf.worstMarket ? { market_id: perf.worstMarket.perpId, symbol: names.get(perf.worstMarket.perpId) ?? null, realized_pnl: dec(perf.worstMarket.realizedCNS, c), trips: perf.worstMarket.trips } : null, markets: perf.markets.map(x => ({ market_id: x.perpId, symbol: names.get(x.perpId) ?? null, trips: x.trips, wins: x.wins, realized_pnl: dec(x.realizedCNS, c), fees: dec(x.feesCNS, c), volume: dec(x.volumeCNS, c) })), equity_curve: perf.curve.map(p => ({ block: p.block.toString(), ts: tsOf(p.block), equity: dec(p.equityCNS, c) })) },
      observations: observations(perf, trades.trips, names),
      trips: trades.trips.slice().reverse().slice(0, 100).map(trip), open_trips: trades.openTrips.map(trip),
      history: trades.events.slice(-limit).reverse().map(event), flows: flows.reverse().slice(0, 100)
    };
  }

  function indexStatus() {
    const s = index.status();
    return { records: s.records, accounts: s.accounts, buckets: s.buckets, snapshots: s.snapshots, covered_from_block: s.covered.from?.toString() ?? null, covered_from_ts: s.covered.from === null ? null : tsOf(s.covered.from), covered_to_block: s.covered.to?.toString() ?? null, window_blocks: s.windowBlocks.toString(), bucket_blocks: s.bucketBlocks.toString(), history_blocks: s.historyBlocks.toString(), backfill: backfillView(), options: { log_range: collector.options.indexLogRange.toString(), concurrency: collector.options.indexConcurrency, snapshots: collector.options.indexSnapshots } };
  }

  return { stats, series, leaderboard, account, indexStatus, windowOf, rangeFor, tsOf };
}
