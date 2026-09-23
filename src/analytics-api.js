// Protocol and wallet analytics endpoints over the ClickHouse index, merged
// with the live contract state held by the risk collector (open interest,
// TVL, positions, funding). Responses are cached briefly per window and
// recomputed in the background, so requests are served from memory.
import * as m from './math.js';
import { WINDOWS, BUCKETS, DEFAULT_BUCKET } from './query.js';
import { roundTrips, performance, insights, activityGrid } from './analytics.js';
import { metrics as computeMetrics } from './state.js';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const HOUR = 3600, DAY = 86400;

export function createCache({ now = () => Date.now(), max = 500 } = {}) {
  const store = new Map(); // key -> { at, value, pending }
  async function get(key, ttlMs, compute) {
    const hit = store.get(key);
    const fresh = hit && hit.value !== undefined && now() - hit.at < ttlMs;
    if (fresh) return hit.value;
    if (hit?.pending) return hit.value !== undefined ? hit.value : hit.pending; // stale while revalidating
    const pending = compute().then(value => { store.set(key, { at: now(), value, pending: null }); return value; }, error => { const cur = store.get(key); if (cur) cur.pending = null; if (cur && cur.value === undefined) store.delete(key); throw error; });
    if (store.size >= max) { const oldest = store.keys().next().value; store.delete(oldest); }
    store.set(key, { at: hit?.at ?? 0, value: hit?.value, pending });
    return hit?.value !== undefined ? hit.value : pending;
  }
  return { get, clear: () => store.clear(), size: () => store.size };
}

export function createAnalyticsApi({ ch = null, ingest, rollups, queries, collector, accountState = null, now = () => Date.now(), maxTripEvents = 150000 }) {
  const { state } = collector;
  const cache = createCache({ now });
  const cd = () => ingest.collateralDecimals;
  const dec = (v, d = cd()) => (v === null || v === undefined ? null : m.toDecimalString(BigInt(v), d));
  const B = v => BigInt(v ?? 0);
  const meta = mk => ingest.markets.get(Number(mk)) ?? null;
  const symbol = id => meta(id)?.symbol ?? `#${id}`;
  const price = (v, id) => { const x = meta(id); return x ? dec(v, x.priceDecimals) : null; };
  const size = (v, id) => { const x = meta(id); return x ? dec(v, x.lotDecimals) : null; };
  const unitsOf = id => ingest.unitsOf(Number(id));
  const pctChange = (a, b) => (b === 0n ? null : Number((a - b) * 1000000n / (b < 0n ? -b : b)) / 10000);
  const share = (a, b) => (b > 0n ? Number(a * 1000000n / b) / 10000 : null);

  // --- account addresses ----------------------------------------------------
  // AccountCreated events give id -> address; while history is still being
  // indexed (or for any id not seen yet) the contract answers instead, and
  // the answer is stored like an indexed row.
  async function addresses(ids) {
    const map = await queries.addresses(ids);
    const missing = ids.filter(id => !map.has(id) && id > 0).slice(0, 200);
    if (missing.length && state.block) {
      try {
        const block = state.block.number;
        const infos = await collector.reader.multi(missing.map(id => ({ name: 'getAccountById', args: [BigInt(id)] })), block);
        const rows = [];
        infos.forEach((info, i) => { const addr = String(info.accountAddr ?? '').toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(addr) && !/^0x0{40}$/.test(addr)) { map.set(missing[i], { address: addr, created: null }); rows.push({ account: missing[i], address: addr, block: Number(block), ts: state.block.timestamp, tx: '' }); } });
        if (rows.length && ch) await ch.insert('accounts', rows).catch(() => {});
      } catch { /* contract lookup is best effort */ }
    }
    return map;
  }
  async function accountByAddress(address) {
    if (!state.block) return null;
    try {
      const info = await collector.reader.call('getAccountByAddr', [address], state.block.number);
      const id = Number(info.accountId);
      if (!id) return null;
      if (ch) await ch.insert('accounts', [{ account: id, address, block: Number(state.block.number), ts: state.block.timestamp, tx: '' }]).catch(() => {});
      return { id, address, created: null };
    } catch { return null; }
  }

  // --- windows ------------------------------------------------------------
  const headTs = () => ingest.status.live.toTs ?? Math.floor(now() / 1000);
  const firstTs = () => { const iv = ingest.coverage.intervals; return iv.length ? iv[0].fromTs : headTs(); };
  function windowOf(query) {
    const w = query.get('window') || '24h';
    if (!Object.hasOwn(WINDOWS, w)) throw bad('INVALID_WINDOW');
    return w;
  }
  function rangeOf(w, to = headTs() + 1) {
    const len = WINDOWS[w];
    const from = len === null ? firstTs() : to - len;
    return { from, to };
  }
  function coverageOf(from, to) {
    const cov = ingest.coverage;
    const complete = cov.spanCovered(from, to - 1);
    return { complete, covered_since_deploy: cov.contiguousTs(), backfill: ingest.progress() };
  }
  function metaOf(extra = {}) {
    return { block: ingest.status.live.to?.toString() ?? null, ts: ingest.status.live.toTs, finalized_block: ingest.status.live.finalized?.toString() ?? null, generated_at: now(), ...extra };
  }

  // --- protocol -------------------------------------------------------------
  function sumMarkets(rows) {
    const t = { volume: 0n, fills: 0, maker_fees: 0n, taker_fees: 0n, builder_fees: 0n, ins_fees: 0n, prot_fees: 0n, taker_buy: 0n, taker_sell: 0n, trades: 0, opens: 0, closes: 0, liquidations: 0, liquidated: 0n, deleverages: 0, deleveraged: 0n, realized: 0n };
    for (const r of rows) for (const k of Object.keys(t)) t[k] += typeof t[k] === 'bigint' ? B(r[k]) : Number(r[k]);
    return t;
  }
  async function windowTotals(from, to) {
    const [markets, protocol, traders, marketTraders] = await Promise.all([queries.marketTotals(from, to), queries.protocolTotals(from, to), queries.traders(from, to), queries.traders(from, to, { by: 'market' })]);
    const p = protocol[0] ?? {};
    return { markets, t: sumMarkets(markets), p: { deposits: B(p.deposits), withdrawals: B(p.withdrawals), deposit_count: Number(p.deposit_count ?? 0), withdrawal_count: Number(p.withdrawal_count ?? 0), protocol_in: B(p.protocol_in), protocol_out: B(p.protocol_out), new_accounts: Number(p.new_accounts ?? 0) }, traders: Number(traders[0]?.traders ?? 0), marketTraders: new Map(marketTraders.map(r => [Number(r.market), Number(r.traders)])) };
  }
  // Fees charged on fills; the exchange splits each into an insurance-fund
  // part and a protocol part (ins_fees + prot_fees == fees, checked at ingest).
  const feesOf = t => t.maker_fees + t.taker_fees;

  function current() {
    const computed = computeMetrics(state);
    if (!computed) return null;
    const c = cd();
    let oi = 0n, insurance = 0n, longs = 0, shorts = 0;
    const markets = new Map();
    for (const { market, metrics: x } of computed.markets) {
      const u = m.units(market.priceDecimals, market.lotDecimals, c);
      const one = m.notionalCNS(market.markPNS, market.longOpenInterestLNS, u); // long lots == short lots
      oi += one; insurance += market.insuranceBalanceCNS; longs += x.long.count; shorts += x.short.count;
      markets.set(market.id, { market, x, oi: one });
    }
    return { block: state.block.number, oi, tvl: state.exchangeInfo.balanceCNS, insurance, protocol: state.exchangeInfo.protocolBalanceCNS, accounts: state.exchangeInfo.numberOfAccounts, positions: longs + shorts, longs, shorts, markets, fundingInterval: state.exchangeInfo.fundingInterval, blockTimeMs: state.stats.blockTimeMs || 400 };
  }
  function fundingOf(market, cur) {
    const perInterval = m.fundingRateFraction(market.fundingRatePct100k);
    const intervalMs = Number(cur.fundingInterval) * cur.blockTimeMs;
    return { rate_pct: perInterval * 100, rate_8h_pct: intervalMs ? perInterval * (8 * 3600000 / intervalMs) * 100 : null, apr_pct: intervalMs ? perInterval * (365 * 86400000 / intervalMs) * 100 : null, interval_seconds: intervalMs ? Math.round(intervalMs / 1000) : null };
  }

  async function protocol(query) {
    const w = windowOf(query);
    return cache.get(`protocol:${w}`, w === '24h' ? 2000 : 8000, async () => {
      const { from, to } = rangeOf(w);
      const len = to - from;
      const [cur, prev, windows] = await Promise.all([
        windowTotals(from, to),
        WINDOWS[w] === null ? null : windowTotals(from - len, from).catch(() => null),
        Promise.all(['24h', '7d', '30d', 'all'].map(async x => { if (x === w) return null; const r = rangeOf(x); const [mk, tr] = await Promise.all([queries.marketTotals(r.from, r.to), queries.traders(r.from, r.to)]); return [x, sumMarkets(mk), Number(tr[0]?.traders ?? 0)]; }))
      ]);
      const c = cd();
      const hl = (a, b) => ({ value: dec(a, c), prev: b === null ? null : dec(b, c), change_pct: b === null ? null : pctChange(a, b) });
      const hn = (a, b) => ({ value: a, prev: b, change_pct: b === null || b === 0 ? null : Math.round((a - b) / b * 10000) / 100 });
      const T = cur.t, P = prev?.t ?? null, pp = prev?.p ?? null;
      const multi = { '24h': null, '7d': null, '30d': null, all: null };
      for (const entry of windows) if (entry) multi[entry[0]] = { volume: dec(entry[1].volume, c), fees: dec(feesOf(entry[1]), c), trades: entry[1].trades, traders: entry[2] };
      multi[w] = { volume: dec(T.volume, c), fees: dec(feesOf(T), c), trades: T.trades, traders: cur.traders };
      const live = current();
      const markets = cur.markets.map(r => {
        const id = Number(r.market), lm = live?.markets.get(id);
        const vol = B(r.volume), open = B(r.open_price), close = B(r.close_price);
        return {
          id, symbol: symbol(id), name: meta(id)?.name ?? null,
          volume: dec(vol, c), share_pct: share(vol, T.volume), trades: Number(r.trades), fills: Number(r.fills), traders: cur.marketTraders.get(id) ?? 0,
          fees: dec(B(r.maker_fees) + B(r.taker_fees), c), protocol_fees: dec(r.prot_fees, c), insurance_fees: dec(r.ins_fees, c),
          open: open > 0n ? price(open, id) : null, close: close > 0n ? price(close, id) : null, high: B(r.high_price) > 0n ? price(r.high_price, id) : null, low: B(r.low_price) > 0n ? price(r.low_price, id) : null,
          change_pct: open > 0n && close > 0n ? pctChange(close, open) : null,
          taker_buy: dec(r.taker_buy, c), taker_sell: dec(r.taker_sell, c), taker_buy_share_pct: share(B(r.taker_buy), B(r.taker_buy) + B(r.taker_sell)),
          liquidations: Number(r.liquidations), liquidated: dec(r.liquidated, c), realized: dec(r.realized, c),
          ...(lm ? {
            mark: price(lm.market.markPNS, id), open_interest: dec(lm.oi, c), oi_share_pct: share(lm.oi, live.oi),
            long_positions: lm.x.long.count, short_positions: lm.x.short.count, long_position_share_pct: lm.x.long.count + lm.x.short.count ? Math.round(lm.x.long.count / (lm.x.long.count + lm.x.short.count) * 10000) / 100 : null,
            long_leverage: lm.x.long.averageLeverageBps === null ? null : Number(lm.x.long.averageLeverageBps) / 10000, short_leverage: lm.x.short.averageLeverageBps === null ? null : Number(lm.x.short.averageLeverageBps) / 10000,
            oi_cap_pct: lm.x.oi.utilisationBps === null ? null : Number(lm.x.oi.utilisationBps) / 100, max_leverage: Number(lm.market.initHdths) / 100,
            funding: fundingOf(lm.market, live), insurance: dec(lm.market.insuranceBalanceCNS, c), active: lm.market.status === 4
          } : {})
        };
      });
      for (const [id, lm] of live?.markets ?? []) if (!markets.some(x => x.id === id)) markets.push({ id, symbol: symbol(id), name: meta(id)?.name ?? null, volume: dec(0n, c), share_pct: 0, trades: 0, fills: 0, traders: 0, fees: dec(0n, c), mark: price(lm.market.markPNS, id), open_interest: dec(lm.oi, c), long_positions: lm.x.long.count, short_positions: lm.x.short.count, funding: fundingOf(lm.market, live), active: lm.market.status === 4 });
      markets.sort((a, b) => Number(b.volume) - Number(a.volume) || Number(b.open_interest ?? 0) - Number(a.open_interest ?? 0));
      return {
        meta: metaOf({ window: w, from, to, coverage: coverageOf(from, to), previous_complete: prev ? ingest.coverage.spanCovered(from - len, from - 1) : null }),
        headline: {
          volume: hl(T.volume, P?.volume ?? null), fees: hl(feesOf(T), P ? feesOf(P) : null),
          protocol_fees: hl(T.prot_fees, P?.prot_fees ?? null), insurance_fees: hl(T.ins_fees, P?.ins_fees ?? null), builder_fees: dec(T.builder_fees, c),
          trades: hn(T.trades, P?.trades ?? null), traders: hn(cur.traders, prev?.traders ?? null), new_accounts: hn(cur.p.new_accounts, pp?.new_accounts ?? null),
          liquidations: hn(T.liquidations, P?.liquidations ?? null), liquidated: hl(T.liquidated, P?.liquidated ?? null), deleverages: T.deleverages,
          deposits: hl(cur.p.deposits, pp?.deposits ?? null), withdrawals: hl(cur.p.withdrawals, pp?.withdrawals ?? null), net_flow: hl(cur.p.deposits - cur.p.withdrawals, pp ? pp.deposits - pp.withdrawals : null),
          taker_buy_share_pct: share(T.taker_buy, T.taker_buy + T.taker_sell), realized_pnl: dec(T.realized, c),
          take_rate_bps: T.volume > 0n ? Number(feesOf(T) * 1000000n / T.volume) / 100 : null
        },
        windows: multi,
        current: live ? { block: live.block.toString(), open_interest: dec(live.oi, c), tvl: dec(live.tvl, c), insurance: dec(live.insurance, c), protocol_balance: dec(live.protocol, c), accounts: live.accounts.toString(), positions: live.positions, long_positions: live.longs, short_positions: live.shorts, long_position_share_pct: live.positions ? Math.round(live.longs / live.positions * 10000) / 100 : null } : null,
        markets
      };
    });
  }

  function bucketOf(w, query) {
    const b = query.get('bucket') || DEFAULT_BUCKET[w];
    if (!Object.hasOwn(BUCKETS, b)) throw bad('INVALID_BUCKET');
    const seconds = BUCKETS[b];
    if (WINDOWS[w] !== null && WINDOWS[w] / seconds > 800) throw bad('BUCKET_TOO_SMALL');
    if (WINDOWS[w] === null && (headTs() - firstTs()) / seconds > 2000) throw bad('BUCKET_TOO_SMALL');
    return { name: b, seconds };
  }

  async function series(query) {
    const w = windowOf(query);
    const bucket = bucketOf(w, query);
    const marketFilter = /^\d{1,5}$/.test(query.get('market') ?? '') ? Number(query.get('market')) : null;
    return cache.get(`series:${w}:${bucket.name}:${marketFilter}`, w === '24h' ? 3000 : 15000, async () => {
      const range = rangeOf(w);
      const from = Math.floor(range.from / bucket.seconds) * bucket.seconds, to = range.to;
      const [rows, flows, traderRows, base, lastPrices] = await Promise.all([
        queries.marketTotals(from, to, { bucket: bucket.seconds }),
        queries.protocolTotals(from, to, { bucket: bucket.seconds }),
        queries.traders(from, to, { bucket: bucket.seconds }),
        queries.cumulativeBefore(from),
        queries.lastPricesBefore(from)
      ]);
      const c = cd();
      const baseComplete = ingest.coverage.contiguousTs() !== null && ingest.coverage.contiguousTs() >= from;
      const times = [];
      for (let t = from; t < to; t += bucket.seconds) times.push(t);
      const byT = new Map(times.map(t => [t, []]));
      for (const r of rows) { const list = byT.get(Number(r.t)); if (list) list.push(r); }
      const flowT = new Map(flows.map(r => [Number(r.t), r]));
      const tradersT = new Map(traderRows.map(r => [Number(r.t), Number(r.traders)]));
      const lots = new Map([...base.oi].map(([id, v]) => [id, v.long]));
      const prices = new Map(lastPrices);
      let tvl = base.net;
      const perMarket = new Map();
      const points = times.map(t => {
        const list = byT.get(t);
        const pick = marketFilter === null ? list : list.filter(r => Number(r.market) === marketFilter);
        const s = sumMarkets(pick);
        for (const r of list) {
          const id = Number(r.market);
          lots.set(id, (lots.get(id) ?? 0n) + B(r.oi_long));
          if (Number(r.fills) > 0 && B(r.close_price) > 0n) prices.set(id, B(r.close_price));
          if (marketFilter === null) { const arr = perMarket.get(id) ?? []; arr.push([t, B(r.volume), B(r.liquidated), B(r.maker_fees) + B(r.taker_fees)]); perMarket.set(id, arr); }
        }
        let oi = 0n;
        for (const [id, l] of lots) { if (marketFilter !== null && id !== marketFilter) continue; const u = unitsOf(id), p = prices.get(id); if (u && p) oi += m.notionalCNS(p, l, u); }
        const f = flowT.get(t);
        const netFlow = f ? B(f.deposits) - B(f.withdrawals) : 0n;
        tvl += f ? netFlow + B(f.protocol_in) - B(f.protocol_out) : 0n;
        const point = { t, volume: dec(s.volume, c), trades: s.trades, fees: dec(feesOf(s), c), protocol_fees: dec(s.prot_fees, c), taker_buy: dec(s.taker_buy, c), taker_sell: dec(s.taker_sell, c), liquidations: s.liquidations, liquidated: dec(s.liquidated, c), realized_pnl: dec(s.realized, c), open_interest: baseComplete ? dec(oi, c) : null };
        if (marketFilter === null) Object.assign(point, { traders: tradersT.get(t) ?? 0, deposits: dec(f?.deposits ?? 0, c), withdrawals: dec(f?.withdrawals ?? 0, c), net_flow: dec(netFlow, c), new_accounts: Number(f?.new_accounts ?? 0), tvl: baseComplete ? dec(tvl, c) : null });
        else { const r = pick[0]; Object.assign(point, { open: r && B(r.open_price) > 0n ? price(r.open_price, marketFilter) : null, high: r && B(r.high_price) > 0n ? price(r.high_price, marketFilter) : null, low: r && B(r.low_price) > 0n ? price(r.low_price, marketFilter) : null, close: prices.get(marketFilter) ? price(prices.get(marketFilter), marketFilter) : null }); }
        return point;
      });
      const column = (arr, i) => { const byT = new Map(arr.map(x => [x[0], x[i]])); return times.map(t => dec(byT.get(t) ?? 0n, c)); };
      const byMarket = marketFilter === null ? [...perMarket].map(([id, arr]) => ({ id, symbol: symbol(id), total: dec(arr.reduce((a, x) => a + x[1], 0n), c), volume: column(arr, 1), liquidated: column(arr, 2), fees: column(arr, 3) })).sort((a, b) => Number(b.total) - Number(a.total)) : null;
      return { meta: metaOf({ window: w, from, to, bucket: bucket.name, bucket_seconds: bucket.seconds, market: marketFilter, coverage: coverageOf(from, to), cumulative_complete: baseComplete }), times, points, by_market: byMarket };
    });
  }

  // --- feeds ------------------------------------------------------------------
  function tradeView(r, addressOf = null) {
    const id = Number(r.market), c = cd();
    return { block: String(r.block), log_index: Number(r.log_index), ts: Number(r.ts), tx: r.tx, kind: r.kind, market: id, symbol: symbol(id), account: Number(r.account), address: addressOf?.get(Number(r.account))?.address ?? null, side: Number(r.side) === 0 ? 'long' : Number(r.side) === 1 ? 'short' : null, buy: Number(r.buy) === 1, role: r.role, price: B(r.price) > 0n ? price(r.price, id) : null, size: size(r.lot, id), notional: dec(r.notional, c), fee: dec(B(r.fee) + B(r.builder_fee), c), pnl: dec(B(r.pnl) + B(r.funding), c), leverage: Number(r.leverage) ? Number(r.leverage) / 100 : null, remaining: size(r.end_lot, id), mark: B(r.mark) > 0n ? price(r.mark, id) : null, on_book: (Number(r.flags) & 1) === 1 };
  }
  async function liquidations(query) {
    const limit = Math.min(Math.max(Number(query.get('limit')) || 100, 1), 500);
    const market = /^\d{1,5}$/.test(query.get('market') ?? '') ? Number(query.get('market')) : null;
    return cache.get(`liq:${limit}:${market}`, 3000, async () => {
      const rows = await queries.recent(['liquidation', 'deleverage'], { limit, market });
      const addr = await addresses([...new Set(rows.map(r => Number(r.account)))]);
      const { from, to } = rangeOf('24h');
      const day = sumMarkets(await queries.marketTotals(from, to));
      return { meta: metaOf(), last_24h: { count: day.liquidations, notional: dec(day.liquidated, cd()), deleverages: day.deleverages }, rows: rows.map(r => tradeView(r, addr)) };
    });
  }
  async function trades(query) {
    const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 200);
    const market = /^\d{1,5}$/.test(query.get('market') ?? '') ? Number(query.get('market')) : null;
    return cache.get(`trades:${limit}:${market}`, 1000, async () => {
      const rows = await queries.recent(['open', 'increase', 'decrease', 'close', 'invert', 'liquidation'], { limit: limit * 2, market, sinceTs: headTs() - 7 * DAY });
      const takers = rows.filter(r => r.role === 'taker').slice(0, limit); // one row per aggressor
      const addr = await addresses([...new Set(takers.map(r => Number(r.account)))]);
      return { meta: metaOf(), rows: takers.map(r => tradeView(r, addr)) };
    });
  }
  async function funding(marketId, query) {
    const id = Number(marketId);
    if (!ingest.markets.has(id)) throw bad('MARKET_NOT_FOUND', 404);
    const limit = Math.min(Math.max(Number(query.get('limit')) || 200, 1), 2000);
    return cache.get(`funding:${id}:${limit}`, 10000, async () => {
      const rows = await queries.fundingHistory(id, { limit });
      const live = current();
      return { meta: metaOf(), market: id, symbol: symbol(id), current: live?.markets.get(id) ? fundingOf(live.markets.get(id).market, live) : null, rows: rows.map(r => ({ funding_block: String(r.funding_block), ts: Number(r.ts), tx: r.tx, rate_pct: Number(r.actual_rate) / 1000, specified_rate_pct: Number(r.specified_rate) / 1000, price: price(r.price, id) })) };
    });
  }
  async function fundingOverview(query) {
    const w = query.get('window') && Object.hasOwn(WINDOWS, query.get('window')) ? query.get('window') : '7d';
    return cache.get(`funding-overview:${w}`, 15000, async () => {
      const { from, to } = rangeOf(w);
      const bucket = w === '24h' ? HOUR : w === '7d' ? 4 * HOUR : DAY;
      const rows = await queries.fundingSeries(Math.floor(from / bucket) * bucket, to, bucket);
      const live = current();
      const markets = [...(live?.markets ?? new Map())].map(([id, lm]) => ({ id, symbol: symbol(id), ...fundingOf(lm.market, live), long_positions: lm.x.long.count, short_positions: lm.x.short.count, open_interest: dec(lm.oi, cd()) }));
      const series = new Map();
      for (const r of rows) { const id = Number(r.market); const arr = series.get(id) ?? []; arr.push({ t: Number(r.t), rate_pct: Number(r.rate) / 1000 }); series.set(id, arr); }
      return { meta: metaOf({ window: w, bucket_seconds: bucket }), markets, series: [...series].map(([id, points]) => ({ id, symbol: symbol(id), points })) };
    });
  }

  async function flows(query) {
    const w = windowOf(query);
    return cache.get(`flows:${w}`, 10000, async () => {
      const { from, to } = rangeOf(w);
      const [dep, wd] = await Promise.all([queries.accounts(from, to, { sort: 'deposits', limit: 10 }), queries.accounts(from, to, { sort: 'withdrawals', limit: 10 })]);
      const addr = await addresses([...new Set([...dep.rows, ...wd.rows].map(r => Number(r.account)))]);
      const c = cd();
      const view = r => ({ account: Number(r.account), address: addr.get(Number(r.account))?.address ?? null, deposits: dec(r.deposits, c), withdrawals: dec(r.withdrawals, c), net: dec(B(r.deposits) - B(r.withdrawals), c) });
      const recentRows = await queries.recent(['deposit', 'withdrawal'], { limit: 30 });
      const addr2 = await addresses([...new Set(recentRows.map(r => Number(r.account)))]);
      return { meta: metaOf({ window: w, coverage: coverageOf(from, to) }), top_depositors: dep.rows.filter(r => B(r.deposits) > 0n).map(view), top_withdrawers: wd.rows.filter(r => B(r.withdrawals) > 0n).map(view), recent: recentRows.map(r => ({ ts: Number(r.ts), block: String(r.block), tx: r.tx, kind: r.kind, account: Number(r.account), address: addr2.get(Number(r.account))?.address ?? null, amount: dec(r.amount, c), balance_after: dec(r.balance, c) })) };
    });
  }

  // --- leaderboard ---------------------------------------------------------------
  function openPositions(accountId) {
    const computed = computeMetrics(state);
    let count = 0, notional = 0n, upnl = 0n;
    if (computed) for (const { metrics: x } of computed.markets) { const p = x.positions.find(q => q.accountId === BigInt(accountId)); if (p) { count++; notional += p.markNotionalCNS; upnl += p.pnlCNS; } }
    return { count, notional, upnl };
  }
  async function leaderboard(query) {
    const w = windowOf(query);
    const sort = query.get('by') || 'pnl';
    const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 200);
    const offset = Math.min(Math.max(Number(query.get('offset')) || 0, 0), 10000);
    const market = /^\d{1,5}$/.test(query.get('market') ?? '') ? Number(query.get('market')) : null;
    return cache.get(`lb:${w}:${sort}:${limit}:${offset}:${market}`, w === '24h' ? 5000 : 20000, async () => {
      const { from, to } = rangeOf(w);
      const { total, rows } = await queries.accounts(from, to, { sort, limit, offset, market });
      const addr = await addresses(rows.map(r => Number(r.account)));
      const c = cd();
      return {
        meta: metaOf({ window: w, from, to, sort, market, coverage: coverageOf(from, to) }), total,
        rows: rows.map((r, i) => { const id = Number(r.account), open = openPositions(id); const vol = B(r.volume), net = B(r.realized) - B(r.fees); return { rank: offset + i + 1, account: id, address: addr.get(id)?.address ?? null, pnl: dec(net, c), realized: dec(r.realized, c), fees: dec(r.fees, c), volume: dec(vol, c), maker_share_pct: share(B(r.maker_volume), vol), trades: Number(r.trades), roi_on_volume_bps: vol > 0n ? Number(net * 100000000n / vol) / 10000 : null, liquidations: Number(r.liquidations), liquidated: dec(r.liquidated, c), deposits: dec(r.deposits, c), withdrawals: dec(r.withdrawals, c), markets: (r.markets ?? []).map(Number).map(symbol), open_positions: open.count, open_notional: dec(open.notional, c), unrealized_pnl: dec(open.upnl, c) }; })
      };
    });
  }

  // --- wallets ------------------------------------------------------------------
  // Keys the contract does not know are remembered briefly, so repeated
  // lookups of a mistyped address cost no RPC call (indexed accounts are
  // always checked first, so a new account is found as soon as it is ingested).
  const misses = new Map();
  const knownMiss = key => { const until = misses.get(key); if (until > Date.now()) return true; misses.delete(key); return false; };
  const notFound = key => { if (misses.size >= 10000) misses.delete(misses.keys().next().value); misses.set(key, Date.now() + 30000); return bad('ACCOUNT_NOT_FOUND', 404); };
  async function resolve(key) {
    const text = String(key).trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(text)) {
      const hit = (await queries.findAccounts(text))[0];
      if (hit) return { id: Number(hit.account), address: hit.address, created: Number(hit.ts) };
      if (knownMiss(text)) throw bad('ACCOUNT_NOT_FOUND', 404);
      const live = await accountByAddress(text);
      if (!live) throw notFound(text);
      return live;
    }
    if (/^[1-9]\d{0,8}$/.test(text)) {
      const hit = (await queries.findAccounts(text))[0];
      if (hit) return { id: Number(hit.account), address: hit.address, created: Number(hit.ts) };
      if (knownMiss(text)) throw bad('ACCOUNT_NOT_FOUND', 404);
      const found = (await addresses([Number(text)])).get(Number(text));
      if (!found) throw notFound(text);
      return { id: Number(text), address: found.address, created: null };
    }
    throw bad('INVALID_ACCOUNT');
  }
  async function search(query) {
    const q = String(query.get('q') ?? '').trim();
    if (q.length < 1 || q.length > 42) throw bad('INVALID_QUERY');
    let rows = (await queries.findAccounts(q, { limit: 8 })).map(r => ({ account: Number(r.account), address: r.address, created: Number(r.ts) }));
    if (!rows.length && /^0x[0-9a-fA-F]{40}$/.test(q)) { const live = await accountByAddress(q.toLowerCase()); if (live) rows = [{ account: live.id, address: live.address, created: null }]; }
    if (!rows.length && /^[1-9]\d{0,8}$/.test(q)) { const found = (await addresses([Number(q)])).get(Number(q)); if (found) rows = [{ account: Number(q), address: found.address, created: null }]; }
    return { meta: metaOf(), rows };
  }

  // Wallet page, fast part: totals, per-market sums and daily PnL come from
  // the rollups; positions and balances from the contract (never cached).
  async function profile(key) {
    const acct = await resolve(key);
    const c = cd();
    const view = await cache.get(`wallet:${acct.id}`, 4000, async () => {
      const all = rangeOf('all');
      const [marketRows, daily, recentRows, flowRows] = await Promise.all([queries.accountMarkets(acct.id, all.from, all.to), queries.accountSeries(acct.id, all.from, all.to, DAY), queries.accountTrades(acct.id, { limit: 100 }), queries.accountFlows(acct.id, { limit: 100 })]);
      const sums = { volume: 0n, maker: 0n, trades: 0, fees: 0n, realized: 0n, funding: 0n, liquidations: 0, deposits: 0n, withdrawals: 0n };
      for (const r of marketRows) { sums.volume += B(r.volume); sums.maker += B(r.maker_volume); sums.trades += Number(r.trades); sums.fees += B(r.fees); sums.realized += B(r.realized); sums.funding += B(r.funding_paid); sums.liquidations += Number(r.liquidations); sums.deposits += B(r.deposits); sums.withdrawals += B(r.withdrawals); }
      const active = daily.filter(r => Number(r.trades) > 0);
      let cum = 0n;
      const addr = new Map([[acct.id, { address: acct.address }]]);
      return {
        account: { id: acct.id, address: acct.address, created: acct.created },
        summary: { volume: dec(sums.volume, c), trades: sums.trades, realized: dec(sums.realized, c), fees: dec(sums.fees, c), net_pnl: dec(sums.realized - sums.fees, c), funding: dec(sums.funding, c), liquidations: sums.liquidations, deposits: dec(sums.deposits, c), withdrawals: dec(sums.withdrawals, c), net_flow: dec(sums.deposits - sums.withdrawals, c), first_trade: active.length ? Number(active[0].t) : null, last_trade: recentRows.length ? Number(recentRows[0].ts) : null, active_days: active.length, maker_share_pct: share(sums.maker, sums.volume) },
        markets: marketRows.filter(r => Number(r.market) !== 0 && Number(r.trades) > 0).map(r => ({ market: Number(r.market), symbol: symbol(Number(r.market)), volume: dec(r.volume, c), trades: Number(r.trades), realized: dec(r.realized, c), fees: dec(r.fees, c), net_pnl: dec(B(r.realized) - B(r.fees), c), liquidations: Number(r.liquidations) })).sort((a, b) => Number(b.volume) - Number(a.volume)),
        pnl_daily: daily.map(r => { const net = B(r.realized) - B(r.fees); cum += net; return { t: Number(r.t), net_pnl: dec(net, c), realized: dec(r.realized, c), fees: dec(r.fees, c), volume: dec(r.volume, c), trades: Number(r.trades), cumulative: dec(cum, c) }; }),
        recent_trades: recentRows.map(r => tradeView(r, addr)),
        flows: flowRows.map(r => ({ ts: Number(r.ts), block: String(r.block), tx: r.tx, kind: r.kind, amount: dec(r.amount, c), balance_after: dec(r.balance, c) }))
      };
    });
    const live = accountState ? await accountState(view.account.id).catch(() => null) : null;
    return { meta: metaOf({ coverage: { complete: ingest.coverage.contiguousTs() !== null, backfill: ingest.progress() } }), ...view, portfolio: live?.portfolio ?? null, positions: live?.positions ?? [] };
  }

  // Wallet page, analytics part: round trips over the account's events
  // (latest maxTripEvents), performance, behaviour notes and activity.
  async function walletAnalytics(key) {
    const acct = await resolve(key);
    const c = cd();
    return cache.get(`wallet-analytics:${acct.id}`, 30000, async () => {
      const [total, rows] = await Promise.all([queries.accountEventCount(acct.id), queries.accountEvents(acct.id, { limit: maxTripEvents })]);
      const { trips, openTrips } = roundTrips(rows);
      const perf = performance(trips);
      const tripView = t => ({ market: t.market, symbol: symbol(t.market), side: t.side === 0 ? 'long' : 'short', open_ts: t.openTs, first_ts: t.firstTs, close_ts: t.closeTs, hold_seconds: t.complete && t.closeTs !== null ? t.closeTs - t.openTs : null, entry_notional: dec(t.entryNotional, c), exit_notional: dec(t.exitNotional, c), max_size: size(t.maxLot, t.market), realized: dec(t.realized, c), fees: dec(t.fees, c), funding: dec(t.funding, c), net_pnl: dec(t.net, c), return_pct: t.entryNotional > 0n ? Number(t.net * 1000000n / t.entryNotional) / 10000 : null, max_leverage: t.maxLeverage ? t.maxLeverage / 100 : null, complete: t.complete, liquidated: t.liquidated, deleveraged: t.deleveraged, events: t.events });
      return {
        account: { id: acct.id, address: acct.address },
        performance: {
          based_on: { events: rows.length, total_events: total, truncated: total > rows.length, since: rows.length ? Number(rows[0].ts) : null },
          closed_trips: perf.closedTrips, wins: perf.wins, losses: perf.losses, win_rate_pct: perf.winRate === null ? null : Math.round(perf.winRate * 10000) / 100,
          profit_factor: perf.profitFactor, net_pnl: dec(perf.net, c), gross_profit: dec(perf.grossProfit, c), gross_loss: dec(perf.grossLoss, c), expectancy: dec(perf.expectancy, c),
          average_win: dec(perf.averageWin, c), average_loss: dec(perf.averageLoss, c), largest_win: dec(perf.largestWin, c), largest_loss: dec(perf.largestLoss, c),
          max_drawdown: dec(perf.maxDrawdown, c), drawdown_from: perf.drawdownFrom, drawdown_to: perf.drawdownTo,
          best_streak: perf.bestStreak, worst_streak: perf.worstStreak, current_streak: perf.currentStreak,
          average_hold_seconds: perf.averageHold, median_hold_seconds: perf.medianHold, median_win_hold_seconds: perf.medianWinHold, median_loss_hold_seconds: perf.medianLossHold,
          long: { trips: perf.long.trips, win_rate_pct: perf.long.win_rate === null ? null : Math.round(perf.long.win_rate * 10000) / 100, net_pnl: dec(perf.long.net, c) },
          short: { trips: perf.short.trips, win_rate_pct: perf.short.win_rate === null ? null : Math.round(perf.short.win_rate * 10000) / 100, net_pnl: dec(perf.short.net, c) },
          liquidated_trips: perf.liquidatedTrips, deleveraged_trips: perf.deleveragedTrips,
          best_market: perf.bestMarket ? { market: perf.bestMarket.market, symbol: symbol(perf.bestMarket.market), net_pnl: dec(perf.bestMarket.net, c), trips: perf.bestMarket.trips } : null,
          worst_market: perf.worstMarket ? { market: perf.worstMarket.market, symbol: symbol(perf.worstMarket.market), net_pnl: dec(perf.worstMarket.net, c), trips: perf.worstMarket.trips } : null,
          markets: perf.markets.map(x => ({ market: x.market, symbol: symbol(x.market), trips: x.trips, wins: x.wins, win_rate_pct: x.trips ? Math.round(x.wins / x.trips * 10000) / 100 : null, net_pnl: dec(x.net, c) }))
        },
        insights: insights(perf, rows, { symbol }),
        activity: activityGrid(rows),
        trip_curve: perf.curve.slice(-2000).map(p => ({ t: p.ts, equity: dec(p.equity, c) })),
        trips: trips.slice(-200).reverse().map(tripView),
        open_trips: openTrips.map(tripView)
      };
    }).then(view => ({ meta: metaOf(), ...view }));
  }

  async function walletTrades(key, query) {
    const acct = await resolve(key);
    const before = /^\d{1,12}:\d{1,9}$/.test(query.get('before') ?? '') ? query.get('before') : null;
    const limit = Math.min(Math.max(Number(query.get('limit')) || 100, 1), query.get('format') === 'csv' ? 10000 : 500);
    const market = /^\d{1,5}$/.test(query.get('market') ?? '') ? Number(query.get('market')) : null;
    const rows = await queries.accountTrades(acct.id, { before, limit, market });
    const addr = new Map([[acct.id, { address: acct.address }]]);
    const list = rows.map(r => tradeView(r, addr));
    return { meta: metaOf(), account: { id: acct.id, address: acct.address }, next: rows.length === limit ? `${rows.at(-1).block}:${rows.at(-1).log_index}` : null, rows: list };
  }

  async function compare(query) {
    const keys = String(query.get('wallets') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (!keys.length || keys.length > 10) throw bad('INVALID_WALLETS');
    const out = await Promise.all(keys.map(k => Promise.all([profile(k), walletAnalytics(k)]).then(([p, a]) => ({ key: k, ...p, performance: a.performance })).catch(error => ({ key: k, error: error.status ? error.message : 'UNAVAILABLE' }))));
    return { meta: metaOf(), wallets: out };
  }

  // --- data integrity -------------------------------------------------------------
  // Event-derived open interest and TVL at the ingested head against the
  // contract's own counters (the collector reads them every poll).
  async function integrity() {
    return cache.get('integrity', 60000, async () => {
      const complete = ingest.coverage.contiguousTs() !== null && ingest.coverage.intervals.length === 1;
      if (!complete || !state.block) return { complete, open_interest: [], tvl: null };
      const block = state.block.number, head = ingest.status.live.to;
      if (head === null || head < block) return { complete, pending: true, open_interest: [], tvl: null };
      const cum = await queries.cumulativeAtBlock(block, state.block.timestamp);
      const checks = [];
      for (const market of state.markets.values()) {
        const ev = cum.oi.get(market.id) ?? { long: 0n, short: 0n };
        checks.push({ market: market.id, symbol: market.symbol, events_long: size(ev.long, market.id), contract_long: size(market.longOpenInterestLNS, market.id), events_short: size(ev.short, market.id), contract_short: size(market.shortOpenInterestLNS, market.id), ok: ev.long === market.longOpenInterestLNS && ev.short === market.shortOpenInterestLNS });
      }
      const tvlOk = cum.net === state.exchangeInfo.balanceCNS;
      return { complete, block: block.toString(), method: 'Running sums of indexed events up to the contract snapshot block compared with the contract counters read at that same block.', open_interest: checks, tvl: { events: dec(cum.net, cd()), contract: dec(state.exchangeInfo.balanceCNS, cd()), ok: tvlOk } };
    });
  }

  return { protocol, series, liquidations, trades, funding, fundingOverview, flows, leaderboard, search, profile, walletAnalytics, walletTrades, compare, integrity, cache, tradeView, rangeOf };
}
