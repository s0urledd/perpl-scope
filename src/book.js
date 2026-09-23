// On-chain order-book depth. Perpl's book lives in the exchange contract, so
// resting liquidity can be read at the same pinned block as the positions.
// The walk is bounded: at most `levels` price levels per side, batched across
// markets and sides so each step costs one Multicall3 request.
//
// getVolumeAtBookPrice returns (bids, expBids, asks, expAsks) in LNS. Only the
// first and third counters are treated as firm depth; the "exp" counters are
// reported separately because their semantics (orders carrying an expiry) are
// not documented in the SDK.
import * as m from './math.js';

export function bookOptions(env = {}) {
  const n = (v, d) => { const x = Number(v ?? d); if (!Number.isFinite(x) || x < 0) throw new Error('INVALID_BOOK_OPTION'); return x; };
  return { enabled: env.BOOK_DISABLED !== '1', levels: n(env.BOOK_LEVELS, 40), refreshMs: n(env.BOOK_REFRESH_MS, 30000), rangeBps: BigInt(n(env.BOOK_RANGE_BPS, 1500)) };
}

// markets: [{ id, markPNS, basePricePNS, maxBidPriceONS, minAskPriceONS }]
// Returns Map(id -> { bids: [{pricePNS, lotLNS, expiringLNS}], asks: [...], truncated: {bids, asks}, requests })
export async function readDepth(reader, markets, block, { levels = 40, rangeBps = 1500n } = {}) {
  const out = new Map();
  const cursors = [];
  for (const market of markets) {
    const record = { bids: [], asks: [], truncated: { bids: false, asks: false }, block, rangeBps };
    out.set(market.id, record);
    const base = BigInt(market.basePricePNS ?? 0n), mark = BigInt(market.markPNS);
    if (mark <= 0n) continue;
    const floor = m.floorDiv(mark * (10000n - rangeBps), 10000n), ceiling = m.floorDiv(mark * (10000n + rangeBps), 10000n);
    if (BigInt(market.maxBidPriceONS) > 0n) cursors.push({ id: market.id, side: 'bids', level: BigInt(market.maxBidPriceONS), base, limit: floor, record });
    if (BigInt(market.minAskPriceONS) > 0n) cursors.push({ id: market.id, side: 'asks', level: BigInt(market.minAskPriceONS), base, limit: ceiling, record });
  }
  let requestsBefore = reader.stats.requests;
  for (let step = 0; step < levels && cursors.length; step++) {
    const calls = cursors.flatMap(c => [
      { name: 'getVolumeAtBookPrice', args: [BigInt(c.id), c.level] },
      { name: c.side === 'bids' ? 'getNextPriceBelowWithOrders' : 'getNextPriceAboveWithOrders', args: [BigInt(c.id), c.level] }]);
    const results = await reader.multi(calls, block);
    const next = [];
    cursors.forEach((c, i) => {
      const [bids, expBids, asks, expAsks] = results[i * 2], following = BigInt(results[i * 2 + 1]);
      const pricePNS = c.base + c.level;
      const lot = c.side === 'bids' ? BigInt(bids) : BigInt(asks), expiring = c.side === 'bids' ? BigInt(expBids) : BigInt(expAsks);
      if (lot > 0n || expiring > 0n) c.record[c.side].push({ pricePNS, lotLNS: lot, expiringLNS: expiring });
      const inRange = c.side === 'bids' ? following + c.base >= c.limit : following + c.base <= c.limit;
      if (following > 0n && following !== c.level && inRange) next.push({ ...c, level: following });
      if (step === levels - 1 && following > 0n && following !== c.level && inRange) c.record.truncated[c.side] = true;
    });
    cursors.length = 0; cursors.push(...next);
  }
  for (const record of out.values()) record.requests = reader.stats.requests - requestsBefore;
  return out;
}

// Resting depth (notional at level price, CNS) within `bps` of the mark on one side.
export function depthWithin(levelsList, side, markPNS, bps, u) {
  const mark = BigInt(markPNS);
  const bound = side === 'bids' ? m.floorDiv(mark * (10000n - BigInt(bps)), 10000n) : m.floorDiv(mark * (10000n + BigInt(bps)), 10000n);
  let lot = 0n, notional = 0n, count = 0;
  for (const level of levelsList) {
    if (side === 'bids' ? level.pricePNS < bound : level.pricePNS > bound) continue;
    lot += level.lotLNS; notional += m.notionalCNS(level.pricePNS, level.lotLNS, u); count++;
  }
  return { lotLNS: lot, notionalCNS: notional, levels: count };
}

// How far from the mark (bps) one side's depth is fully known: null when the
// walk reached the end of the range, else the distance of the last level read
// (the level cap stopped it; deeper resting orders were not read).
export function walkedBps(book, side, markPNS) {
  if (!book?.truncated?.[side]) return null;
  const last = book[side].at(-1), mark = BigInt(markPNS);
  if (!last || mark <= 0n) return 0n;
  const distance = side === 'bids' ? mark - last.pricePNS : last.pricePNS - mark;
  return distance > 0n ? m.floorDiv(distance * 10000n, mark) : 0n;
}

// Liquidation demand versus resting depth at each shock. Long liquidations
// sell into bids below the mark; short liquidations buy from asks above it.
// Depth past a truncated walk is a lower bound (`complete: false`).
export function absorption(ladder, book, markPNS, u) {
  if (!book) return null;
  const range = book.rangeBps === undefined ? null : BigInt(book.rangeBps);
  const walked = { bids: walkedBps(book, 'bids', markPNS), asks: walkedBps(book, 'asks', markPNS) };
  const known = (side, bps) => walked[side] === null || bps <= walked[side];
  return ladder.map(row => {
    // Beyond the walked range the book is unknown, not empty.
    if (range !== null && row.bps > range) return { bps: row.bps, beyondRange: true, long: { demandCNS: row.long.notionalCNS, depthCNS: null, levels: null, coverageBps: null, complete: false }, short: { demandCNS: row.short.notionalCNS, depthCNS: null, levels: null, coverageBps: null, complete: false } };
    const bidDepth = depthWithin(book.bids, 'bids', markPNS, row.bps, u), askDepth = depthWithin(book.asks, 'asks', markPNS, row.bps, u);
    const ratio = (depth, demand) => demand > 0n ? m.floorDiv(depth * 10000n, demand) : null;
    return { bps: row.bps, beyondRange: false, long: { demandCNS: row.long.notionalCNS, depthCNS: bidDepth.notionalCNS, levels: bidDepth.levels, coverageBps: ratio(bidDepth.notionalCNS, row.long.notionalCNS), complete: known('bids', row.bps) }, short: { demandCNS: row.short.notionalCNS, depthCNS: askDepth.notionalCNS, levels: askDepth.levels, coverageBps: ratio(askDepth.notionalCNS, row.short.notionalCNS), complete: known('asks', row.bps) } };
  });
}
