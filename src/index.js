// Rolling event index: compact records of trades, forced trades, collateral
// flows and account creations over a bounded block window, with hourly
// aggregates and open-interest snapshots that outlive the raw window.
//
// Definitions (all exact, from exchange events):
//   volume      = sum of maker-fill notional (each match counted once);
//   fees        = sum of maker and taker fill fees (Perpl charges fees on
//                 fills that build a position; reducing fills are free); the
//                 insurance/protocol split comes from the position events;
//   trade price = price of the fill log that immediately follows a position
//                 event in the same transaction (PositionIncreased reports the
//                 blended entry price and PositionClosed carries no size, so
//                 the fill is the only exact source);
//   realized    = deltaPnlCNS + fundingCNS on decreasing, closing, inverting,
//                 liquidated and deleveraged position events.
// Records keep every amount as a plain number (contract units never exceed
// 2^53 on Perpl: 9e9 USD in CNS) and convert to BigInt at the math boundary,
// which keeps a million records under 200 MB. Position state itself still
// comes from the contract, never from here.
import { decodeLog } from './abi.js';
import * as m from './math.js';

export const USER_TRADE_TYPES = ['open', 'increase', 'decrease', 'close', 'invert'];
export const FORCED_TRADE_TYPES = ['liquidation', 'deleverage'];
export const TRADE_TYPES = [...USER_TRADE_TYPES, ...FORCED_TRADE_TYPES];
export const REALIZING = new Set(['decrease', 'close', 'invert', 'liquidation', 'deleverage']);
export const INDEX_EVENTS = ['PositionOpened', 'PositionOpenedV2', 'PositionIncreased', 'PositionIncreasedV2', 'PositionDecreased', 'PositionClosed', 'PositionInverted', 'PositionLiquidated', 'PositionDeleveraged', 'PositionDeleveragedV2', 'MakerOrderFilled', 'MakerOrderFilledV2', 'TakerOrderFilled', 'TakerOrderFilledV2', 'CollateralDeposit', 'CollateralWithdrawal', 'AccountCreated'];
export const INDEX_VERSION = 2;

export const B = v => (typeof v === 'bigint' ? v : BigInt(v ?? 0));
const num = v => { const n = Number(v ?? 0); if (!Number.isSafeInteger(n)) throw new Error('UNSAFE_AMOUNT'); return n; };
const fees = args => ({ feeCNS: num(args.insFeeCNS) + num(args.protFeeCNS), insFeeCNS: num(args.insFeeCNS), protFeeCNS: num(args.protFeeCNS) });

// One compact record per relevant event, in contract units.
export function recordFromLog(log, intern = x => x) {
  const decoded = decodeLog(log);
  if (!decoded) return null;
  const { name, args } = decoded;
  const base = { block: Number(BigInt(log.blockNumber)), tx: intern(log.transactionHash), logIndex: Number(BigInt(log.logIndex)) };
  switch (name) {
    case 'PositionOpened': case 'PositionOpenedV2':
      return { ...base, type: 'open', perpId: Number(args.perpId), accountId: num(args.accountId), side: Number(args.positionType), pricePNS: num(args.pricePNS), lotLNS: num(args.lotLNS), endLotLNS: num(args.lotLNS), depositCNS: num(args.depositCNS), leverageHdths: num(args.leverageHdths), ...fees(args) };
    case 'PositionIncreased': case 'PositionIncreasedV2':
      return { ...base, type: 'increase', perpId: Number(args.perpId), accountId: num(args.accountId), side: Number(args.positionType), pricePNS: num(args.pricePNS), entryPricePNS: num(args.pricePNS), lotLNS: num(args.endLotLNS) - num(args.startLotLNS), endLotLNS: num(args.endLotLNS), depositCNS: num(args.endDepositCNS), leverageHdths: num(args.leverageHdths), ...fees(args) };
    case 'PositionDecreased':
      return { ...base, type: 'decrease', perpId: Number(args.perpId), accountId: num(args.accountId), side: Number(args.positionType), lotLNS: num(args.startLotLNS) - num(args.endLotLNS), endLotLNS: num(args.endLotLNS), depositCNS: num(args.endDepositCNS), pnlCNS: num(args.deltaPnlCNS), fundingCNS: num(args.fundingCNS) };
    case 'PositionClosed':
      return { ...base, type: 'close', perpId: Number(args.perpId), accountId: num(args.accountId), side: Number(args.positionType), pricePNS: num(args.pricePNS), endLotLNS: 0, pnlCNS: num(args.deltaPnlCNS), fundingCNS: num(args.fundingCNS) };
    case 'PositionInverted':
      return { ...base, type: 'invert', perpId: Number(args.perpId), accountId: num(args.accountId), side: Number(args.positionType), pricePNS: num(args.pricePNS), startLotLNS: num(args.startLotLNS), endLotLNS: num(args.endLotLNS), lotLNS: num(args.startLotLNS) + num(args.endLotLNS), pnlCNS: num(args.deltaPnlCNS), fundingCNS: num(args.fundingCNS), depositCNS: num(args.endDepositCNS), leverageHdths: num(args.leverageHdths), ...fees(args) };
    case 'PositionLiquidated':
      return { ...base, type: 'liquidation', perpId: Number(args.perpId), accountId: num(args.posAccountId), side: Number(args.positionType), pricePNS: num(args.liqPricePNS), markPNS: num(args.markPricePNS), lotLNS: num(args.liqLotLNS), endLotLNS: num(args.posLotLNS), pnlCNS: num(args.deltaPnlCNS), fundingCNS: num(args.fundingCNS), depositCNS: num(args.posDepositCNS), amountCNS: num(args.posAmountCNS), onOrderBook: Boolean(args.onOrderBook) };
    case 'PositionDeleveraged': case 'PositionDeleveragedV2':
      return { ...base, type: 'deleverage', perpId: Number(args.perpId), accountId: num(args.accountId), side: Number(args.positionType), pricePNS: num(args.deleveragePricePNS), lotLNS: num(args.startLotLNS) - num(args.endLotLNS), endLotLNS: num(args.endLotLNS), pnlCNS: num(args.deltaPnlCNS), fundingCNS: num(args.fundingCNS), depositCNS: num(args.endDepositCNS), forceClose: Boolean(args.forceClose) };
    case 'MakerOrderFilled': case 'MakerOrderFilledV2':
      return { ...base, type: 'fill', perpId: Number(args.perpId), accountId: num(args.accountId), pricePNS: num(args.pricePNS), lotLNS: num(args.lotLNS), feeCNS: num(args.feeCNS), builderFeeCNS: num(args.builderFeeCNS) };
    case 'TakerOrderFilled': case 'TakerOrderFilledV2':
      return { ...base, type: 'takerFill', pricePNS: num(args.entryPricePNS), lotLNS: num(args.lotLNS), feeCNS: num(args.feeCNS), builderFeeCNS: num(args.builderFeeCNS) };
    case 'CollateralDeposit':
      return { ...base, type: 'deposit', accountId: num(args.accountId), amountCNS: num(args.amountCNS), balanceCNS: num(args.balanceCNS) };
    case 'CollateralWithdrawal':
      return { ...base, type: 'withdrawal', accountId: num(args.accountId), amountCNS: num(args.amountCNS), balanceCNS: num(args.balanceCNS) };
    case 'AccountCreated':
      return { ...base, type: 'account', accountId: num(args.id), address: String(args.account).toLowerCase() };
    default: return null;
  }
}

// Decodes logs (ordered by block and log index, whole blocks) and links each
// user position event with the fill log that follows it in the same
// transaction: the fill carries the trade price, the traded size and the fee.
export function recordsFromLogs(logs, intern = x => x) {
  const out = [];
  for (const log of logs) { const record = recordFromLog(log, intern); if (record) out.push(record); }
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (!USER_TRADE_TYPES.includes(r.type)) continue;
    const next = out[i + 1];
    const linked = next && next.tx === r.tx && ((next.type === 'fill' && next.accountId === r.accountId) || next.type === 'takerFill');
    if (!linked) { r.role = null; continue; }
    r.role = next.type === 'fill' ? 'maker' : 'taker';
    r.pricePNS = next.pricePNS;
    if (r.lotLNS === undefined) r.lotLNS = next.lotLNS;
    if (r.feeCNS === undefined) r.feeCNS = next.feeCNS;
    if (next.type === 'takerFill') { next.perpId = r.perpId; next.accountId = r.accountId; }
  }
  return out;
}

const emptyAggregate = () => ({ volumeCNS: 0n, trades: 0, takerBuyCNS: 0n, takerSellCNS: 0n, feesCNS: 0n, makerFeesCNS: 0n, takerFeesCNS: 0n, builderFeesCNS: 0n, insuranceFeesCNS: 0n, protocolFeesCNS: 0n, accounts: new Set(), depositsCNS: 0n, withdrawalsCNS: 0n, deposits: 0, withdrawals: 0, liquidations: 0, liquidatedCNS: 0n, deleverages: 0, opens: 0, closes: 0, positionChanges: 0, newAccounts: 0, realizedPnlCNS: 0n, markets: new Map() });
const emptyMarket = () => ({ volumeCNS: 0n, trades: 0, feesCNS: 0n, liquidations: 0, liquidatedCNS: 0n, realizedPnlCNS: 0n, longVolumeCNS: 0n, shortVolumeCNS: 0n, takerBuyCNS: 0n, takerSellCNS: 0n });
// Aggressor direction of a user position event: buying builds longs or unwinds shorts.
export const takerBuys = r => (r.side === m.LONG) === (r.type === 'open' || r.type === 'increase' || (r.type === 'invert' && r.side === m.SHORT));
export const notionalOf = (record, units) => { const u = record.perpId === undefined ? null : units.get(record.perpId); return u && record.pricePNS !== undefined && record.lotLNS !== undefined ? m.notionalCNS(B(record.pricePNS), B(record.lotLNS), u) : 0n; };
const realizedOf = r => B(r.pnlCNS) + B(r.fundingCNS);

// Folds one record into an aggregate (shared by hourly buckets and exact
// window sums).
export function applyRecord(agg, record, units) {
  const marketOf = id => { if (!agg.markets.has(id)) agg.markets.set(id, emptyMarket()); return agg.markets.get(id); };
  const notional = notionalOf(record, units);
  switch (record.type) {
    case 'fill': { const fee = B(record.feeCNS); agg.volumeCNS += notional; agg.trades++; agg.feesCNS += fee; agg.makerFeesCNS += fee; agg.builderFeesCNS += B(record.builderFeeCNS); agg.accounts.add(record.accountId); const mk = marketOf(record.perpId); mk.volumeCNS += notional; mk.trades++; mk.feesCNS += fee; break; }
    case 'takerFill': { const fee = B(record.feeCNS); agg.feesCNS += fee; agg.takerFeesCNS += fee; agg.builderFeesCNS += B(record.builderFeeCNS); if (record.perpId !== undefined) marketOf(record.perpId).feesCNS += fee; if (record.accountId !== undefined) agg.accounts.add(record.accountId); break; }
    case 'open': case 'increase': case 'decrease': case 'close': case 'invert': {
      agg.positionChanges++; agg.accounts.add(record.accountId);
      if (record.type === 'open') agg.opens++; if (record.type === 'close') agg.closes++;
      if (record.insFeeCNS !== undefined) { agg.insuranceFeesCNS += B(record.insFeeCNS); agg.protocolFeesCNS += B(record.protFeeCNS); }
      const mk = marketOf(record.perpId);
      if (record.side === m.LONG) mk.longVolumeCNS += notional; else mk.shortVolumeCNS += notional;
      if (record.role === 'taker') { if (takerBuys(record)) { agg.takerBuyCNS += notional; mk.takerBuyCNS += notional; } else { agg.takerSellCNS += notional; mk.takerSellCNS += notional; } }
      if (REALIZING.has(record.type)) { const realized = realizedOf(record); agg.realizedPnlCNS += realized; mk.realizedPnlCNS += realized; }
      break;
    }
    case 'liquidation': { const realized = realizedOf(record); agg.liquidations++; agg.liquidatedCNS += notional; agg.realizedPnlCNS += realized; agg.accounts.add(record.accountId); const mk = marketOf(record.perpId); mk.liquidations++; mk.liquidatedCNS += notional; mk.realizedPnlCNS += realized; break; }
    case 'deleverage': { const realized = realizedOf(record); agg.deleverages++; agg.realizedPnlCNS += realized; agg.accounts.add(record.accountId); marketOf(record.perpId).realizedPnlCNS += realized; break; }
    case 'deposit': agg.deposits++; agg.depositsCNS += B(record.amountCNS); break;
    case 'withdrawal': agg.withdrawals++; agg.withdrawalsCNS += B(record.amountCNS); break;
    case 'account': agg.newAccounts++; break;
  }
}

export function createIndex({ windowBlocks = 2100000n, bucketBlocks = 12000n, historyBlocks = 12000000n } = {}) {
  const records = [];               // every record in the raw window
  const byAccount = new Map();      // accountId -> records (no fills)
  const liquidations = [];          // liquidation records, ingest order
  const buckets = new Map();        // bucket id -> aggregate built in this run (outlives the raw window)
  const loaded = new Map();         // bucket id -> aggregate loaded from disk; replaced by a rebuild on first re-ingest
  const snapshots = new Map();      // bucket id -> open-interest / TVL snapshot
  const seen = new Set();           // block * 1e6 + logIndex, for dedupe across backfill and live ingest
  const txs = new Map();            // interned transaction hashes
  const covered = { from: null, to: null };
  const backfill = { target: null, contiguousFrom: null, done: false, complete: null, chunks: 0, error: null, startedAt: null, finishedAt: null };
  let originals = null;
  const bucketSize = Number(bucketBlocks);

  const bucketOf = block => BigInt(block) / bucketBlocks;
  const bucketIdOf = block => Math.floor(block / bucketSize); // number form for hot paths
  const intern = tx => { let v = txs.get(tx); if (!v) { v = tx; txs.set(tx, v); } return v; };
  const keyOf = r => r.block * 1000000 + r.logIndex;
  const newBucket = id => ({ id, fromBlock: id * bucketBlocks, complete: false, ...emptyAggregate() });
  function bucket(block) {
    const id = BigInt(bucketIdOf(block));
    if (!buckets.has(id)) { buckets.set(id, newBucket(id)); loaded.delete(id); }
    return buckets.get(id);
  }
  // Loaded aggregates stay visible until a rebuild replaces them.
  const view = () => { const out = new Map(loaded); for (const [id, b] of buckets) out.set(id, b); return out; };
  const bucketComplete = b => Boolean(b.complete) || (covered.from !== null && b.fromBlock >= covered.from && b.fromBlock + bucketBlocks - 1n <= covered.to);

  function apply(record, units) {
    const key = keyOf(record);
    if (seen.has(key)) return false;
    seen.add(key);
    records.push(record);
    if (record.accountId !== undefined && record.type !== 'fill' && record.type !== 'takerFill') { const k = record.accountId; if (!byAccount.has(k)) byAccount.set(k, []); byAccount.get(k).push(record); }
    if (record.type === 'liquidation') liquidations.push(record);
    applyRecord(bucket(record.block), record, units);
    return true;
  }

  // units: Map perpId -> { price, lot, collateral } for notional conversion.
  function ingest(logs, units) {
    let added = 0;
    for (const record of recordsFromLogs(logs, intern)) if (apply(record, units)) added++;
    return added;
  }

  // Marks [from, to] as fully ingested; ranges must touch or overlap.
  function markCovered(from, to) {
    if (covered.from === null) { covered.from = from; covered.to = to; return; }
    if (to + 1n < covered.from || from > covered.to + 1n) throw new Error('COVERAGE_GAP');
    if (from < covered.from) covered.from = from;
    if (to > covered.to) covered.to = to;
  }

  function recordSnapshot(snapshot) {
    const id = bucketOf(snapshot.block);
    const existing = snapshots.get(id);
    if (existing && existing.block > BigInt(snapshot.block)) return false;
    snapshots.set(id, { ...snapshot, block: BigInt(snapshot.block), markets: new Map(snapshot.markets instanceof Map ? snapshot.markets : snapshot.markets.map(x => [Number(x.id), x])) });
    return true;
  }

  // Drops raw records older than the window and aggregates older than the history horizon.
  function prune(head) {
    const floor = head - windowBlocks, floorN = Number(floor);
    let removed = 0;
    if (records.length && records.some(r => r.block < floorN)) {
      const keep = [];
      for (const r of records) { if (r.block >= floorN) keep.push(r); else { removed++; seen.delete(keyOf(r)); } }
      records.length = 0; records.push(...keep);
      for (const [k, list] of byAccount) { const kept = list.filter(r => r.block >= floorN); if (kept.length) byAccount.set(k, kept); else byAccount.delete(k); }
      const keptLiq = liquidations.filter(r => r.block >= floorN); liquidations.length = 0; liquidations.push(...keptLiq);
      const live = new Set(records.map(r => r.tx)); for (const tx of txs.keys()) if (!live.has(tx)) txs.delete(tx);
    }
    if (covered.from !== null && covered.from < floor) { for (const b of buckets.values()) if (b.fromBlock >= covered.from && b.fromBlock + bucketBlocks - 1n <= covered.to) b.complete = true; covered.from = floor; }
    const bucketFloor = bucketOf(head - historyBlocks);
    for (const map of [buckets, loaded, snapshots]) for (const id of map.keys()) if (id < bucketFloor) map.delete(id);
    return removed;
  }

  function startBackfill(target) { Object.assign(backfill, { target, done: false, complete: null, error: null, startedAt: Date.now(), finishedAt: null, contiguousFrom: null, chunks: 0 }); originals = new Map(loaded); }
  // Buckets below the contiguous coverage may have been partly rebuilt; the
  // complete aggregate loaded from disk is better than a partial rebuild.
  function finishBackfill({ contiguousFrom, complete, chunks = 0, error = null }) {
    Object.assign(backfill, { contiguousFrom, complete, chunks, error, done: true, finishedAt: Date.now() });
    if (originals && contiguousFrom !== null) for (const [id, original] of originals) if (id * bucketBlocks < contiguousFrom && buckets.has(id) && original.complete) { buckets.delete(id); loaded.set(id, original); }
    originals = null;
  }

  function accountRecords(accountId) { return (byAccount.get(Number(accountId)) ?? []).slice().sort((a, b) => a.block - b.block || a.logIndex - b.logIndex); }

  // Window sums. Exact from raw records when the window lies inside the raw
  // coverage, otherwise from hourly buckets (edges rounded to bucket bounds).
  function aggregate(fromBlock, toBlock, units) {
    const exact = covered.from !== null && fromBlock >= covered.from && Boolean(units);
    const out = { fromBlock, toBlock, ...emptyAggregate(), exact, partial: false, coveredFrom: covered.from, coveredTo: covered.to, buckets: 0 };
    if (exact) { const lo = Number(fromBlock), hi = Number(toBlock); for (const r of records) if (r.block >= lo && r.block <= hi) applyRecord(out, r, units); }
    else {
      const all = view();
      for (let id = bucketOf(fromBlock); id <= bucketOf(toBlock); id++) {
        const b = all.get(id);
        if (!b) { out.partial = true; continue; }
        if (!bucketComplete(b)) out.partial = true;
        out.buckets++;
        for (const key of Object.keys(b)) { if (key === 'id' || key === 'fromBlock') continue; if (typeof b[key] === 'bigint') out[key] += b[key]; else if (typeof b[key] === 'number') out[key] += b[key]; }
        for (const a of b.accounts) out.accounts.add(a);
        for (const [perpId, mb] of b.markets) { const t = out.markets.get(perpId) ?? emptyMarket(); for (const key of Object.keys(mb)) t[key] += mb[key]; out.markets.set(perpId, t); }
      }
    }
    out.activeAccounts = out.accounts.size;
    out.netFlowCNS = out.depositsCNS - out.withdrawalsCNS;
    return out;
  }

  // One point per bucket in range, including hours without any record (so
  // charts stay continuous), from the first bucket the index knows about.
  function series(fromBlock, toBlock) {
    const all = view();
    const known = [...all.keys(), ...snapshots.keys()];
    if (!known.length) return [];
    const first = known.reduce((a, b) => (b < a ? b : a));
    const start = bucketOf(fromBlock) > first ? bucketOf(fromBlock) : first, end = bucketOf(toBlock);
    const points = [];
    for (let id = start; id <= end; id++) {
      const b = all.get(id) ?? newBucket(id);
      const snap = snapshots.get(id) ?? null;
      points.push({ id: b.id, fromBlock: b.fromBlock, toBlock: b.fromBlock + bucketBlocks - 1n, ts: snap?.ts ?? null, complete: bucketComplete(b), volumeCNS: b.volumeCNS, trades: b.trades, feesCNS: b.feesCNS, takerBuyCNS: b.takerBuyCNS, takerSellCNS: b.takerSellCNS, activeAccounts: b.accounts.size, depositsCNS: b.depositsCNS, withdrawalsCNS: b.withdrawalsCNS, liquidations: b.liquidations, liquidatedCNS: b.liquidatedCNS, realizedPnlCNS: b.realizedPnlCNS, opens: b.opens, closes: b.closes, newAccounts: b.newAccounts, snapshot: snap, markets: b.markets });
    }
    return points;
  }

  // Per-account sums over a block range (leaderboards).
  function accountStats(fromBlock, toBlock, units) {
    const stats = new Map();
    const lo = Number(fromBlock), hi = Number(toBlock);
    const get = id => { if (!stats.has(id)) stats.set(id, { accountId: BigInt(id), volumeCNS: 0n, trades: 0, feesCNS: 0n, realizedCNS: 0n, liquidations: 0, liquidatedCNS: 0n, depositsCNS: 0n, withdrawalsCNS: 0n, lastBlock: 0n, markets: new Set() }); return stats.get(id); };
    for (const r of records) {
      if (r.block < lo || r.block > hi || r.accountId === undefined || r.type === 'fill' || r.type === 'takerFill') continue;
      const s = get(r.accountId);
      if (BigInt(r.block) > s.lastBlock) s.lastBlock = BigInt(r.block);
      if (TRADE_TYPES.includes(r.type)) { const notional = notionalOf(r, units); s.volumeCNS += notional; s.trades++; s.feesCNS += B(r.feeCNS); s.markets.add(r.perpId); if (REALIZING.has(r.type)) s.realizedCNS += realizedOf(r); if (r.type === 'liquidation') { s.liquidations++; s.liquidatedCNS += notional; } }
      else if (r.type === 'deposit') s.depositsCNS += B(r.amountCNS);
      else if (r.type === 'withdrawal') s.withdrawalsCNS += B(r.amountCNS);
    }
    return stats;
  }

  function status() {
    return { records: records.length, accounts: byAccount.size, buckets: view().size, snapshots: snapshots.size, covered: { ...covered }, backfill: { ...backfill }, windowBlocks, bucketBlocks, historyBlocks };
  }

  // Aggregates only: the raw window is rebuilt from the chain at start.
  function serialize() {
    const rows = [...view().values()].map(b => ({ ...b, complete: bucketComplete(b), accounts: [...b.accounts], markets: [...b.markets] }));
    const snaps = [...snapshots.values()].map(x => ({ ...x, markets: [...x.markets.values()] }));
    return JSON.stringify({ version: INDEX_VERSION, bucketBlocks, savedAt: Date.now(), covered, buckets: rows, snapshots: snaps }, (_, v) => typeof v === 'bigint' ? `${v}n` : v);
  }
  function load(text) {
    const data = JSON.parse(text, (_, v) => typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
    if (data.version !== INDEX_VERSION || data.bucketBlocks !== bucketBlocks) throw new Error('INDEX_VERSION_MISMATCH');
    for (const b of data.buckets) if (!buckets.has(b.id)) loaded.set(b.id, { ...emptyAggregate(), ...b, accounts: new Set(b.accounts.map(Number)), markets: new Map(b.markets.map(([id, mk]) => [Number(id), { ...emptyMarket(), ...mk }])) });
    for (const x of data.snapshots) recordSnapshot(x);
    return loaded.size;
  }

  // Newest first, optionally one market, from the raw window.
  function recentLiquidations(limit = 100, perpId = null) { return liquidations.filter(r => perpId === null || r.perpId === perpId).sort((a, b) => b.block - a.block || b.logIndex - a.logIndex).slice(0, limit); }
  return { ingest, apply, markCovered, recordSnapshot, prune, aggregate, series, accountRecords, accountStats, recentLiquidations, status, serialize, load, startBackfill, finishBackfill, covered, backfill, records, buckets, loaded, snapshots, view, windowBlocks, bucketBlocks, historyBlocks, bucketOf, get size() { return records.length; } };
}
