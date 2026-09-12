import { readFile, writeFile } from 'node:fs/promises';
import { decodeEventLog } from 'viem';
import { configuration, rpcClient } from './gate.js';
import { sizeState, applySizeEvent, canonicalSizes } from './replay-core.js';
const before = JSON.parse(await readFile('reports/replay-start.json', 'utf8'));
const after = JSON.parse(await readFile('reports/snapshot.json', 'utf8'));
const abi = JSON.parse(await readFile(new URL('../abi/exchange-events.json', import.meta.url), 'utf8'));
const config = configuration(process.env), rpc = rpcClient(config.url);
const report = { status: 'BLOCKED', scope: 'Position size and side only; no margin, funding, deposits, prices or full exchange replay.', from_block: before.block_number, to_block: after.block_number, events: {}, logs: 0 };
try {
  if ([before, after].some(x => x.position_snapshot_result !== 'PASS' || x.chain_id !== config.chain || x.exchange_address.toLowerCase() !== config.exchange.toLowerCase())) throw new Error('INVALID_SNAPSHOT');
  if (BigInt(await rpc('eth_chainId', [])) !== BigInt(config.chain)) throw new Error('CHAIN_MISMATCH');
  const start = BigInt(before.block_number) + 1n, end = BigInt(after.block_number);
  if (end < start || end - start > 2000n) throw new Error('REPLAY_RANGE_INVALID');
  for (const snapshot of [before, after]) if ((await rpc('eth_getBlockByNumber', ['0x' + BigInt(snapshot.block_number).toString(16), false]))?.hash !== snapshot.block_hash) throw new Error('HASH_CHANGED');
  const state = sizeState(before), seen = new Set();
  for (let first = start; first <= end; first += 10n) {
    const last = first + 9n > end ? end : first + 9n;
    const logs = await rpc('eth_getLogs', [{ address: config.exchange, fromBlock: '0x' + first.toString(16), toBlock: '0x' + last.toString(16) }]);
    logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.transactionIndex) - BigInt(b.transactionIndex)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    for (const log of logs) {
      if (log.removed || BigInt(log.blockNumber) < first || BigInt(log.blockNumber) > last) throw new Error('INVALID_LOG');
      const key = `${config.chain}:${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key); report.logs++;
      const event = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
      report.last_event = { name: event.eventName, block: log.blockNumber };
      if (applySizeEvent(state, event.eventName, event.args)) report.events[event.eventName] = (report.events[event.eventName] || 0) + 1;
    }
  }
  const expected = sizeState(after);
  if (canonicalSizes(state) !== canonicalSizes(expected)) {
    report.differences = [...new Set([...state.keys(), ...expected.keys()])].filter(key => canonicalSizes(new Map([[key, state.get(key)]])) !== canonicalSizes(new Map([[key, expected.get(key)]])))
      .slice(0, 20).map(key => ({ key, actual: state.get(key), expected: expected.get(key) }));
    throw new Error('REPLAY_MISMATCH');
  }
  if ((await rpc('eth_getBlockByNumber', ['0x' + end.toString(16), false]))?.hash !== after.block_hash) throw new Error('HASH_CHANGED');
  report.size_replay_result = 'PASS';
} catch (error) {
  const codes = ['UNSUPPORTED_SIZE_EVENT', 'REPLAY_MISMATCH', 'START_SIZE_MISMATCH', 'POSITION_PRECONDITION_FAILED', 'HASH_CHANGED', 'REPLAY_RANGE_INVALID', 'RPC_UNAVAILABLE_OR_INVALID'];
  report.error = codes.includes(error.message) ? error.message : 'REPLAY_VALIDATION_FAILED';
}
const json = JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
await writeFile('reports/replay.json', json);
console.log(json);
