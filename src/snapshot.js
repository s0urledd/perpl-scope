import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
import { configuration, rpcClient, preflight } from './gate.js';
import { bitmapIds, accountMarkets, reconcile } from './snapshot-core.js';
const abi = JSON.parse(await readFile(new URL('../abi/exchange-read.json', import.meta.url), 'utf8'));
const multiAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const config = configuration(process.env);
const rawRpc = rpcClient(config.url);
let requests = 0;
const start = performance.now(), cpuStart = process.cpuUsage();
let peakRss = process.memoryUsage().rss;
const rpc = async (...args) => {
  if (requests >= 4000 || performance.now() - start > 600000) throw new Error('SCAN_BUDGET_EXCEEDED');
  requests++; peakRss = Math.max(peakRss, process.memoryUsage().rss); return rawRpc(...args);
};
const multi = '0xca11bde05977b3631167028862be2a173976ca11';
const stringify = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
let report = { status: 'BLOCKED', coverage: 'unknown' };
try {
  report = await preflight(config, rpc);
  if (report.status === 'FAIL') throw new Error('PREFLIGHT_FAILED');
  const block = '0x' + BigInt(report.block_number).toString(16);
  const call = async (name, args = []) => decodeFunctionResult({ abi, functionName: name,
    data: await rpc('eth_call', [{ to: config.exchange, data: encodeFunctionData({ abi, functionName: name, args }) }, block]) });
  const ids = bitmapIds(await call('getPerpetualExistsBitmap'));
  const count = await call('numberOfAccounts');
  if (count > 10000n || ids.length > 20) throw new Error('SCAN_BUDGET_EXCEEDED');
  if (await rpc('eth_getCode', [multi, block]) === '0x') throw new Error('MULTICALL_UNAVAILABLE');
  report.account_count = count; report.discovered_markets = ids; report.markets = [];
  const candidates = new Map(ids.map(id => [id, []]));
  report.discovery_method = 'All account position bitmaps, then open-position getters; SDK 0.2.5 bitmap layout.';
  for (let first = 1n; first <= count; first += 50n) {
    const accounts = Array.from({ length: Number(count - first + 1n > 50n ? 50n : count - first + 1n) }, (_, i) => first + BigInt(i));
    const data = encodeFunctionData({ abi: multiAbi, functionName: 'aggregate3', args: [accounts.map(account => ({ target: config.exchange, allowFailure: false,
      callData: encodeFunctionData({ abi, functionName: 'getAccountById', args: [account] }) }))] });
    const raw = await rpc('eth_call', [{ to: multi, data }, block]);
    const results = decodeFunctionResult({ abi: multiAbi, functionName: 'aggregate3', data: raw });
    if (results.length !== accounts.length) throw new Error('INCOMPLETE_ACCOUNT_BATCH');
    for (let i = 0; i < results.length; i++) {
      if (!results[i].success) throw new Error('ACCOUNT_CALL_FAILED');
      const account = decodeFunctionResult({ abi, functionName: 'getAccountById', data: results[i].returnData });
      if (account.accountId !== accounts[i]) throw new Error('ACCOUNT_MISMATCH');
      for (const market of accountMarkets(account.positions)) {
        if (!candidates.has(market)) throw new Error('UNDISCOVERED_MARKET');
        candidates.get(market).push(accounts[i]);
      }
    }
  }
  console.log(stringify({ accounts_discovered: count, requests }));
  for (const id of ids) {
    report.active_market = id;
    const info = await call('getPerpetualInfo', [BigInt(id)]);
    const positions = [];
    async function readBatch(accounts) {
      const data = encodeFunctionData({ abi: multiAbi, functionName: 'aggregate3', args: [accounts.map(account => ({ target: config.exchange, allowFailure: false,
        callData: encodeFunctionData({ abi, functionName: 'getPositionV2', args: [BigInt(id), account] }) }))] });
      let raw;
      try { raw = await rpc('eth_call', [{ to: multi, data }, block]); }
      catch (error) {
        if (error.message !== 'RPC_UNAVAILABLE_OR_INVALID' || accounts.length <= 1) throw error;
        report.batch_splits = (report.batch_splits || 0) + 1;
        const middle = Math.floor(accounts.length / 2);
        await readBatch(accounts.slice(0, middle));
        await readBatch(accounts.slice(middle));
        return;
      }
      const results = decodeFunctionResult({ abi: multiAbi, functionName: 'aggregate3', data: raw });
      if (results.length !== accounts.length) throw new Error('INCOMPLETE_BATCH');
      for (let i = 0; i < results.length; i++) {
        if (!results[i].success) throw new Error('POSITION_CALL_FAILED');
        const [p] = decodeFunctionResult({ abi, functionName: 'getPositionV2', data: results[i].returnData });
        if (p.lotLNS !== 0n && p.accountId !== accounts[i]) throw new Error('ACCOUNT_MISMATCH');
        if (p.lotLNS !== 0n) positions.push(p);
      }
      if (performance.now() - start > 600000) throw new Error('TIME_BUDGET_EXCEEDED');
    }
    const active = candidates.get(id);
    for (let first = 0; first < active.length; first += 50) {
      await readBatch(active.slice(first, first + 50));
    }
    const oi = reconcile(positions, info.longOpenInterestLNS, info.shortOpenInterestLNS);
    report.markets.push({ id, symbol: info.symbol, lot_decimals: info.lotDecimals, positions, oi });
    console.log(stringify({ market: id, positions: positions.length, oi, requests }));
    if (!oi.matches) throw new Error('OI_MISMATCH');
  }
  if ((await rpc('eth_getBlockByNumber', [block, false]))?.hash !== report.block_hash) throw new Error('CANONICAL_HASH_CHANGED');
  report.coverage = 'complete';
  report.coverage_scope = 'Account-bitmap-discovered open positions across IDs 1..numberOfAccounts, reconciled against all market OI totals. Order books and full exchange state excluded.';
  report.position_snapshot_result = 'PASS';
  report.remaining = ['Full exchange SDK snapshot', 'Independent position reference', 'Event replay', 'Disconnect recovery'];
} catch (error) {
  report.status = 'BLOCKED'; report.coverage = 'unknown';
  report.error = error.message === 'RPC_UNAVAILABLE_OR_INVALID' ? error.message : 'SNAPSHOT_VALIDATION_FAILED';
  console.error(report.error);
}
report.measurements = { requests, elapsed_ms: Math.round(performance.now() - start), sampled_peak_rss_bytes: peakRss, cpu_microseconds: process.cpuUsage(cpuStart) };
await mkdir('reports', { recursive: true });
await writeFile('reports/snapshot.tmp', stringify(report));
await rename('reports/snapshot.tmp', 'reports/snapshot.json');
console.log(stringify({ status: report.status, coverage: report.coverage, position_snapshot_result: report.position_snapshot_result, measurements: report.measurements }));
process.exitCode = report.position_snapshot_result === 'PASS' ? 0 : 2;
