// Live validation of the risk formulas against the mainnet contract.
//
// 1. Delta PnL: recomputed from entry price, mark and size for every open
//    position and compared with getPositionsV2's deltaPnlCNS (rounding rule).
// 2. Open interest: paged positions summed per side versus the market getter.
// 3. Liquidation trigger price: positions named by CantLiquidatePosAboveMMR /
//    CantBuyToLiquidate diagnostics are re-read at the event block and the
//    computed liquidation price compared with the contract's emitted value.
// 4. Liquidation classification: positions liquidated on-chain must have been
//    classified liquidatable or bankrupt at the event's mark price one block
//    earlier.
// 5. Funding: premium change across the latest funding event must equal the
//    SDK formula for positions unchanged across it; the funding sum getter
//    must match the emitted sum.
import { mkdir, writeFile } from 'node:fs/promises';
import { configuration, rpcClient } from '../src/rpc.js';
import { createReader } from '../src/exchange.js';
import { processLogs } from '../src/events.js';
import { topicsFor } from '../src/abi.js';
import * as m from '../src/math.js';
import { enrichPosition } from '../src/metrics.js';

const config = configuration(process.env);
const reader = createReader({ rpc: rpcClient(config.url, fetch, { timeoutMs: Number(process.env.RPC_TIMEOUT_MS || 30000), maxBytes: Number(process.env.RPC_MAX_BYTES || 8 * 1024 * 1024) }), exchange: config.exchange });
const logRange = BigInt(process.env.LOG_RANGE || 100);
const lookback = BigInt(process.env.VALIDATE_LOOKBACK_BLOCKS || 6000);
const stateWindow = BigInt(process.env.VALIDATE_STATE_WINDOW || 20000); // public providers prune older state
const maxVectors = Number(process.env.VALIDATE_MAX_VECTORS || 40);
const str = x => JSON.stringify(x, m.bigintJson, 2);
const report = { status: 'BLOCKED', chain_id: config.chain, exchange_address: config.exchange, checks: {} };

const head = await reader.getBlock('latest');
const block = head.number;
report.block_number = block.toString(); report.block_hash = head.hash;
const exchange = await reader.readExchange(block);
const u = m.units(0, 0, exchange.collateralDecimals);
const ids = await reader.readMarketIds(block);
const markets = await reader.readMarkets(ids, block);
const byId = new Map();

// 1 + 2: delta pnl rounding and OI per market.
const pnl = { checked: 0, truncAgree: 0, floorAgree: 0, pnlSumAgree: 0, markMismatch: 0 };
const oi = [];
for (const market of markets) {
  const units = m.units(market.info.priceDecimals, market.info.lotDecimals, exchange.collateralDecimals);
  const { positions, markPNS } = await reader.readAllPositions(market.id, block);
  byId.set(market.id, { market, units, positions, markPNS });
  if (markPNS !== market.info.markPNS) pnl.markMismatch++;
  let long = 0n, short = 0n;
  for (const p of positions) {
    if (p.positionType === 0) long += p.lotLNS; else short += p.lotLNS;
    const entry = m.entryPriceQ16(p.positionType, p.pricePNS, p.priceResiduePNSQ16);
    const trunc = m.deltaPnlCNS(p.positionType, entry, markPNS, p.lotLNS, units);
    const raw = m.side(p.positionType) * (markPNS * m.Q16 - entry) * p.lotLNS * units.collateral;
    const floor = m.floorDiv(raw, m.Q16 * units.price * units.lot);
    pnl.checked++;
    if (trunc === p.deltaPnlCNS) pnl.truncAgree++;
    if (floor === p.deltaPnlCNS) pnl.floorAgree++;
    if (p.pnlCNS === p.deltaPnlCNS + p.premiumPnlCNS) pnl.pnlSumAgree++;
  }
  oi.push({ id: market.id, symbol: market.info.symbol, positions: positions.length, long: long.toString(), short: short.toString(), contractLong: market.info.longOpenInterestLNS.toString(), contractShort: market.info.shortOpenInterestLNS.toString(), matches: long === market.info.longOpenInterestLNS && short === market.info.shortOpenInterestLNS });
}
report.checks.delta_pnl = pnl;
report.checks.open_interest = oi;

// 3 + 4: liquidation vectors from recent diagnostics and liquidations.
const topics = topicsFor(['CantLiquidatePosAboveMMR', 'CantBuyToLiquidate', 'PositionLiquidated', 'FundingEventCompleted']);
const from = block - lookback;
const logs = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let logFailures = 0;
async function scanRange(first, last) {
  try { logs.push(...await reader.getLogs({ fromBlock: first, toBlock: last, topics })); }
  catch (error) {
    if (error.message !== 'RPC_UNAVAILABLE_OR_INVALID') throw error;
    logFailures++;
    if (last === first || logFailures > 200) throw error;
    await sleep(500);
    const middle = first + (last - first) / 2n;
    await scanRange(first, middle);
    await scanRange(middle + 1n, last);
  }
}
for (let first = from; first <= block; first += logRange) {
  const last = first + logRange - 1n > block ? block : first + logRange - 1n;
  await scanRange(first, last);
}
const events = processLogs(logs, { chain: config.chain });
report.checks.log_scan = { from_block: from.toString(), to_block: block.toString(), logs: logs.length, range_splits: logFailures, liquidations: events.liquidations.length, diagnostics: events.validation.length, funding_events: events.funding.length };

const marketAt = async (perpId, at) => {
  const [market] = await reader.readMarkets([perpId], at);
  return market;
};
const liqVectors = { found: events.validation.length, checked: 0, within1Tick: 0, within10Ticks: 0, exact: 0, stateUnavailable: 0, samples: [] };
for (const v of events.validation.filter(x => x.liqPricePNS !== null && block - x.block <= stateWindow).slice(-maxVectors)) {
  for (const at of [v.block - 1n, v.block]) {
   try {
    const market = await marketAt(v.perpId, at);
    const units = m.units(market.info.priceDecimals, market.info.lotDecimals, exchange.collateralDecimals);
    const [{ position }] = await reader.readPositions([{ perpId: v.perpId, accountId: v.accountId }], at);
    if (position.lotLNS === 0n) continue;
    const e = enrichPosition(position, { markPNS: v.markPricePNS, maintHdths: market.margins.maintHdths }, units);
    const computed = e.liquidationMicroPNS, emitted = v.liqPricePNS * m.MICRO;
    const diffTicks = Number(m.absBig(computed - emitted)) / 1e6;
    liqVectors.checked++;
    if (diffTicks === 0) liqVectors.exact++;
    if (diffTicks <= 1) liqVectors.within1Tick++;
    if (diffTicks <= 10) liqVectors.within10Ticks++;
    if (liqVectors.samples.length < 12) liqVectors.samples.push({ event: v.name, block: v.block.toString(), read_at: at.toString(), perpId: v.perpId, accountId: v.accountId.toString(), side: e.side, emitted_liq_pns: v.liqPricePNS.toString(), computed_liq_micro_pns: computed.toString(), diff_ticks: diffTicks, bankruptcy_emitted: v.bankruptcyPricePNS?.toString() ?? null, bankruptcy_computed_micro_pns: e.bankruptcyMicroPNS.toString() });
    break;
   } catch (error) { if (error.message !== 'RPC_UNAVAILABLE_OR_INVALID') throw error; liqVectors.stateUnavailable++; break; }
  }
}
report.checks.liquidation_price_vectors = liqVectors;

const classification = { found: events.liquidations.length, checked: 0, liquidatableOrBankrupt: 0, healthy: 0, missing: 0, stateUnavailable: 0, samples: [] };
for (const l of events.liquidations.filter(x => block - x.block <= stateWindow).slice(-maxVectors)) {
  const at = l.block - 1n;
  let market, position;
  try {
    market = await marketAt(l.perpId, at);
    [{ position }] = await reader.readPositions([{ perpId: l.perpId, accountId: l.accountId }], at);
  } catch (error) { if (error.message !== 'RPC_UNAVAILABLE_OR_INVALID') throw error; classification.stateUnavailable++; continue; }
  const units = m.units(market.info.priceDecimals, market.info.lotDecimals, exchange.collateralDecimals);
  if (position.lotLNS === 0n) { classification.missing++; continue; }
  const e = enrichPosition(position, { markPNS: l.markPricePNS, maintHdths: market.margins.maintHdths }, units);
  classification.checked++;
  if (e.status === 'healthy') classification.healthy++; else classification.liquidatableOrBankrupt++;
  if (classification.samples.length < 12) classification.samples.push({ block: l.block.toString(), perpId: l.perpId, accountId: l.accountId.toString(), side: e.side, status: e.status, healthBps: e.healthBps?.toString() ?? null, mark: l.markPricePNS.toString(), computed_liq_micro_pns: e.liquidationMicroPNS.toString(), exit_pns: l.exitPricePNS.toString(), liquidated_lot: l.liquidatedLotLNS.toString(), remaining_lot: l.remainingLotLNS.toString() });
}
report.checks.liquidation_classification = classification;

// 5: funding across the latest completed funding event per market.
const funding = { events: 0, sumGetterAgree: 0, positionsChecked: 0, premiumAgree: 0, samples: [] };
const latestByMarket = new Map();
for (const f of events.funding) if (f.fundingEventBlock <= block) latestByMarket.set(f.perpId, f);
funding.errors = 0;
for (const f of latestByMarket.values()) {
  const entry = byId.get(f.perpId); if (!entry || block - f.fundingEventBlock > stateWindow) continue;
  funding.events++;
  let sum, before, after;
  try {
    sum = await reader.readFundingSum(f.perpId, f.fundingEventBlock, block);
    before = await reader.readAllPositions(f.perpId, f.fundingEventBlock - 1n);
    after = await reader.readAllPositions(f.perpId, f.fundingEventBlock);
  } catch (error) { if (error.message !== 'RPC_UNAVAILABLE_OR_INVALID') throw error; funding.errors++; continue; }
  if (sum.fundingSumPNS === f.fundingSumPNS && sum.fundingEventBlock === f.fundingEventBlock) funding.sumGetterAgree++;
  const afterMap = new Map(after.positions.map(p => [p.accountId.toString(), p]));
  const exp = entry.market.info.fundingSumScalingExp;
  for (const p of before.positions) {
    const q = afterMap.get(p.accountId.toString());
    if (!q || q.lotLNS !== p.lotLNS || q.depositCNS !== p.depositCNS || q.entryBlock !== p.entryBlock || q.positionType !== p.positionType) continue;
    funding.positionsChecked++;
    const expected = m.fundingPremiumDeltaCNS(p.positionType, f.fundingPaymentPNS, p.lotLNS, exp, entry.units);
    const actual = q.premiumPnlCNS - p.premiumPnlCNS;
    if (actual === expected) funding.premiumAgree++;
    else if (funding.samples.length < 10) funding.samples.push({ perpId: f.perpId, accountId: p.accountId.toString(), side: p.positionType, lot: p.lotLNS.toString(), payment_pns: f.fundingPaymentPNS.toString(), exp: exp.toString(), expected: expected.toString(), actual: actual.toString() });
  }
}
report.checks.funding = funding;

const allOi = oi.every(x => x.matches);
report.status = allOi && pnl.checked > 0 && (pnl.truncAgree === pnl.checked || pnl.floorAgree === pnl.checked) && classification.healthy === 0 && funding.premiumAgree === funding.positionsChecked ? 'PASS' : 'FAIL';
report.rpc = reader.stats;
await mkdir('reports', { recursive: true });
await writeFile('reports/validation-math.json', str(report));
console.log(str({ status: report.status, block: report.block_number, delta_pnl: pnl, oi_all_match: allOi, liquidation_price_vectors: { ...liqVectors, samples: liqVectors.samples.slice(0, 4) }, classification: { ...classification, samples: classification.samples.slice(0, 3) }, funding: { ...funding, samples: funding.samples.slice(0, 3) }, log_scan: report.checks.log_scan, rpc: reader.stats }));
process.exitCode = report.status === 'PASS' ? 0 : 1;
