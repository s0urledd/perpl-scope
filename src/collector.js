// Persistent collector: bootstraps a pinned-block snapshot from the contract's
// own getters, then follows the chain by reading which positions each block
// touched and re-reading those positions from the contract at the new head.
//
// Correctness rests on three independent checks that run continuously:
//   1. every poll re-reads the previously processed block and re-checks its
//      hash, so a reorganisation forces a fresh bootstrap;
//   2. every poll sums stored positions per side and compares them with the
//      contract's own open-interest counters at the same block; any mismatch
//      marks the state stale and forces a fresh bootstrap;
//   3. periodically the whole account space is rescanned through the account
//      position bitmaps (an enumeration path independent of the paged getter)
//      and compared with the stored positions.
import { createReader } from './exchange.js';
import { processLogs, watchedTopics } from './events.js';
import { topicsFor } from './abi.js';
import { accountMarkets } from './snapshot-core.js';
import * as s from './state.js';
import { saveCheckpoint, loadCheckpoint } from './checkpoint.js';
import { bookOptions, readDepth } from './book.js';

const integer = (value, fallback) => { const n = Number(value ?? fallback); if (!Number.isFinite(n) || n < 0) throw new Error('INVALID_COLLECTOR_OPTION'); return n; };

export function collectorOptions(env = {}) {
  return {
    pollMs: integer(env.POLL_MS, 2000),
    logRange: BigInt(integer(env.LOG_RANGE, 100)),
    maxResumeGap: BigInt(integer(env.MAX_RESUME_GAP, 20000)),
    verifyEveryBlocks: BigInt(integer(env.VERIFY_BLOCKS, 12000)),
    backfillBlocks: BigInt(integer(env.BACKFILL_BLOCKS, 3000)),
    fundingHistoryEvents: integer(env.FUNDING_HISTORY_EVENTS, 48),
    checkpointPath: env.CHECKPOINT_PATH || 'data/checkpoint.json',
    checkpointEveryMs: integer(env.CHECKPOINT_MS, 10000),
    staleAfterMs: integer(env.STALE_AFTER_MS, 45000),
    finalizedEveryPolls: integer(env.FINALIZED_EVERY_POLLS, 10),
    accountScanBatch: integer(env.ACCOUNT_SCAN_BATCH, 50),
    maxAccounts: BigInt(integer(env.MAX_ACCOUNTS, 200000)),
    seriesEveryBlocks: BigInt(integer(env.SERIES_EVERY_BLOCKS, 200)),
    book: bookOptions(env)
  };
}

export function createCollector({ config, options = collectorOptions(), rpc, reader = createReader({ rpc, exchange: config.exchange }), log = () => {} }) {
  const state = s.createState({ chain: config.chain, exchange: config.exchange });
  let running = false, lastCheckpointAt = 0, lastVerifyBlock = null, polls = 0, consecutiveErrors = 0, verifying = false, lastBookAt = 0;
  state.series.everyBlocks = options.seriesEveryBlocks ?? state.series.everyBlocks;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function fetchLogs(from, to, topics = watchedTopics) {
    const logs = [];
    for (let first = from; first <= to; first += options.logRange) {
      const last = first + options.logRange - 1n > to ? to : first + options.logRange - 1n;
      logs.push(...await reader.getLogs({ fromBlock: first, toBlock: last, topics }));
    }
    return logs;
  }

  async function checkpoint(force = false) {
    if (!force && Date.now() - lastCheckpointAt < options.checkpointEveryMs) return;
    await saveCheckpoint(options.checkpointPath, state);
    lastCheckpointAt = Date.now();
  }

  // Full pinned-block snapshot through the contract's paged position getter.
  async function bootstrap(reason) {
    s.setStatus(state, 'syncing', reason);
    for (let attempt = 1; ; attempt++) {
      const head = await reader.getBlock('latest');
      const block = head.number;
      const exchangeInfo = await reader.readExchange(block);
      if (exchangeInfo.halted) log('warn', 'exchange reports halted');
      const ids = await reader.readMarketIds(block);
      const markets = await reader.readMarkets(ids, block);
      const positions = new Map();
      for (const market of markets) positions.set(market.id, await reader.readAllPositions(market.id, block));
      const earlier = block > 1000n ? await reader.getBlock(block - 1000n) : null;
      const recheck = await reader.getBlock(block);
      if (recheck.hash !== head.hash) { if (attempt >= 3) throw new Error('BOOTSTRAP_HASH_UNSTABLE'); continue; }
      // Apply atomically from the API's point of view (no awaits below).
      if (earlier && head.timestamp > earlier.timestamp) state.stats.blockTimeMs = Math.round((head.timestamp - earlier.timestamp) * 1000 / Number(block - earlier.number));
      state.markets.clear();
      s.setBlock(state, head);
      s.applyExchange(state, exchangeInfo);
      s.applyMarkets(state, markets);
      for (const [id, read] of positions) s.replaceMarketPositions(state, id, read.positions, read.markPNS);
      const reconciliation = s.reconcile(state);
      if (!reconciliation.ok) { if (attempt >= 3) throw new Error('BOOTSTRAP_RECONCILE_FAILED'); continue; }
      state.bootstrap = { block: block, hash: head.hash, at: Date.now(), reason, attempt, requests: reader.stats.requests };
      state.stats.lastSuccessAt = Date.now();
      s.setStatus(state, 'fresh', null);
      log('info', `bootstrap complete at block ${block} (${reason}, attempt ${attempt})`);
      await checkpoint(true);
      return;
    }
  }

  async function backfillHistory() {
    if (!state.block) return;
    const to = state.block.number;
    const from = to > options.backfillBlocks ? to - options.backfillBlocks : 0n;
    const processed = processLogs(await fetchLogs(from, to), { chain: state.chain });
    s.appendHistory(state, processed);
    // Funding events are emitted shortly before each grid block; fetch the
    // windows preceding the most recent grid blocks only.
    const interval = state.exchangeInfo.fundingInterval;
    if (interval > 0n) {
      const topics = topicsFor(['FundingEventCompleted']);
      const latestGrid = to - (to % interval);
      for (let k = 0; k < options.fundingHistoryEvents; k++) {
        const grid = latestGrid - BigInt(k) * interval;
        if (grid <= 0n || (k === 0 && grid > to)) continue;
        const windowFrom = grid - 200n > 0n ? grid - 200n : 0n;
        if (grid >= from && grid <= to && k === 0) continue; // already covered above
        const logs = await fetchLogs(windowFrom, grid, topics);
        s.appendHistory(state, processLogs(logs, { chain: state.chain }));
      }
      state.history.funding.sort((a, b) => Number(a.fundingEventBlock - b.fundingEventBlock) || a.perpId - b.perpId);
    }
    state.stats.backfill = { from: from, to: to, logs: processed.decoded, at: Date.now() };
  }

  async function poll() {
    if (!state.block) throw new Error('NOT_BOOTSTRAPPED');
    polls++;
    const head = await reader.getBlock('latest');
    const previous = await reader.getBlock(state.block.number);
    if (previous.hash !== state.block.hash) { log('warn', `reorganisation at block ${state.block.number}`); return bootstrap('reorg'); }
    if (head.number <= state.block.number) { state.stats.lastSuccessAt = Date.now(); return; }
    const from = state.block.number + 1n, to = head.number;
    if (to - from + 1n > options.maxResumeGap) return bootstrap('gap');
    const processed = processLogs(await fetchLogs(from, to), { chain: state.chain });
    const ids = await reader.readMarketIds(to);
    const known = new Set(state.markets.keys());
    const added = ids.filter(id => !known.has(id)), removed = [...known].filter(id => !ids.includes(id));
    const markets = await reader.readMarkets(ids, to);
    const exchangeInfo = await reader.readExchange(to);
    const interval = exchangeInfo.fundingInterval;
    const fundingCrossed = interval > 0n && (state.block.number / interval) !== (to / interval);
    const refresh = new Set(added);
    if (fundingCrossed) for (const id of ids) refresh.add(id);
    for (const f of processed.funding) if (f.fundingEventBlock >= from && f.fundingEventBlock <= to) refresh.add(f.perpId);
    const dirty = [...processed.dirty.values()].filter(d => ids.includes(d.perpId) && !refresh.has(d.perpId));
    const positionReads = dirty.length ? await reader.readPositions(dirty, to) : [];
    const refreshed = new Map();
    for (const id of refresh) refreshed.set(id, await reader.readAllPositions(id, to));
    const finalized = polls % options.finalizedEveryPolls === 1 ? await reader.getBlock('finalized').catch(() => null) : null;
    const recheck = await reader.getBlock(to);
    if (recheck.hash !== head.hash) { log('warn', `head hash changed during poll at block ${to}`); return; }
    // Apply atomically.
    s.setBlock(state, head, finalized);
    s.applyExchange(state, exchangeInfo);
    if (removed.length) s.removeMarkets(state, removed);
    s.applyMarkets(state, markets);
    for (const [id, read] of refreshed) s.replaceMarketPositions(state, id, read.positions, read.markPNS);
    s.applyPositionReads(state, positionReads);
    s.appendHistory(state, processed);
    state.stats.polls++; state.stats.logs += processed.decoded; state.stats.dirtyReads += positionReads.length;
    const reconciliation = s.reconcile(state);
    if (!reconciliation.ok) {
      log('warn', `open-interest mismatch at block ${to}: ${JSON.stringify(reconciliation.mismatches, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
      s.setStatus(state, 'stale', 'oi-mismatch');
      return bootstrap('oi-mismatch');
    }
    state.stats.lastSuccessAt = Date.now();
    s.setStatus(state, 'fresh', null);
    await checkpoint();
  }

  // Independent enumeration through account position bitmaps at the current
  // block, compared with the stored positions of that same block.
  async function verify() {
    if (!state.block || verifying) return null;
    verifying = true;
    const started = performance.now(), requestsBefore = reader.stats.requests;
    const block = state.block.number, hash = state.block.hash;
    const expected = new Map();
    for (const market of state.markets.values()) for (const p of market.positions.values()) expected.set(`${market.id}:${p.accountId}`, { lot: p.lotLNS, side: p.positionType });
    try {
      const count = state.exchangeInfo.numberOfAccounts;
      if (count > options.maxAccounts) throw new Error('ACCOUNT_LIMIT_EXCEEDED');
      const found = new Map(), candidates = [];
      for (let first = 1n; first <= count; first += BigInt(options.accountScanBatch)) {
        const ids = Array.from({ length: Number(count - first + 1n > BigInt(options.accountScanBatch) ? BigInt(options.accountScanBatch) : count - first + 1n) }, (_, i) => first + BigInt(i));
        const accounts = await reader.readAccounts(ids, block);
        accounts.forEach((account, i) => {
          if (account.accountId !== ids[i]) throw new Error('ACCOUNT_MISMATCH');
          for (const perpId of accountMarkets(account.positions)) candidates.push({ perpId, accountId: ids[i] });
        });
      }
      const reads = await reader.readPositions(candidates, block);
      for (const r of reads) if (r.position.lotLNS !== 0n) found.set(`${r.perpId}:${r.accountId}`, { lot: r.position.lotLNS, side: Number(r.position.positionType) });
      const mismatches = [];
      for (const [key, value] of expected) { const other = found.get(key); if (!other || other.lot !== value.lot || other.side !== value.side) mismatches.push({ key, stored: value, scanned: other ?? null }); }
      for (const key of found.keys()) if (!expected.has(key)) mismatches.push({ key, stored: null, scanned: found.get(key) });
      const recheck = await reader.getBlock(block);
      state.verification = { block, hash, ok: mismatches.length === 0 && recheck.hash === hash, canonical: recheck.hash === hash, accounts: count, candidates: candidates.length, scanned: found.size, stored: expected.size, mismatches: mismatches.slice(0, 20), requests: reader.stats.requests - requestsBefore, ms: Math.round(performance.now() - started), at: Date.now() };
      lastVerifyBlock = block;
      log('info', `verification at block ${block}: ${state.verification.ok ? 'OK' : 'MISMATCH'} (${state.verification.requests} requests, ${state.verification.ms} ms)`);
      if (!state.verification.ok && state.verification.canonical) { s.setStatus(state, 'stale', 'verification-mismatch'); await bootstrap('verification-mismatch'); }
    } catch (error) {
      state.verification = { block, hash, ok: null, error: error.message, at: Date.now() };
      log('warn', `verification failed: ${error.message}`);
    } finally { verifying = false; }
    return state.verification;
  }

  // Bounded walk of resting depth at the current state block.
  async function refreshBook(force = false) {
    if (!options.book?.enabled || !state.block) return null;
    if (!force && Date.now() - lastBookAt < options.book.refreshMs) return null;
    const block = state.block.number;
    const inputs = [...state.markets.values()].filter(x => x.markPNS > 0n && x.status === 4).map(x => ({ id: x.id, markPNS: x.markPNS, basePricePNS: x.basePricePNS, maxBidPriceONS: x.maxBidPriceONS ?? 0n, minAskPriceONS: x.minAskPriceONS ?? 0n }));
    const depth = await readDepth(reader, inputs, block, { levels: options.book.levels, rangeBps: options.book.rangeBps });
    if (state.block.number === block) s.applyBook(state, depth, block);
    lastBookAt = Date.now();
    return depth;
  }

  function sample() { try { return s.sampleSeries(state, s.metrics(state)); } catch (error) { log('warn', `series sample failed: ${error.message}`); return false; } }

  function freshness(now = Date.now()) {
    const age = state.stats.lastSuccessAt ? now - state.stats.lastSuccessAt : null;
    const status = !state.block ? 'syncing' : state.status === 'fresh' && age !== null && age > options.staleAfterMs ? 'stale' : state.status;
    return { status, reason: status === 'stale' && state.status === 'fresh' ? 'no-recent-poll' : state.statusReason, ageMs: age };
  }

  async function start() {
    running = true;
    try {
      const saved = await loadCheckpoint(options.checkpointPath, { chain: config.chain, exchange: config.exchange });
      if (saved) {
        const head = await reader.getBlock('latest');
        const canonical = await reader.getBlock(saved.block.number);
        if (canonical.hash === saved.block.hash && head.number - saved.block.number <= options.maxResumeGap) {
          Object.assign(state, saved, { status: 'syncing', statusReason: 'resume' });
          log('info', `resumed checkpoint at block ${saved.block.number}, head ${head.number}`);
        } else log('info', 'checkpoint rejected (non-canonical or too old); bootstrapping');
      }
    } catch (error) { log('warn', `checkpoint unusable: ${error.message}`); }
    while (running) {
      const started = performance.now();
      try {
        if (!state.block) { await bootstrap('start'); await backfillHistory(); }
        else await poll();
        consecutiveErrors = 0;
        try { await refreshBook(); } catch (error) { log('warn', `book refresh failed: ${error.message}`); }
        sample();
        if (state.block && (lastVerifyBlock === null || state.block.number - lastVerifyBlock >= options.verifyEveryBlocks)) verify().catch(() => {});
      } catch (error) {
        consecutiveErrors++; state.stats.errors++; state.stats.lastError = { message: error.message, at: Date.now() };
        if (consecutiveErrors >= 3 && state.block) s.setStatus(state, 'stale', 'rpc-errors');
        log('warn', `poll error: ${error.message}`);
      }
      state.stats.lastPollMs = Math.round(performance.now() - started);
      const delay = consecutiveErrors ? Math.min(options.pollMs * 2 ** consecutiveErrors, 60000) : options.pollMs;
      await sleep(delay);
    }
  }

  function stop() { running = false; }

  return { state, options, reader, start, stop, bootstrap, poll, verify, backfillHistory, refreshBook, sample, freshness, checkpoint: () => checkpoint(true) };
}
