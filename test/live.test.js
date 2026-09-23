import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecEvents, createSse } from '../src/live.js';
import { makeLog } from './helpers/logs.js';

const EXCHANGE = '0x34b6552d57a35a1d042ccae1951bd1c370112a6f';

test('execution events: logs are grouped per proposed block, re-ordered, and finalization is reported', () => {
  const proposed = [], finalized = [];
  const feed = createExecEvents({ url: 'ws://unused', exchange: EXCHANGE, onProposed: p => proposed.push(p), onFinalized: n => finalized.push(n), WebSocketImpl: null });
  const a = makeLog('CollateralDeposit', { accountId: 5n, amountCNS: 10n, balanceCNS: 10n }, { block: 7, tx: 1, logIndex: 0 });
  const b = makeLog('CollateralWithdrawal', { accountId: 5n, amountCNS: 3n, balanceCNS: 7n }, { block: 7, tx: 2, logIndex: 1 });
  const txLog = (log, txIndex) => ({ event_name: 'TxnLog', block_number: 7, txn_idx: txIndex, txn_hash: log.transactionHash, payload: { type: 'TxnLog', txn_index: txIndex, log_index: 0, address: EXCHANGE, topics: '0x' + log.topics.map(t => t.slice(2)).join(''), data: log.data } });
  feed.handleEvent({ event_name: 'BlockStart', block_number: 7, payload: { type: 'BlockStart', block_number: 7, block_id: '0x01', timestamp: 1790000007 } });
  feed.handleEvent(txLog(b, 2)); // arrives first: transactions interleave
  feed.handleEvent(txLog(a, 1));
  feed.handleEvent({ event_name: 'TxnLog', block_number: 7, txn_idx: 3, payload: { type: 'TxnLog', txn_index: 3, log_index: 0, address: '0x0000000000000000000000000000000000000001', topics: '0x', data: '0x' } });
  feed.handleEvent({ event_name: 'BlockEnd', block_number: 7, payload: { type: 'BlockEnd' } });
  assert.equal(proposed.length, 1);
  assert.deepEqual(proposed[0].logs.map(l => l.transactionIndex), [1, 2], 'restored to chain order, other contracts ignored');
  assert.equal(proposed[0].logs[0].topics[0], a.topics[0]);
  feed.handleEvent({ event_name: 'BlockFinalized', payload: { type: 'BlockFinalized', block_id: '0x01', block_number: 7 } });
  assert.deepEqual(finalized, [7]);
});

test('execution events: blocks that carried exchange logs report voted and finalized, timed from their start', () => {
  const stages = [];
  let t = 1000;
  const feed = createExecEvents({ url: 'ws://unused', exchange: EXCHANGE, onStage: s => stages.push(s), WebSocketImpl: null, now: () => t });
  const log = makeLog('CollateralDeposit', { accountId: 5n, amountCNS: 10n, balanceCNS: 10n }, { block: 8, tx: 1, logIndex: 0 });
  const start = (n, id) => feed.handleEvent({ event_name: 'BlockStart', block_number: n, payload: { type: 'BlockStart', block_number: n, block_id: id, timestamp: 1790000008 } });
  start(8, '0xAA');
  feed.handleEvent({ event_name: 'TxnLog', block_number: 8, txn_idx: 1, payload: { type: 'TxnLog', txn_index: 1, log_index: 0, address: EXCHANGE, topics: '0x' + log.topics.map(x => x.slice(2)).join(''), data: log.data } });
  feed.handleEvent({ event_name: 'BlockEnd', block_number: 8, payload: { type: 'BlockEnd' } });
  start(9, '0xbb'); // no exchange logs: no stages reported
  feed.handleEvent({ event_name: 'BlockEnd', block_number: 9, payload: { type: 'BlockEnd' } });
  t = 1420; feed.handleEvent({ event_name: 'BlockQC', payload: { type: 'BlockQC', block_id: '0xaa', block_number: 8, round: 1 } });
  feed.handleEvent({ event_name: 'BlockQC', payload: { type: 'BlockQC', block_id: '0xaa', block_number: 8, round: 1 } }); // repeated: once
  feed.handleEvent({ event_name: 'BlockQC', payload: { type: 'BlockQC', block_id: '0xbb', block_number: 9, round: 2 } });
  t = 1810; feed.handleEvent({ event_name: 'BlockFinalized', payload: { type: 'BlockFinalized', block_id: '0xaa', block_number: 8 } });
  feed.handleEvent({ event_name: 'BlockFinalized', payload: { type: 'BlockFinalized', block_id: '0xbb', block_number: 9 } });
  assert.deepEqual(stages.map(s => [s.block, s.stage, s.ms]), [[8, 'voted', 420], [8, 'finalized', 810]]);
});

test('server-sent events reach every open client in order', () => {
  const sse = createSse({ heartbeatMs: 60000 });
  const writes = [];
  const res = { writeHead() {}, write: text => writes.push(text), end() {} };
  const req = { on() {} };
  sse.open(req, res);
  sse.send('block', { block: 10n });
  sse.send('trades', [{ price: '1.0' }]);
  assert.equal(sse.clients, 1);
  assert.match(writes.at(-2), /^id: 1\nevent: block\ndata: \{"block":"10"\}\n\n$/);
  assert.match(writes.at(-1), /event: trades/);
  sse.close();
});
