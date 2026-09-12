import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, preflight, rpcClient } from '../src/gate.js';
const config = configuration({ MONAD_RPC_URL: 'https://example.invalid' });
const block = { number: '0x10', hash: '0x' + 'ab'.repeat(32) };
function fixture(values) { return async () => values.shift(); }
test('missing RPC and malformed configuration are rejected', () => {
  assert.throws(() => configuration({}), /MISSING_RPC/);
  assert.throws(() => configuration({ MONAD_RPC_URL: 'file:///a' }), /INVALID_RPC_PROTOCOL/);
  assert.throws(() => configuration({ MONAD_RPC_URL: config.url, CHAIN_ID: '-1' }), /INVALID_CHAIN/);
  assert.throws(() => configuration({ MONAD_RPC_URL: config.url, EXCHANGE_ADDRESS: 'bad' }), /INVALID_EXCHANGE/);
});
test('wrong chain fails before state reads', async () => {
  assert.equal((await preflight(config, fixture(['0x1']))).reason, 'CHAIN_MISMATCH');
});
test('empty deployment fails', async () => {
  assert.equal((await preflight(config, fixture(['0x8f', block, '0x']))).status, 'FAIL');
});
test('canonical hash change fails', async () => {
  assert.equal((await preflight(config, fixture(['0x8f', block, '0x6000', { ...block, hash: 'changed' }]))).reason, 'BLOCK_HASH_CHANGED');
});
test('successful preflight remains blocked and pins reads', async () => {
  const calls = []; const values = ['0x8f', block, '0x6000', block];
  const report = await preflight(config, async (...args) => { calls.push(args); return values.shift(); });
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.coverage, 'unknown');
  assert.equal(calls[2][1][1], '0x10');
  assert.equal(calls[3][1][0], '0x10');
});
test('RPC errors redact provider credentials', async () => {
  const rpc = rpcClient('https://secret.invalid/token', async () => { throw new Error('secret token'); });
  await assert.rejects(rpc('eth_chainId', []), { message: 'RPC_UNAVAILABLE_OR_INVALID' });
});
test('RPC rejects mismatched response ID and HTTP errors', async () => {
  for (const response of [new Response('{}', { status: 429 }), new Response(JSON.stringify({ jsonrpc: '2.0', id: 9, result: '0x8f' }))]) {
    await assert.rejects(rpcClient(config.url, async () => response)('eth_chainId', []), /RPC_UNAVAILABLE_OR_INVALID/);
  }
});
