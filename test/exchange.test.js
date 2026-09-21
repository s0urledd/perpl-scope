import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, parseAbi, encodeAbiParameters } from 'viem';
import { createReader, MULTICALL3 } from '../src/exchange.js';
import { readAbi } from '../src/abi.js';

const exchange = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F';
const multiAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const position = (accountId, next, lot = 10n) => ({ accountId, nextNodeId: next, prevNodeId: 0n, positionType: 0, depositCNS: 1000000n, pricePNS: 100n, lotLNS: lot, entryBlock: 1n, pnlCNS: 0n, deltaPnlCNS: 0n, premiumPnlCNS: 0n, priceResiduePNSQ16: 0n });

// A tiny fake contract: implements the getters the reader uses.
function fakeContract({ failBatchesAbove = Infinity } = {}) {
  const chain = [position(6n, 88n), position(88n, 586n), position(586n, 0n, 5n)];
  function dispatch(name, args) {
    switch (name) {
      case 'getPositionsV2': {
        const [, start, perPage] = args;
        const index = start === 0n ? 0 : chain.findIndex(p => p.accountId === start);
        const page = chain.slice(index, index + Number(perPage));
        const padded = [...page, ...Array.from({ length: Number(perPage) - page.length }, () => position(0n, 0n, 0n))];
        return [padded, BigInt(page.length), 12345n, true];
      }
      case 'getPositionV2': return [chain.find(p => p.accountId === args[1]) ?? position(0n, 0n, 0n), 12345n, true];
      case 'getExchangeInfo': return [1n, 2n, 3n, 6n, '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', '0x0000000000000000000000000000000000000001'];
      case 'numberOfAccounts': return 5311n;
      case 'getFundingInterval': return 8571n;
      case 'getContractVersion': return [1n, 7n, 4n];
      case 'isHalted': return false;
      case 'getPerpetualExistsBitmap': return [(1n << 1n) | (1n << 10n), 0n, 0n, 0n];
      case 'getMarginFractions': return [1500n, 2500n, 1500n, 30000000n, 90n, 95n];
      default: throw new Error('UNSUPPORTED:' + name);
    }
  }
  return async (method, params) => {
    if (method !== 'eth_call') throw new Error('UNSUPPORTED_METHOD');
    const { to, data } = params[0];
    if (to.toLowerCase() === MULTICALL3) {
      const { args: [calls] } = decodeFunctionData({ abi: multiAbi, data });
      if (calls.length > failBatchesAbove) throw new Error('RPC_UNAVAILABLE_OR_INVALID');
      const results = calls.map(c => {
        const { functionName, args } = decodeFunctionData({ abi: readAbi, data: c.callData });
        return { success: true, returnData: encodeFunctionResult({ abi: readAbi, functionName, result: dispatch(functionName, args) }) };
      });
      return encodeFunctionResult({ abi: multiAbi, functionName: 'aggregate3', result: results });
    }
    const { functionName, args } = decodeFunctionData({ abi: readAbi, data });
    return encodeFunctionResult({ abi: readAbi, functionName, result: dispatch(functionName, args) });
  };
}

test('paged position reads honour numPositions and nextNodeId', async () => {
  const reader = createReader({ rpc: fakeContract(), exchange, pageSize: 2 });
  const { positions, markPNS, markValid } = await reader.readAllPositions(1, 5n);
  assert.deepEqual(positions.map(p => p.accountId), [6n, 88n, 586n]);
  assert.equal(markPNS, 12345n);
  assert.equal(markValid, true);
  assert.equal(reader.stats.requests, 2);
});

test('multicall batches split adaptively on provider failure', async () => {
  const reader = createReader({ rpc: fakeContract({ failBatchesAbove: 1 }), exchange, batchSize: 4 });
  const results = await reader.readPositions([{ perpId: 1, accountId: 6n }, { perpId: 1, accountId: 88n }, { perpId: 1, accountId: 586n }], 5n);
  assert.deepEqual(results.map(r => r.position.lotLNS), [10n, 10n, 5n]);
  assert.equal(reader.stats.splits, 2);
});

test('exchange summary and market ids decode', async () => {
  const reader = createReader({ rpc: fakeContract(), exchange });
  const info = await reader.readExchange(5n);
  assert.equal(info.collateralDecimals, 6);
  assert.equal(info.version, '1.7.4');
  assert.equal(info.fundingInterval, 8571n);
  assert.equal(info.numberOfAccounts, 5311n);
  assert.deepEqual(await reader.readMarketIds(5n), [1, 10]);
});

test('block and log validation reject malformed provider data', async () => {
  const reader = createReader({ rpc: async method => method === 'eth_getBlockByNumber' ? { number: '0x10', hash: 'nope' } : [{ removed: true }], exchange });
  await assert.rejects(reader.getBlock(16n), /INVALID_BLOCK/);
  await assert.rejects(reader.getLogs({ fromBlock: 1n, toBlock: 2n }), /INVALID_LOG/);
  assert.throws(() => createReader({ rpc: async () => null, exchange: '0x12' }), /INVALID_EXCHANGE/);
});
