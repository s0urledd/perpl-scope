import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, rpcClient, classify, DEFAULT_DEPLOY_BLOCK } from '../src/rpc.js';

test('configuration validates URLs and reads archive endpoints', () => {
  assert.throws(() => configuration({}), /MISSING_RPC/);
  assert.throws(() => configuration({ MONAD_RPC_URL: 'file:///a' }), /INVALID_RPC_URL_PROTOCOL/);
  assert.throws(() => configuration({ MONAD_RPC_URL: 'https://a.invalid', CHAIN_ID: '-1' }), /INVALID_CHAIN/);
  assert.throws(() => configuration({ MONAD_RPC_URL: 'https://a.invalid', EXCHANGE_ADDRESS: 'bad' }), /INVALID_EXCHANGE/);
  const c = configuration({ MONAD_RPC_URL: 'https://a.invalid', ARCHIVE_RPC_URLS: ' https://b.invalid , https://c.invalid ' });
  assert.deepEqual(c.archives, ['https://b.invalid/', 'https://c.invalid/']);
  assert.equal(c.deployBlock, DEFAULT_DEPLOY_BLOCK);
});

test('provider errors are classified without leaking their text', async () => {
  assert.equal(classify({ error: { message: 'block range too large' } }), 'limit');
  assert.equal(classify({ error: { message: 'eth_getLogs is limited to a 100 range' } }), 'limit');
  assert.equal(classify({ error: { message: 'Log response size exceeded' } }), 'limit');
  assert.equal(classify({ error: { message: 'error getting block header from triedb and archive' } }), 'pruned');
  assert.equal(classify({ status: 429 }), 'rate');
  const rpc = rpcClient('https://secret.invalid/token', async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'block range too large at https://secret.invalid/token' } })));
  await assert.rejects(rpc('eth_getLogs', []), error => error.message === 'RPC_UNAVAILABLE_OR_INVALID' && error.kind === 'limit');
  const thrown = rpcClient('https://secret.invalid/token', async () => { throw new Error('secret token'); });
  await assert.rejects(thrown('eth_chainId', []), { message: 'RPC_UNAVAILABLE_OR_INVALID' });
  const mismatched = rpcClient('https://a.invalid', async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 9, result: '0x8f' })));
  await assert.rejects(mismatched('eth_chainId', []), /RPC_UNAVAILABLE_OR_INVALID/);
  const big = rpcClient('https://a.invalid', async () => new Response('x'.repeat(64)), { maxBytes: 16 });
  await assert.rejects(big('eth_chainId', []), error => error.kind === 'limit');
});
