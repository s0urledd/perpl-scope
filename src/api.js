// HTTP API and static dashboard. Every JSON response carries the snapshot
// block, hash and freshness it was computed from, so consumers can tell
// exactly which chain state a number describes.
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as m from './math.js';
import { metrics as computeMetrics } from './state.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const json = (_, value) => typeof value === 'bigint' ? value.toString() : value;
const dec = (value, decimals) => value === null || value === undefined ? null : m.toDecimalString(value, decimals);
const pct = bps => bps === null || bps === undefined ? null : Number(bps) / 100;
const lev = bps => bps === null || bps === undefined ? null : Number(bps) / 10000;
const micro = (value, decimals) => value === null || value === undefined ? null : m.toDecimalString(value, Number(decimals) + 6);
const clamp = (value, fallback, max) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback; };

export function createApi({ collector, reference = null, webDir = fileURLToPath(new URL('../web/', import.meta.url)), version = '0.2.0', now = () => Date.now() }) {
  const { state } = collector;
  const cd = () => state.exchangeInfo?.collateralDecimals ?? 6;
  const priceDec = market => market.priceDecimals;

  function snapshot() {
    const f = collector.freshness(now());
    return { chain_id: state.chain, exchange: state.exchange, block: state.block?.number?.toString() ?? null, block_hash: state.block?.hash ?? null, block_timestamp: state.block?.timestamp ?? null, finalized_block: state.finalized?.number?.toString() ?? null, block_time_ms: state.stats.blockTimeMs ?? null, status: f.status, status_reason: f.reason ?? null, age_ms: f.ageMs, generated_at: now() };
  }

  function fundingView(market) {
    const interval = state.exchangeInfo?.fundingInterval ?? 0n;
    const blockTimeMs = state.stats.blockTimeMs ?? null;
    const perInterval = m.fundingRateFraction(market.fundingRatePct100k);
    const next = state.block && interval > 0n ? m.nextFundingBlock(state.block.number, interval) : null;
    const intervalMs = blockTimeMs && interval > 0n ? Number(interval) * blockTimeMs : null;
    const perYear = intervalMs ? perInterval * (365.25 * 86400000 / intervalMs) : null;
    const latest = [...state.history.funding].reverse().find(f => f.perpId === market.id) ?? null;
    return {
      rate_per_interval_pct: perInterval * 100, rate_8h_pct: intervalMs ? perInterval * (8 * 3600000 / intervalMs) * 100 : null, rate_annualized_pct: perYear === null ? null : perYear * 100,
      direction: market.fundingRatePct100k > 0n ? 'longs pay shorts' : market.fundingRatePct100k < 0n ? 'shorts pay longs' : 'flat',
      clamp_pct: Number(market.absFundingClampPctPer100K) / 1000, interval_blocks: interval.toString(), interval_seconds: intervalMs ? Math.round(intervalMs / 1000) : null,
      next_funding_block: next?.toString() ?? null, blocks_to_next: next && state.block ? (next - state.block.number).toString() : null,
      seconds_to_next: next && state.block && blockTimeMs ? Math.round(Number(next - state.block.number) * blockTimeMs / 1000) : null,
      latest_event: latest ? fundingEntry(latest, market) : null
    };
  }

  function fundingEntry(f, market) {
    const scale = Number(market?.fundingSumScalingExp ?? 0) + (market?.priceDecimals ?? 0);
    return { market_id: f.perpId, symbol: market?.symbol ?? null, funding_event_block: f.fundingEventBlock.toString(), emitted_block: f.block.toString(), tx: f.tx, rate_pct: m.fundingRateFraction(f.actualRatePct100k) * 100, specified_rate_pct: m.fundingRateFraction(f.specifiedRatePct100k) * 100, funding_price: market ? dec(f.fundingPricePNS, market.priceDecimals) : f.fundingPricePNS.toString(), payment_per_unit: market ? dec(f.fundingPaymentPNS, scale) : f.fundingPaymentPNS.toString(), funding_sum: market ? dec(f.fundingSumPNS, scale) : f.fundingSumPNS.toString(), overwrite: f.allowOverwrite };
  }

  function liquidationEntry(l) {
    const market = state.markets.get(l.perpId);
    const pd = market?.priceDecimals ?? 0, ld = market?.lotDecimals ?? 0;
    return { block: l.block.toString(), tx: l.tx, log_index: l.logIndex, market_id: l.perpId, symbol: market?.symbol ?? null, account_id: l.accountId.toString(), side: l.positionType === 0 ? 'long' : 'short', mark_price: dec(l.markPricePNS, pd), exit_price: dec(l.exitPricePNS, pd), liquidated_size: dec(l.liquidatedLotLNS, ld), remaining_size: dec(l.remainingLotLNS, ld), liquidated_notional: market ? dec(m.notionalCNS(l.exitPricePNS, l.liquidatedLotLNS, m.units(pd, ld, cd())), cd()) : null, delta_pnl: dec(l.deltaPnlCNS, cd()), funding: dec(l.fundingCNS, cd()), position_amount: dec(l.positionAmountCNS, cd()), remaining_deposit: dec(l.remainingDepositCNS, cd()), on_order_book: l.onOrderBook, full: l.remainingLotLNS === 0n };
  }

  function positionView(p, market) {
    const pd = priceDec(market), c = cd();
    return { account_id: p.accountId.toString(), side: p.side, size: dec(p.lotLNS, market.lotDecimals), notional: dec(p.markNotionalCNS, c), entry_notional: dec(p.entryNotionalCNS, c), entry_price: micro(p.entryQ16 * m.MICRO / m.Q16, pd), deposit: dec(p.depositCNS, c), delta_pnl: dec(p.deltaPnlCNS, c), premium_pnl: dec(p.premiumPnlCNS, c), pnl: dec(p.pnlCNS, c), equity: dec(p.fmvCNS, c), maintenance_margin: dec(p.mmrCNS, c), health_pct: pct(p.healthBps), status: p.status, liquidation_price: micro(p.liquidationMicroPNS, pd), bankruptcy_price: micro(p.bankruptcyMicroPNS, pd), liquidation_distance_pct: pct(p.liquidationDistanceBps), bankruptcy_distance_pct: pct(p.bankruptcyDistanceBps), leverage: lev(p.leverageBps), effective_leverage: lev(p.effectiveLeverageBps), entry_block: p.entryBlock.toString(), pnl_matches_contract: p.contractAgrees };
  }

  function sideView(x) { const c = cd(); return { count: x.count, size: x.lotLNS.toString(), notional: dec(x.notionalCNS, c), entry_notional: dec(x.entryNotionalCNS, c), deposit: dec(x.depositCNS, c), delta_pnl: dec(x.deltaPnlCNS, c), premium_pnl: dec(x.premiumPnlCNS, c), equity: dec(x.fmvCNS, c), maintenance_margin: dec(x.mmrCNS, c), average_leverage: lev(x.averageLeverageBps), liquidatable: x.liquidatable, bankrupt: x.bankrupt }; }
  function ladderView(rows, market) { const c = cd(), pd = priceDec(market); return rows.map(r => ({ shock_pct: pct(r.bps), long: { count: r.long.count, notional: dec(r.long.notionalCNS, c), shortfall: dec(r.long.shortfallCNS, c), price: dec(r.long.pricePNS, pd) }, short: { count: r.short.count, notional: dec(r.short.notionalCNS, c), shortfall: dec(r.short.shortfallCNS, c), price: dec(r.short.pricePNS, pd) }, total_notional: dec(r.totalNotionalCNS, c), total_shortfall: dec(r.totalShortfallCNS, c), insurance_coverage_pct: pct(r.insuranceCoverageBps) })); }
  function mapView(map) { const c = cd(); return { bin_pct: pct(map.binBps), range_pct: pct(map.rangeBps), bins: map.bins.map(b => ({ from_pct: pct(b.fromBps), to_pct: pct(b.toBps), count: b.count, long_notional: dec(b.longNotionalCNS, c), short_notional: dec(b.shortNotionalCNS, c) })), tails: { below: { count: map.tails.below.count, notional: dec(map.tails.below.notionalCNS, c) }, above: { count: map.tails.above.count, notional: dec(map.tails.above.notionalCNS, c) } } }; }
  function concentrationView(x) { const c = cd(); return { positions: x.positions, total_notional: dec(x.totalNotionalCNS, c), top1_pct: pct(x.top1Bps), top5_pct: pct(x.top5Bps), top10_pct: pct(x.top10Bps), hhi: x.hhi === null ? null : Number(x.hhi), largest: x.largest ? { account_id: x.largest.accountId.toString(), side: x.largest.side, notional: dec(x.largest.notionalCNS, c), liquidation_distance_pct: pct(x.largest.liquidationDistanceBps) } : null }; }

  function marketSummary({ market, metrics: x }) {
    const c = cd(), pd = priceDec(market);
    const at = bps => x.ladder.find(r => r.bps === bps);
    const age = state.block ? state.block.timestamp - market.markTimestamp : null;
    return {
      id: market.id, symbol: market.symbol, name: market.name, status: market.status, active: market.status === 4 && market.unwind.status === 4, price_decimals: market.priceDecimals, lot_decimals: market.lotDecimals,
      prices: { mark: dec(market.markPNS, pd), oracle: dec(market.oraclePNS, pd), last: dec(market.lastPNS, pd), basis_pct: pct(x.basisBps), mark_age_seconds: age, mark_stale: age !== null && age > market.refPriceMaxAgeSec, oracle_used: !market.ignOracle },
      open_interest: { long_size: dec(x.oi.longLNS, market.lotDecimals), short_size: dec(x.oi.shortLNS, market.lotDecimals), long_notional: dec(x.oi.longNotionalCNS, c), short_notional: dec(x.oi.shortNotionalCNS, c), total_notional: dec(x.oi.totalNotionalCNS, c), max_size: x.oi.maxLNS === null ? null : dec(x.oi.maxLNS, market.lotDecimals), utilisation_pct: pct(x.oi.utilisationBps), reconciled: x.oi.reconciled },
      positions: { count: x.positions.length, long: x.long.count, short: x.short.count, liquidatable: x.long.liquidatable + x.short.liquidatable, bankrupt: x.long.bankrupt + x.short.bankrupt },
      long: sideView(x.long), short: sideView(x.short),
      margin: { max_leverage: Number(market.initHdths) / 100, dynamic_max_leverage: Number(market.dynamicInitHdths) / 100, initial_margin_pct: Number(market.initHdths) > 0 ? 10000 / Number(market.initHdths) : null, maintenance_margin_pct: Number(market.maintHdths) > 0 ? 10000 / Number(market.maintHdths) : null, maintenance_fraction_hdths: market.maintHdths.toString(), initial_fraction_hdths: market.initHdths.toString() },
      insurance: { balance: dec(x.insurance.balanceCNS, c), position_balance: dec(x.insurance.positionBalanceCNS, c), coverage_of_notional_pct: pct(x.insurance.coverageOfNotionalBps), coverage_of_maintenance_pct: pct(x.insurance.coverageOfMmrBps), liquidation_split: { trader_pct: Number(market.liquidation.userPer100K) / 1000, insurance_pct: Number(market.liquidation.insurancePer100K) / 1000, protocol_pct: Number(market.liquidation.protocolPer100K) / 1000 } },
      risk: { notional_at_5pct: dec(at(500n)?.totalNotionalCNS ?? 0n, c), notional_at_10pct: dec(at(1000n)?.totalNotionalCNS ?? 0n, c), shortfall_at_10pct: dec(at(1000n)?.totalShortfallCNS ?? 0n, c), insurance_coverage_at_10pct: pct(at(1000n)?.insuranceCoverageBps ?? null), long_notional_at_10pct: dec(at(1000n)?.long.notionalCNS ?? 0n, c), short_notional_at_10pct: dec(at(1000n)?.short.notionalCNS ?? 0n, c) },
      concentration: concentrationView(x.concentration.all),
      funding: fundingView(market),
      unwind_status: market.unwind.status, orders: market.numOrders.toString(),
      validation: { oi_reconciled: x.validation.oiReconciled, pnl_checked: x.validation.pnlAgreement.checked, pnl_agree: x.validation.pnlAgreement.agree },
      reference: reference ? reference.compare(market, [...state.history.funding].reverse().find(f => f.perpId === market.id)?.fundingSumPNS ?? null) : null
    };
  }

  function marketDetail(entry, query) {
    const { market, metrics: x } = entry;
    const limit = clamp(query.get('limit'), 25, 500);
    const sorted = [...x.positions].sort((a, b) => (b.markNotionalCNS > a.markNotionalCNS ? 1 : b.markNotionalCNS < a.markNotionalCNS ? -1 : 0));
    return { ...marketSummary(entry), ladder: ladderView(x.ladder, market), liquidation_map: mapView(x.map), health: x.health.map(h => ({ from_pct: pct(h.fromBps), to_pct: pct(h.toBps), count: h.count, notional: dec(h.notionalCNS, cd()) })), concentration_by_side: { long: concentrationView(x.concentration.long), short: concentrationView(x.concentration.short) }, top_positions: sorted.slice(0, limit).map(p => positionView(p, market)), funding_history: state.history.funding.filter(f => f.perpId === market.id).slice(-48).map(f => fundingEntry(f, market)), recent_liquidations: state.history.liquidations.filter(l => l.perpId === market.id).slice(-25).reverse().map(liquidationEntry) };
  }

  function positionsList(entry, query) {
    const { market, metrics: x } = entry;
    const side = query.get('side'), sort = query.get('sort') || 'notional', limit = clamp(query.get('limit'), 50, 1000);
    let list = x.positions.filter(p => !side || p.side === side);
    const cmp = { notional: (a, b) => b.markNotionalCNS - a.markNotionalCNS, risk: (a, b) => (a.liquidationDistanceBps ?? 1n << 62n) - (b.liquidationDistanceBps ?? 1n << 62n), pnl: (a, b) => b.pnlCNS - a.pnlCNS, size: (a, b) => b.lotLNS - a.lotLNS }[sort];
    if (!cmp) throw Object.assign(new Error('INVALID_SORT'), { status: 400 });
    list = list.sort((a, b) => Number(cmp(a, b) > 0n) - Number(cmp(a, b) < 0n));
    return { market_id: market.id, symbol: market.symbol, sort, side: side ?? null, total: list.length, positions: list.slice(0, limit).map(p => positionView(p, market)) };
  }

  function overview() {
    const computed = computeMetrics(state);
    const t = computed.totals, c = cd();
    const liq24 = state.history.liquidations.filter(l => state.block && state.block.number - l.block <= 24n * 3600n * 1000n / BigInt(state.stats.blockTimeMs || 400));
    let liqNotional = 0n; for (const l of liq24) { const mk = state.markets.get(l.perpId); if (mk) liqNotional += m.notionalCNS(l.exitPricePNS, l.liquidatedLotLNS, m.units(mk.priceDecimals, mk.lotDecimals, c)); }
    return {
      exchange: { version: state.exchangeInfo.version, halted: state.exchangeInfo.halted, accounts: state.exchangeInfo.numberOfAccounts.toString(), collateral_token: state.exchangeInfo.collateralToken, collateral_decimals: c, exchange_balance: dec(state.exchangeInfo.balanceCNS, c), protocol_balance: dec(state.exchangeInfo.protocolBalanceCNS, c), funding_interval_blocks: state.exchangeInfo.fundingInterval.toString(), block_time_ms: state.stats.blockTimeMs ?? null },
      totals: { markets: t.markets, positions: t.positions, liquidatable: t.liquidatable, bankrupt: t.bankrupt, total_notional: dec(t.notionalCNS, c), total_deposit: dec(t.depositCNS, c), total_equity: dec(t.fmvCNS, c), insurance_total: dec(t.insuranceCNS, c), notional_at_5pct: dec(t.notionalAt500Bps, c), notional_at_10pct: dec(t.notionalAt1000Bps, c), shortfall_at_10pct: dec(t.shortfallAt1000Bps, c), insurance_coverage_at_10pct: t.shortfallAt1000Bps > 0n ? pct(m.floorDiv(t.insuranceCNS * 10000n, t.shortfallAt1000Bps)) : null, all_reconciled: t.allReconciled, liquidations_24h: liq24.length, liquidated_notional_24h: dec(liqNotional, c) },
      markets: computed.markets.map(marketSummary)
    };
  }

  function validation() {
    const computed = computeMetrics(state);
    return {
      bootstrap: state.bootstrap ? { block: state.bootstrap.block.toString(), hash: state.bootstrap.hash, at: state.bootstrap.at, reason: state.bootstrap.reason } : null,
      reconciliation: state.reconciliation ? { block: state.reconciliation.block?.toString() ?? null, ok: state.reconciliation.ok, markets: state.reconciliation.markets, mismatches: state.reconciliation.mismatches, at: state.reconciliation.at } : null,
      verification: state.verification ? { ...state.verification, block: state.verification.block?.toString(), accounts: state.verification.accounts?.toString() } : null,
      pnl_agreement: computed ? computed.markets.map(x => ({ market_id: x.market.id, symbol: x.market.symbol, checked: x.metrics.validation.pnlAgreement.checked, agree: x.metrics.validation.pnlAgreement.agree })) : [],
      metrics: {
        open_interest: { status: 'validated', method: 'Sum of paged getPositionsV2 per side equals getPerpetualInfoV2 counters at every poll; independent account-bitmap rescan periodically.' },
        delta_pnl: { status: 'validated', method: 'Recomputed from effective entry price, size and mark; compared with getPositionsV2.deltaPnlCNS for every open position (truncation toward zero).' },
        premium_pnl: { status: 'validated', method: 'Taken from the contract; funding formula checked across live funding events (see docs/validation-gate.md).' },
        liquidation_price: { status: 'formula', method: 'Perpl documentation and perpl-sdk position.rs: entry + side * (MMR - deposit - premium) / size, MMR = entry notional / maintenance fraction. Compared with contract diagnostics when available.' },
        liquidation_ladder: { status: 'derived', method: 'Positions whose liquidation price lies within each adverse move of the mark; shortfall is the negative equity beyond bankruptcy at that price if no liquidation executes first.' },
        funding: { status: 'validated', method: 'FundingEventCompleted events and getFundingSumAtBlock; rate = fundingRatePct100k / 1e5 per funding interval.' },
        insurance: { status: 'on-chain', method: 'getPerpetualInfoV2.insuranceBalanceCNS per market.' },
        concentration: { status: 'derived', method: 'Shares of mark notional across positions; HHI on notional shares.' }
      },
      rpc: { ...collector.reader.stats },
      collector: { ...state.stats, options: { poll_ms: collector.options.pollMs, log_range: collector.options.logRange.toString(), verify_every_blocks: collector.options.verifyEveryBlocks.toString(), backfill_blocks: collector.options.backfillBlocks.toString() } }
    };
  }

  function referenceView() {
    if (!reference) return { enabled: false };
    return { enabled: true, error: reference.error, fetched_at: reference.last?.at ?? null, chain_id: reference.last?.chainId ?? null, markets: [...state.markets.values()].map(market => ({ id: market.id, symbol: market.symbol, comparison: reference.compare(market, [...state.history.funding].reverse().find(f => f.perpId === market.id)?.fundingSumPNS ?? null) })) };
  }

  const routes = [
    ['GET', /^\/api\/v1\/health$/, () => ({ ok: true, version, snapshot: snapshot(), collector: { polls: state.stats.polls, errors: state.stats.errors, last_error: state.stats.lastError, last_poll_ms: state.stats.lastPollMs, uptime_ms: now() - state.stats.startedAt, rpc_requests: collector.reader.stats.requests } })],
    ['GET', /^\/api\/v1\/overview$/, () => ({ snapshot: snapshot(), ...overview() })],
    ['GET', /^\/api\/v1\/markets$/, () => ({ snapshot: snapshot(), markets: computeMetrics(state).markets.map(marketSummary) })],
    ['GET', /^\/api\/v1\/markets\/(\d+)$/, (match, query) => ({ snapshot: snapshot(), market: marketDetail(entryFor(match[1]), query) })],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/positions$/, (match, query) => ({ snapshot: snapshot(), ...positionsList(entryFor(match[1]), query) })],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/ladder$/, match => { const e = entryFor(match[1]); return { snapshot: snapshot(), market_id: e.market.id, symbol: e.market.symbol, ladder: ladderView(e.metrics.ladder, e.market), liquidation_map: mapView(e.metrics.map) }; }],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/funding$/, (match, query) => { const e = entryFor(match[1]); const limit = clamp(query.get('limit'), 48, 1000); return { snapshot: snapshot(), market_id: e.market.id, symbol: e.market.symbol, current: fundingView(e.market), history: state.history.funding.filter(f => f.perpId === e.market.id).slice(-limit).map(f => fundingEntry(f, e.market)) }; }],
    ['GET', /^\/api\/v1\/liquidations$/, (_, query) => { const limit = clamp(query.get('limit'), 100, 1000); const market = query.get('market'); const list = state.history.liquidations.filter(l => !market || String(l.perpId) === market).slice(-limit).reverse(); return { snapshot: snapshot(), total: list.length, liquidations: list.map(liquidationEntry), deleverages: state.history.deleverages.slice(-limit).reverse().map(d => ({ block: d.block.toString(), tx: d.tx, market_id: d.perpId, account_id: d.accountId.toString(), side: d.positionType === 0 ? 'long' : 'short', force_close: d.forceClose, deleverage_price: d.deleveragePricePNS.toString(), start_size: d.startLotLNS.toString(), end_size: d.endLotLNS.toString() })) }; }],
    ['GET', /^\/api\/v1\/validation$/, () => ({ snapshot: snapshot(), ...validation() })],
    ['GET', /^\/api\/v1\/reference$/, () => ({ snapshot: snapshot(), ...referenceView() })],
    ['GET', /^\/api\/v1\/events$/, () => ({ snapshot: snapshot(), parameter_changes: state.history.params.slice(-100).reverse().map(p => ({ ...p, block: p.block.toString() })), unwinds: state.history.unwinds.slice(-50).reverse().map(u => ({ ...u, block: u.block.toString() })), diagnostics: state.history.validation.slice(-50).reverse().map(v => ({ ...v, block: v.block.toString(), accountId: v.accountId.toString(), markPricePNS: v.markPricePNS.toString(), liqPricePNS: v.liqPricePNS?.toString() ?? null, bankruptcyPricePNS: v.bankruptcyPricePNS?.toString() ?? null })) })]
  ];

  function entryFor(id) {
    const entry = computeMetrics(state)?.markets.find(x => x.market.id === Number(id));
    if (!entry) throw Object.assign(new Error('MARKET_NOT_FOUND'), { status: 404 });
    return entry;
  }

  async function serveStatic(pathname, res) {
    const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const file = join(webDir, relative);
    if (!file.startsWith(webDir) || relative.includes('..')) return send(res, 404, { error: 'NOT_FOUND' });
    try {
      const info = await stat(file);
      if (!info.isFile()) return send(res, 404, { error: 'NOT_FOUND' });
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=60', 'content-length': body.length });
      res.end(body);
    } catch { send(res, 404, { error: 'NOT_FOUND' }); }
  }

  function send(res, status, body, extra = {}) {
    const text = JSON.stringify(body, json);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'x-snapshot-block': state.block?.number?.toString() ?? '', ...extra });
    res.end(text);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return req.method === 'GET' || req.method === 'HEAD' ? serveStatic(url.pathname, res) : send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
    if (!route) return send(res, 404, { error: 'NOT_FOUND' });
    try {
      if (!state.block || !state.exchangeInfo) { if (url.pathname !== '/api/v1/health') return send(res, 503, { error: 'SYNCING', snapshot: snapshot() }, { 'retry-after': '5' }); }
      send(res, 200, route[2](url.pathname.match(route[1]), url.searchParams));
    } catch (error) {
      send(res, error.status ?? 500, { error: error.status ? error.message : 'INTERNAL_ERROR' });
    }
  }

  return { handle, routes: routes.map(([method, pattern]) => `${method} ${pattern.source}`) };
}
