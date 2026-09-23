// Entry point: event index (ClickHouse), risk collector (contract state),
// real-time feeds and the HTTP API with the dashboard.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { configuration, rpcClient } from './rpc.js';
import { createClickHouse } from './clickhouse.js';
import { migrate } from './schema.js';
import { createIngest, ingestOptions } from './ingest.js';
import { createRollups } from './rollup.js';
import { createQueries } from './query.js';
import { createAnalyticsApi } from './analytics-api.js';
import { createCollector, collectorOptions } from './collector.js';
import { createSse, createExecEvents, createHeadSubscription, speculativeTrades } from './live.js';
import { createSnapshots } from './snapshots.js';
import { createReference } from './reference.js';
import { createApi } from './api.js';

const env = process.env;
const log = (level, message) => console.log(JSON.stringify({ t: new Date().toISOString(), level, message: String(message).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, '<url>') }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const config = configuration(env);

// --- storage ---------------------------------------------------------------
const ch = createClickHouse({ url: env.CLICKHOUSE_URL || 'http://127.0.0.1:8123', user: env.CLICKHOUSE_USER || 'default', password: env.CLICKHOUSE_PASSWORD || '', database: env.CLICKHOUSE_DB || 'perpl', log });
for (let attempt = 1; !(await ch.ping()); attempt++) { if (attempt > 60) throw new Error('CLICKHOUSE_UNAVAILABLE'); await sleep(2000); }
await migrate(ch);

// --- chain -----------------------------------------------------------------
const rpcOptions = { timeoutMs: Number(env.RPC_TIMEOUT_MS || 30000), maxBytes: Number(env.RPC_MAX_BYTES || 64 * 1024 * 1024) };
const liveRpc = rpcClient(config.url, fetch, rpcOptions);
const collector = createCollector({ config, options: collectorOptions(env), rpc: rpcClient(config.url, fetch, { timeoutMs: Number(env.RPC_TIMEOUT_MS || 15000), maxBytes: 8 * 1024 * 1024 }), log });
const ingest = createIngest({ ch, config, liveRpc, archiveRpcs: config.archives.map(url => rpcClient(url, fetch, rpcOptions)), options: ingestOptions(env), log });
for (let attempt = 1; ; attempt++) {
  try { await ingest.init(); break; } catch (error) { log('warn', `ingest init failed (${attempt}): ${error.message}`); if (attempt >= 30) throw error; await sleep(5000); }
}
const rollups = createRollups({ ch, coverage: ingest.coverage, log });
await rollups.load();
const queries = createQueries({ ch, rollups, coverage: ingest.coverage });

// --- API -------------------------------------------------------------------
const sse = createSse({ log });
let api = null;
const analytics = createAnalyticsApi({ ch, ingest, rollups, queries, collector, accountState: id => api.accountState(id) });
const reference = env.REFERENCE_ENABLED === '1' ? createReference({ url: env.PERPL_CONTEXT_URL || undefined }) : null;
const feeds = { execEvents: null, heads: null };
const statusOf = () => ({
  index: { live: { ...ingest.status.live, from: ingest.status.live.from?.toString() ?? null, to: ingest.status.live.to?.toString() ?? null, finalized: ingest.status.live.finalized?.toString() ?? null }, backfill: ingest.progress(), coverage: ingest.coverage.intervals.map(x => ({ from: x.from.toString(), to: x.to.toString(), from_ts: x.fromTs, to_ts: x.toTs })), rollups: rollups.status, repaired_rows: ingest.status.repaired, decoder_checks: ingest.status.checks, clickhouse: ch.stats },
  feeds: { exec_events: feeds.execEvents?.status ?? null, heads: feeds.heads?.status ?? null, sse_clients: sse.clients }
});
api = createApi({ collector, analytics, sse, statusOf, reference, version: pkg.version, onError: (error, path) => log('error', `${path}: ${error.message}`) });

// --- real-time -----------------------------------------------------------------
let lastPush = 0, pushTimer = null, lastRollup = 0;
async function pushHeadline() {
  pushTimer = null; lastPush = Date.now();
  try {
    const p = await analytics.protocol(new URLSearchParams('window=24h'));
    sse.send('protocol', { meta: p.meta, headline: p.headline, current: p.current, markets: p.markets.map(x => ({ id: x.id, symbol: x.symbol, mark: x.mark ?? null, close: x.close, change_pct: x.change_pct, volume: x.volume, open_interest: x.open_interest ?? null, funding: x.funding ?? null })) });
  } catch (error) { log('warn', `headline push failed: ${error.message}`); }
}
ingest.on(event => {
  if (event.type === 'commit') {
    sse.send('block', { block: event.to.toString(), ts: event.ts, finalized: event.finalized?.toString() ?? null });
    const trades = event.ev.filter(r => r.role === 'taker' && ['open', 'increase', 'decrease', 'close', 'invert', 'liquidation'].includes(r.kind));
    if (trades.length) sse.send('trades', trades.slice(-100).map(r => analytics.tradeView({ ...r, ts: r.ts })));
    const liqs = event.ev.filter(r => r.kind === 'liquidation' || r.kind === 'deleverage');
    if (liqs.length) sse.send('liquidations', liqs.map(r => analytics.tradeView(r)));
    if (!pushTimer) pushTimer = setTimeout(pushHeadline, Math.max(0, 2000 - (Date.now() - lastPush)));
    const hour = Math.floor(event.ts / 3600);
    if (hour !== lastRollup) { lastRollup = hour; setTimeout(() => rollups.run(), 5000); }
  } else if (event.type === 'backfill') sse.send('backfill', event.progress);
});
if (config.monodeUrl) {
  feeds.execEvents = createExecEvents({ url: config.monodeUrl, exchange: config.exchange, log, onFinalized: n => ingest.notifyFinalized(n, 'exec-events'), onProposed: ({ block, ts, logs }) => { const rows = speculativeTrades(logs, ingest); if (rows.length) sse.send('proposed', { block, ts, trades: rows.map(r => analytics.tradeView(r)) }); } });
  feeds.execEvents.start();
} else if (config.wsUrl) {
  feeds.heads = createHeadSubscription({ url: config.wsUrl, log, onHead: () => ingest.notifyFinalized(undefined, 'ws-head') });
  feeds.heads.start();
}
const snapshots = createSnapshots({ ch, collector, log });
collector.on(() => snapshots.maybeRecord());

// --- serve -------------------------------------------------------------------
const port = Number(env.PORT || 8787), host = env.HOST || '0.0.0.0';
const server = createServer((req, res) => { api.handle(req, res).catch(error => { log('error', `request failed: ${error.message}`); if (!res.headersSent) { res.writeHead(500); res.end(); } }); });
server.listen(port, host, () => log('info', `perpl-scope ${pkg.version} listening on ${host}:${port} (chain ${config.chain})`));
reference?.start();
const running = [collector.start(), ingest.start()];
const rollupTimer = setInterval(() => rollups.run(), Number(env.ROLLUP_MS || 60000));
rollups.run();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return; stopping = true;
  log('info', `${signal} received; stopping`);
  clearInterval(rollupTimer);
  collector.stop(); ingest.stop(); reference?.stop(); feeds.execEvents?.stop(); feeds.heads?.stop(); sse.close();
  try { await collector.checkpoint(); } catch (error) { log('warn', `checkpoint failed: ${error.message}`); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
for (const p of running) p.catch(error => { log('error', `worker stopped: ${error.message}`); process.exitCode = 1; });
