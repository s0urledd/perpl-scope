import { mkdir, writeFile } from 'node:fs/promises';
import { configuration, rpcClient } from './gate.js';
import { connectRpc } from './ws-rpc.js';
const config = configuration(process.env), http = rpcClient(config.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { status: 'BLOCKED', state_history: ['syncing'], scope: 'Transport disconnect and bounded log backfill; no position event application.' };
let connection;
try {
  connection = await connectRpc(process.env.MONAD_WSS_URL);
  if (BigInt(await connection.request('eth_chainId')) !== BigInt(config.chain)) throw new Error('CHAIN_MISMATCH');
  const before = await connection.request('eth_getBlockByNumber', ['finalized', false]);
  report.before = { number: before.number, hash: before.hash };
  await connection.request('eth_subscribe', ['logs', { address: config.exchange }]);
  connection.close(); report.state_history.push('stale');
  await sleep(3000);
  connection = await connectRpc(process.env.MONAD_WSS_URL);
  if (BigInt(await connection.request('eth_chainId')) !== BigInt(config.chain)) throw new Error('CHAIN_MISMATCH');
  report.state_history.push('syncing');
  const after = await connection.request('eth_getBlockByNumber', ['finalized', false]);
  const start = BigInt(before.number) + 1n, end = BigInt(after.number);
  if (end < start || end - start >= 100n) throw new Error('BACKFILL_RANGE_INVALID');
  const filter = { address: config.exchange, fromBlock: '0x' + start.toString(16), toBlock: after.number };
  const logs = await http('eth_getLogs', [filter]);
  const wsLogs = await connection.request('eth_getLogs', [filter]);
  const identity = x => [x.blockHash, x.transactionHash, x.logIndex, x.address, x.data, ...x.topics].join(':');
  const normalize = xs => xs.map(identity).sort();
  if (logs.some(x => x.removed) || JSON.stringify(normalize(logs)) !== JSON.stringify(normalize(wsLogs))) throw new Error('LOG_MISMATCH');
  for (const b of [before, after]) if ((await http('eth_getBlockByNumber', [b.number, false]))?.hash !== b.hash) throw new Error('BLOCK_HASH_CHANGED');
  report.after = { number: after.number, hash: after.hash };
  report.blocks_backfilled = (end - start + 1n).toString(); report.logs_backfilled = logs.length;
  report.transport_result = 'PASS';
  report.note = 'HTTP and WSS historical logs matched. Analytics freshness remains syncing until state replay reconciliation.';
} catch { report.error = 'RECONNECT_OR_BACKFILL_FAILED'; }
finally { connection?.close(); }
await mkdir('reports', { recursive: true });
await writeFile('reports/reconnect-probe.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
