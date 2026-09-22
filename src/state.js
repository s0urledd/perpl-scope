// In-memory exchange state: the single source every API response is built
// from. Positions are stored in the contract's own fields and units; metrics
// are recomputed per block and cached by block hash.
import * as m from './math.js';
import { marketMetrics, exchangeTotals } from './metrics.js';

export const STATE_VERSION = 3;
export const SERIES_LIMIT = 1500;
export const HISTORY_LIMITS = { funding: 3000, liquidations: 2000, deleverages: 500, buyToLiquidate: 500, unwinds: 200, params: 300, validation: 1000 };
const POSITION_FIELDS = ['accountId', 'positionType', 'depositCNS', 'pricePNS', 'lotLNS', 'entryBlock', 'pnlCNS', 'deltaPnlCNS', 'premiumPnlCNS', 'priceResiduePNSQ16'];

export function createState({ chain, exchange }) {
  return {
    version: STATE_VERSION, chain: String(chain), exchange: exchange.toLowerCase(), status: 'syncing', statusReason: 'bootstrap',
    block: null, finalized: null, exchangeInfo: null, markets: new Map(),
    history: Object.fromEntries(Object.keys(HISTORY_LIMITS).map(k => [k, []])),
    reconciliation: null, verification: null, bootstrap: null,
    series: { everyBlocks: 200n, lastBlock: null, points: [] },
    stats: { polls: 0, logs: 0, dirtyReads: 0, errors: 0, lastError: null, lastPollMs: null, startedAt: Date.now() },
    metricsCache: null
  };
}

export function clonePosition(position) {
  const out = {};
  for (const field of POSITION_FIELDS) {
    const value = position[field];
    if (value === undefined) throw new Error(`MISSING_POSITION_FIELD:${field}`);
    out[field] = field === 'positionType' ? Number(value) : BigInt(value);
  }
  if (position.readMarkPNS !== undefined && position.readMarkPNS !== null) out.readMarkPNS = BigInt(position.readMarkPNS);
  if (out.lotLNS < 0n || out.depositCNS < 0n) throw new Error('INVALID_POSITION');
  return out;
}

export function normalizeMarket(read) {
  const { id, info, margins, liquidation, unwind } = read;
  const big = x => BigInt(x);
  return {
    id: Number(id), symbol: String(info.symbol), name: String(info.name),
    priceDecimals: Number(info.priceDecimals), lotDecimals: Number(info.lotDecimals), status: Number(info.status),
    markPNS: big(info.markPNS), markTimestamp: Number(info.markTimestamp), lastPNS: big(info.lastPNS), lastTimestamp: Number(info.lastTimestamp),
    oraclePNS: big(info.oraclePNS), oracleTimestampSec: Number(info.oracleTimestampSec), ignOracle: Boolean(info.ignOracle), refPriceMaxAgeSec: Number(info.refPriceMaxAgeSec),
    longOpenInterestLNS: big(info.longOpenInterestLNS), shortOpenInterestLNS: big(info.shortOpenInterestLNS),
    positionBalanceCNS: big(info.positionBalanceCNS), insuranceBalanceCNS: big(info.insuranceBalanceCNS),
    fundingStartBlock: big(info.fundingStartBlock), fundingRatePct100k: big(info.fundingRatePct100k), absFundingClampPctPer100K: big(info.absFundingClampPctPer100K), fundingSumScalingExp: Number(info.fundingSumScalingExp),
    numOrders: big(info.numOrders), basePricePNS: big(info.basePricePNS), maxBidPriceONS: big(info.maxBidPriceONS ?? 0n), minAskPriceONS: big(info.minAskPriceONS ?? 0n),
    maintHdths: big(margins.maintHdths), initHdths: big(margins.initHdths), dynamicInitHdths: big(margins.dynamicInitHdths), oiMaxLNS: big(margins.oiMaxLNS),
    liquidation: { insurancePer100K: big(liquidation.liqInsAmtPer100K), userPer100K: big(liquidation.liqUserAmtPer100K), protocolPer100K: big(liquidation.liqProtocolAmtPer100K), buyToLiquidateThresholdPer100K: big(liquidation.btlPriceThreshPer100K), buyToLiquidateRestricted: Boolean(liquidation.btlRestrictBuyers) },
    unwind: { status: Number(unwind.status), sumPositiveFmvCNS: big(unwind.sumPositiveFmvCNS), initPositionBalanceCNS: big(unwind.initPositionBalanceCNS) }
  };
}

export function setBlock(state, block, finalized = null) {
  state.block = { number: BigInt(block.number), hash: block.hash, timestamp: Number(block.timestamp) };
  if (finalized) state.finalized = { number: BigInt(finalized.number), hash: finalized.hash };
  state.metricsCache = null;
}

export function setStatus(state, status, reason = null) {
  if (!['syncing', 'fresh', 'stale'].includes(status)) throw new Error('INVALID_STATUS');
  state.status = status; state.statusReason = reason;
}

export function applyExchange(state, info) {
  state.exchangeInfo = { balanceCNS: BigInt(info.balanceCNS), protocolBalanceCNS: BigInt(info.protocolBalanceCNS), recycleBalanceCNS: BigInt(info.recycleBalanceCNS), collateralDecimals: Number(info.collateralDecimals), collateralToken: String(info.collateralToken), numberOfAccounts: BigInt(info.numberOfAccounts), fundingInterval: BigInt(info.fundingInterval), version: String(info.version), halted: Boolean(info.halted), withdrawAllowance: info.withdrawAllowance ? { allowanceCNS: BigInt(info.withdrawAllowance.allowanceCNS), expiryBlock: BigInt(info.withdrawAllowance.expiryBlock), lastAllowanceBlock: BigInt(info.withdrawAllowance.lastAllowanceBlock), cnsPerBlock: BigInt(info.withdrawAllowance.cnsPerBlock) } : null };
  state.metricsCache = null;
}

export function applyMarkets(state, reads) {
  for (const read of reads) {
    const market = normalizeMarket(read);
    const existing = state.markets.get(market.id);
    state.markets.set(market.id, { ...market, positions: existing?.positions ?? new Map(), book: existing?.book ?? null });
  }
  state.metricsCache = null;
}

export function removeMarkets(state, ids) { for (const id of ids) state.markets.delete(Number(id)); state.metricsCache = null; }

// Resting order-book depth read at `block` for the given markets.
export function applyBook(state, depthMap, block) {
  for (const [id, record] of depthMap) {
    const market = state.markets.get(Number(id));
    if (!market) continue;
    market.book = { block: BigInt(block), at: Date.now(), bids: record.bids.map(l => ({ pricePNS: BigInt(l.pricePNS), lotLNS: BigInt(l.lotLNS), expiringLNS: BigInt(l.expiringLNS ?? 0n) })), asks: record.asks.map(l => ({ pricePNS: BigInt(l.pricePNS), lotLNS: BigInt(l.lotLNS), expiringLNS: BigInt(l.expiringLNS ?? 0n) })), truncated: { bids: Boolean(record.truncated?.bids), asks: Boolean(record.truncated?.asks) }, rangeBps: record.rangeBps === undefined ? null : BigInt(record.rangeBps), requests: record.requests ?? null };
  }
  state.metricsCache = null;
}

// Appends one sampled point of the current metrics to the bounded series.
export function sampleSeries(state, computed) {
  if (!computed || !state.block) return false;
  const last = state.series.lastBlock;
  if (last !== null && state.block.number - last < state.series.everyBlocks) return false;
  const t = computed.totals;
  const point = { block: state.block.number, ts: state.block.timestamp, totals: { notionalCNS: t.notionalCNS, at500: t.notionalAt500Bps, at1000: t.notionalAt1000Bps, shortfall1000: t.shortfallAt1000Bps, insuranceCNS: t.insuranceCNS, positions: t.positions, liquidatable: t.liquidatable }, markets: {} };
  for (const { market, metrics } of computed.markets) {
    const at10 = metrics.ladder.find(r => r.bps === 1000n);
    point.markets[market.id] = { markPNS: market.markPNS, notionalCNS: metrics.oi.totalNotionalCNS, at1000: at10?.totalNotionalCNS ?? 0n, shortfall1000: at10?.totalShortfallCNS ?? 0n, insuranceCNS: market.insuranceBalanceCNS, fundingRatePct100k: market.fundingRatePct100k, positions: metrics.positions.length, bidDepth200: metrics.liquidity?.depth?.bids?.[200]?.notionalCNS ?? null, askDepth200: metrics.liquidity?.depth?.asks?.[200]?.notionalCNS ?? null };
  }
  state.series.points.push(point);
  if (state.series.points.length > SERIES_LIMIT) state.series.points.splice(0, state.series.points.length - SERIES_LIMIT);
  state.series.lastBlock = state.block.number;
  return true;
}

export function replaceMarketPositions(state, id, positions, markPNS = null) {
  const market = state.markets.get(Number(id));
  if (!market) throw new Error('UNKNOWN_MARKET');
  market.positions = new Map(positions.filter(p => BigInt(p.lotLNS) !== 0n).map(p => [BigInt(p.accountId).toString(), clonePosition(markPNS === null ? p : { ...p, readMarkPNS: markPNS })]));
  state.metricsCache = null;
}

export function applyPositionReads(state, reads) {
  for (const { perpId, accountId, position, markPNS } of reads) {
    const market = state.markets.get(Number(perpId));
    if (!market) continue;
    const key = BigInt(accountId).toString();
    if (BigInt(position.lotLNS) === 0n) market.positions.delete(key);
    else market.positions.set(key, clonePosition({ ...position, accountId, ...(markPNS === undefined ? {} : { readMarkPNS: markPNS }) }));
  }
  state.metricsCache = null;
}

export function appendHistory(state, processed) {
  for (const key of Object.keys(HISTORY_LIMITS)) {
    const items = processed[key];
    if (!items?.length) continue;
    const list = state.history[key];
    list.push(...items);
    if (list.length > HISTORY_LIMITS[key]) list.splice(0, list.length - HISTORY_LIMITS[key]);
  }
}

// Sum of stored positions per side against the contract's own OI counters.
export function reconcile(state) {
  const mismatches = [];
  for (const market of state.markets.values()) {
    let long = 0n, short = 0n;
    for (const p of market.positions.values()) { if (p.positionType === m.LONG) long += p.lotLNS; else short += p.lotLNS; }
    if (long !== market.longOpenInterestLNS || short !== market.shortOpenInterestLNS) mismatches.push({ id: market.id, symbol: market.symbol, longLNS: long, contractLongLNS: market.longOpenInterestLNS, shortLNS: short, contractShortLNS: market.shortOpenInterestLNS });
  }
  state.reconciliation = { block: state.block?.number ?? null, hash: state.block?.hash ?? null, at: Date.now(), ok: mismatches.length === 0, markets: state.markets.size, mismatches };
  return state.reconciliation;
}

export function metrics(state) {
  if (!state.block || !state.exchangeInfo) return null;
  if (state.metricsCache?.hash === state.block.hash) return state.metricsCache;
  const markets = [...state.markets.values()].sort((a, b) => a.id - b.id).map(market => {
    const u = m.units(market.priceDecimals, market.lotDecimals, state.exchangeInfo.collateralDecimals);
    return { market, metrics: marketMetrics(market, [...market.positions.values()], u), units: u };
  });
  state.metricsCache = { hash: state.block.hash, block: state.block, markets, totals: exchangeTotals(markets.map(x => x.metrics)) };
  return state.metricsCache;
}

// --- persistence -----------------------------------------------------------
const replacer = (_, value) => typeof value === 'bigint' ? `${value}n` : value;
const reviver = (_, value) => typeof value === 'string' && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value;

export function serialize(state) {
  const markets = [...state.markets.values()].map(({ positions, ...market }) => ({ ...market, positions: [...positions.values()] }));
  return JSON.stringify({ ...state, markets, metricsCache: undefined, savedAt: Date.now() }, replacer);
}

export function deserialize(text, { chain, exchange }) {
  const data = JSON.parse(text, reviver);
  if (data.version !== STATE_VERSION) throw new Error('CHECKPOINT_VERSION_MISMATCH');
  if (data.chain !== String(chain) || data.exchange !== exchange.toLowerCase()) throw new Error('CHECKPOINT_TARGET_MISMATCH');
  if (!data.block?.hash || typeof data.block.number !== 'bigint') throw new Error('CHECKPOINT_BLOCK_MISSING');
  const state = createState({ chain, exchange });
  Object.assign(state, { ...data, markets: new Map(), metricsCache: null, stats: { ...state.stats, ...data.stats, startedAt: Date.now() } });
  for (const market of data.markets) state.markets.set(market.id, { ...market, positions: new Map(market.positions.map(p => [p.accountId.toString(), clonePosition(p)])) });
  for (const key of Object.keys(HISTORY_LIMITS)) if (!Array.isArray(state.history[key])) state.history[key] = [];
  if (!state.series || !Array.isArray(state.series.points)) state.series = { everyBlocks: 200n, lastBlock: null, points: [] };
  return state;
}
